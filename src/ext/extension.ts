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
      if (RESCAN_SETTINGS.some((key) => event.affectsConfiguration(key))) {
        updateContexts();
        void refreshWithProgress(provider);
      } else if (REBUILD_SETTINGS.some((key) => event.affectsConfiguration(key))) {
        updateContexts();
        provider.rebuild();
      } else if (event.affectsConfiguration('repodock.openInNewWindow')) {
        // read live from settings on each open; nothing to rebuild
      }
    }),
  );

  // git state goes stale while the window is unfocused (commits from a terminal,
  // another VS Code window…) — reload it whenever the user comes back
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused) void provider.refreshGitStates();
    }),
    view.onDidChangeVisibility((event) => {
      if (event.visible) void provider.refreshGitStates();
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

async function refreshWithProgress(provider: RepoTreeProvider): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'repodock.scanning', true);
  try {
    await provider.refresh();
  } finally {
    await vscode.commands.executeCommand('setContext', 'repodock.scanning', false);
  }
}
