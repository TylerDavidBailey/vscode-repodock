import * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';
import type { RepoInfo } from '../core/types';
import { registerCommands } from './commands';
import { PinStore } from './pins';
import { RecencyStore } from './recency';
import { getConfig } from './settings';
import { CurrentRepoDecorationProvider, RepoTreeProvider, type TreeNode } from './treeProvider';

/** Exposed for integration tests. */
export interface RepoDockApi {
  refresh(): Promise<void>;
  getRepos(): RepoInfo[];
  provider: RepoTreeProvider;
}

// change which repos exist, so the file system has to be walked again
const RESCAN_SETTINGS = [
  'repodock.directories',
  'repodock.maxDepth',
  'repodock.exclude',
  'repodock.hiddenRepos',
];
// only change how already-scanned repos are presented, so a rebuild suffices
const REBUILD_SETTINGS = [
  'repodock.sortOrder',
  'repodock.showNestedRepos',
  'repodock.groupByFolder',
];
// `repodock.openInNewWindow` is in neither list: it is read live on each open, so a
// change to it needs no reaction here.

/**
 * Builds the tree view and its stores, registers commands and listeners, then kicks off the
 * first scan without awaiting it so activation stays fast. The returned API is for tests;
 * its `refresh` chains off that first scan so a test never races it.
 */
export function activate(context: vscode.ExtensionContext): RepoDockApi {
  const recency = new RecencyStore(context.globalState);
  const pins = new PinStore(context.globalState);
  const provider = new RepoTreeProvider(recency, pins);

  const view = vscode.window.createTreeView<TreeNode>('repodock.repos', {
    treeDataProvider: provider,
  });
  context.subscriptions.push(view);
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new CurrentRepoDecorationProvider()),
  );

  registerCommands(context, {
    provider,
    recency,
    pins,
    refresh: () => refreshWithProgress(provider),
  });

  const updateContexts = () => {
    const config = getConfig();
    void vscode.commands.executeCommand(
      'setContext',
      'repodock.noDirectories',
      config.directories.length === 0,
    );
    void vscode.commands.executeCommand('setContext', 'repodock.sortOrder', config.sortOrder);
    // the group-by-folder toggle only makes sense with more than one folder configured
    void vscode.commands.executeCommand(
      'setContext',
      'repodock.multipleFolders',
      config.directories.length > 1,
    );
    void vscode.commands.executeCommand(
      'setContext',
      'repodock.groupByFolder',
      config.groupByFolder,
    );
  };
  updateContexts();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Both lists have to be tested, never chained with `else`: one settings save fires
      // one event and `affectsConfiguration` answers for every key it changed. Chaining
      // would drop the rebuild for a save touching both, because `refresh` skips
      // rebuilding when the repo list came back unchanged.
      const shouldRescan = RESCAN_SETTINGS.some((key) => event.affectsConfiguration(key));
      const shouldRebuild = REBUILD_SETTINGS.some((key) => event.affectsConfiguration(key));
      if (!shouldRescan && !shouldRebuild) return;
      updateContexts();
      if (shouldRebuild) provider.rebuild();
      if (shouldRescan) void refreshWithProgress(provider);
    }),
  );

  // git state and the repo list go stale while the window is unfocused (commits or fresh
  // clones from a terminal), so refresh whenever the user comes back — deliberately not
  // via refreshWithProgress, since the user didn't ask for these
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused) void provider.refreshIfStale();
    }),
    view.onDidChangeVisibility((event) => {
      if (event.visible) void provider.refreshIfStale();
    }),
  );

  const workspacePaths = () =>
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  provider.setCurrentRepos(workspacePaths());
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.setCurrentRepos(workspacePaths());
      provider.rebuild();
    }),
  );

  const findRepoForPath = (p: string): RepoInfo | undefined => {
    const key = canonicalPathKey(p);
    return provider.getRepos().find((repo) => canonicalPathKey(repo.path) === key);
  };

  const revealCurrent = async () => {
    const current = workspacePaths()
      .map(findRepoForPath)
      .find((repo) => repo !== undefined);
    if (!current) return;
    const element = provider.findRepoElement(current.path);
    if (!element) return;
    try {
      await view.reveal(element, { select: true, focus: false });
    } catch {
      // reveal is best-effort; the highlight still marks the current repo
    }
  };

  const initialScan = refreshWithProgress(provider).then(async () => {
    // record the workspace we're sitting in so "recent" ordering knows about it
    const currentPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const currentRepo = currentPath === undefined ? undefined : findRepoForPath(currentPath);
    if (currentRepo) {
      // touch the scanned path, not the workspace's, so recency keys stay consistent
      await recency.touch(currentRepo.path);
    }
    if (view.visible) {
      await revealCurrent();
    } else {
      const once = view.onDidChangeVisibility(async (event) => {
        if (event.visible) {
          once.dispose();
          await revealCurrent();
        }
      });
      context.subscriptions.push(once);
    }
  });

  return {
    refresh: () => initialScan.then(() => refreshWithProgress(provider)),
    getRepos: () => provider.getRepos(),
    provider,
  };
}

/**
 * Refreshes with the `repodock.scanning` context set, which swaps the welcome view for a
 * progress message. Only for refreshes the user asked for: on an automatic one the toggle
 * would flicker the welcome view for users with no repos.
 */
async function refreshWithProgress(provider: RepoTreeProvider): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'repodock.scanning', true);
  try {
    await provider.refresh();
  } finally {
    await vscode.commands.executeCommand('setContext', 'repodock.scanning', false);
  }
}
