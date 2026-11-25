import * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';
import type { RepoInfo } from '../core/types';
import { registerCommands } from './commands';
import { ExpansionStore } from './expansion';
import { PinStore } from './pins';
import { RecencyStore } from './recency';
import { RepoModel } from './repoModel';
import { getConfig } from './settings';
import { RepoDecorationProvider, RepoTreeProvider, type TreeNode } from './treeProvider';

/** The id the view is contributed under in `package.json`. */
export const VIEW_ID = 'repodock.repos';

/** Exposed for integration tests. */
export interface RepoDockApi {
  refresh(): Promise<void>;
  getRepos(): RepoInfo[];
  model: RepoModel;
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
const REBUILD_SETTINGS = ['repodock.showNestedRepos', 'repodock.recentCount'];
// `repodock.openInNewWindow` is in neither list: it is read live on each open, so a
// change to it needs no reaction here.

/**
 * Builds the view and its stores, registers commands and listeners, then kicks off the
 * first scan without awaiting it so activation stays fast. The returned API is for tests;
 * its `refresh` chains off that first scan so a test never races it.
 */
export function activate(context: vscode.ExtensionContext): RepoDockApi {
  const recency = new RecencyStore(context.globalState);
  const pins = new PinStore(context.globalState);
  const expansion = new ExpansionStore(context.globalState);
  const model = new RepoModel();
  const provider = new RepoTreeProvider(model, recency, pins, expansion);
  const view = vscode.window.createTreeView<TreeNode>(VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(
    model,
    provider,
    view,
    // remembered so a section or folder the user folded stays folded in the next window
    view.onDidCollapseElement((event) => expansion.set(provider.idOf(event.element), false)),
    view.onDidExpandElement((event) => expansion.set(provider.idOf(event.element), true)),
  );
  const rebuildViews = () => {
    provider.rebuild();
  };

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new RepoDecorationProvider()),
  );

  registerCommands(context, {
    model,
    recency,
    pins,
    refresh: () => refreshWithProgress(model),
    rebuildViews,
  });

  const updateContexts = () => {
    void vscode.commands.executeCommand(
      'setContext',
      'repodock.noDirectories',
      getConfig().directories.length === 0,
    );
  };
  updateContexts();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      // Both lists have to be tested, never chained with `else`: one settings save fires
      // one event and `affectsConfiguration` answers for every key it changed. Chaining
      // would drop the rebuild for a save touching both, because a rescan skips
      // re-rendering when the repo list came back unchanged.
      const shouldRescan = RESCAN_SETTINGS.some((key) => event.affectsConfiguration(key));
      const shouldRebuild = REBUILD_SETTINGS.some((key) => event.affectsConfiguration(key));
      if (!shouldRescan && !shouldRebuild) return;
      updateContexts();
      if (shouldRebuild) rebuildViews();
      if (shouldRescan) void refreshWithProgress(model);
    }),
  );

  // git state and the repo list go stale while the window is unfocused (commits or fresh
  // clones from a terminal), so refresh whenever the user comes back — deliberately not
  // via refreshWithProgress, since the user didn't ask for these
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((event) => {
      if (event.focused) void model.refreshIfStale();
    }),
    view.onDidChangeVisibility((event) => {
      if (event.visible) void model.refreshIfStale();
    }),
  );

  const workspacePaths = () =>
    (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  model.setCurrentRepos(workspacePaths());
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      model.setCurrentRepos(workspacePaths());
      rebuildViews();
    }),
  );

  const findRepoForPath = (p: string): RepoInfo | undefined => {
    const key = canonicalPathKey(p);
    return model.getRepos().find((repo) => canonicalPathKey(repo.path) === key);
  };

  // Nothing is revealed or selected for the current repo. It is colored wherever it
  // appears and heads the Recent section, so it is on screen without scrolling. Revealing
  // its All Repositories row instead would scroll Pinned and Recent out of view, and would
  // reopen sections the user had collapsed.
  const initialScan = refreshWithProgress(model).then(async () => {
    // record the workspace we're sitting in so Recent knows about it
    const currentPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const currentRepo = currentPath === undefined ? undefined : findRepoForPath(currentPath);
    if (currentRepo) {
      // touch the scanned path, not the workspace's, so recency keys stay consistent
      await recency.touch(currentRepo.path);
      // the scan already rendered without it, and nothing else re-renders the view
      rebuildViews();
    }
  });

  return {
    refresh: () => initialScan.then(() => refreshWithProgress(model)),
    getRepos: () => model.getRepos(),
    model,
    provider,
  };
}

/**
 * Refreshes with the `repodock.scanning` context set, which swaps the welcome view for a
 * progress message. Only for refreshes the user asked for: on an automatic one the toggle
 * would flicker the welcome view for users with no repos.
 */
async function refreshWithProgress(model: RepoModel): Promise<void> {
  // not awaited: the scan has to start before this function yields, so a focus or
  // visibility event arriving meanwhile joins it instead of starting a second one.
  // VS Code runs commands in call order, so the clear below still lands after this.
  void vscode.commands.executeCommand('setContext', 'repodock.scanning', true);
  try {
    await model.refresh();
  } finally {
    await vscode.commands.executeCommand('setContext', 'repodock.scanning', false);
  }
}
