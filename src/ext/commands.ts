import * as vscode from 'vscode';
import { canonicalPathKey, isMissingDirectory } from '../core/paths';
import type { RepoInfo } from '../core/types';
import { promptAddFolders, showFolderManager } from './folderPicker';
import type { PinStore } from './pins';
import type { RecencyStore } from './recency';
import type { RepoModel } from './repoModel';
import {
  expandPath,
  getConfig,
  hideRepo,
  type Layout,
  removeDirectory,
  setLayout,
  tildify,
  unhideAllRepos,
} from './settings';
import type { TreeNode } from './treeProvider';

interface CommandDeps {
  model: RepoModel;
  recency: RecencyStore;
  pins: PinStore;
  /** Rescan wrapped in the scanning context so the welcome view doesn't flash mid-scan. */
  refresh: () => Promise<void>;
  /** Re-renders every view from the repos already scanned, after a pin or an open. */
  rebuildViews: () => void;
}

function repoOf(element: TreeNode | undefined): RepoInfo | undefined {
  return element?.kind === 'repo' ? element.repo : undefined;
}

const RELOAD_WINDOW = 'Reload Window';

/**
 * Switches layout, or, in a window updated without a reload that cannot store the setting
 * yet, offers the reload instead of the editor's "not a registered configuration" error.
 */
async function switchLayout(layout: Layout): Promise<void> {
  if (await setLayout(layout)) return;
  const choice = await vscode.window.showWarningMessage(
    'RepoDock was updated. Reload the window to finish the update, then switch layouts.',
    RELOAD_WINDOW,
  );
  if (choice === RELOAD_WINDOW) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Registers every `repodock.*` command. Which of them appear on a row's context menu is
 * decided in `package.json` by matching the `contextValue` set in `treeProvider.ts`
 * (`repo`/`repoNested`, with a `-pinned` suffix) — so adding a command here is only half
 * the job. Commands invoked from a menu receive the clicked tree element as their argument.
 */
export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { model, recency, pins, refresh, rebuildViews } = deps;

  const open = async (repo: RepoInfo, forceNewWindow?: boolean): Promise<void> => {
    // A repo deleted or moved since the last scan stays listed until the next one. VS Code
    // answers an open of a missing folder with a "Path does not exist" dialog and nothing
    // else, so the row would stay, stamped as the most recently opened repo.
    if (await isMissingDirectory(repo.path)) {
      void vscode.window.showWarningMessage(
        `RepoDock could not open ${repo.name}: ${tildify(repo.path)} no longer exists.`,
      );
      await refresh();
      return;
    }
    await recency.touch(repo.path);
    // an open in a new window leaves this one showing, so its recent order has to move
    rebuildViews();
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo.path), {
      forceNewWindow: forceNewWindow ?? getConfig().openInNewWindow,
    });
  };

  const withRepo = (fn: (repo: RepoInfo) => unknown) => (element?: TreeNode) => {
    const repo = repoOf(element);
    return repo ? fn(repo) : undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'repodock.open',
      withRepo((repo) => open(repo)),
    ),
    vscode.commands.registerCommand(
      'repodock.openInCurrentWindow',
      withRepo((repo) => open(repo, false)),
    ),
    vscode.commands.registerCommand(
      'repodock.openInNewWindow',
      withRepo((repo) => open(repo, true)),
    ),
    vscode.commands.registerCommand(
      'repodock.pinRepo',
      withRepo(async (repo) => {
        await pins.pin(repo.path);
        rebuildViews();
      }),
    ),
    vscode.commands.registerCommand(
      'repodock.unpinRepo',
      withRepo(async (repo) => {
        await pins.unpin(repo.path);
        rebuildViews();
      }),
    ),
    vscode.commands.registerCommand('repodock.manageFolders', () => {
      showFolderManager(model);
    }),
    vscode.commands.registerCommand('repodock.addFolder', () => promptAddFolders()),
    vscode.commands.registerCommand('repodock.removeFolder', async () => {
      const directories = getConfig().directories;
      if (directories.length === 0) return;
      const picked = await vscode.window.showQuickPick(directories.map(tildify), {
        placeHolder: 'Remove a folder from RepoDock',
      });
      if (picked !== undefined) {
        await removeDirectory(expandPath(picked));
      }
    }),
    vscode.commands.registerCommand('repodock.refresh', () => refresh()),
    vscode.commands.registerCommand('repodock.showFolders', () => switchLayout('folders')),
    vscode.commands.registerCommand('repodock.showRecent', () => switchLayout('recent')),
    vscode.commands.registerCommand(
      'repodock.openInTerminal',
      withRepo((repo) => {
        vscode.window.createTerminal({ name: repo.name, cwd: repo.path }).show();
      }),
    ),
    vscode.commands.registerCommand(
      'repodock.addToWorkspace',
      withRepo((repo) => {
        const folders = vscode.workspace.workspaceFolders ?? [];
        const key = canonicalPathKey(repo.path);
        if (folders.some((folder) => canonicalPathKey(folder.uri.fsPath) === key)) {
          void vscode.window.showInformationMessage(
            `${repo.name} is already a folder in this workspace.`,
          );
          return;
        }
        // false means VS Code rejected the change (an invalid folder set); the user gets
        // no other feedback, since the explorer simply stays as it was
        const added = vscode.workspace.updateWorkspaceFolders(folders.length, 0, {
          uri: vscode.Uri.file(repo.path),
        });
        if (!added) {
          void vscode.window.showWarningMessage(
            `RepoDock could not add ${repo.name} to the workspace.`,
          );
        }
      }),
    ),
    vscode.commands.registerCommand(
      'repodock.copyPath',
      withRepo((repo) => vscode.env.clipboard.writeText(repo.path)),
    ),
    vscode.commands.registerCommand(
      'repodock.revealInFinder',
      withRepo((repo) =>
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repo.path)),
      ),
    ),
    vscode.commands.registerCommand(
      'repodock.revealInFileExplorer',
      withRepo((repo) =>
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repo.path)),
      ),
    ),
    vscode.commands.registerCommand(
      'repodock.hideRepo',
      // no explicit refresh: the settings write triggers the configuration listener, which rescans
      withRepo((repo) => hideRepo(repo.path)),
    ),
    vscode.commands.registerCommand('repodock.unhideAll', () => unhideAllRepos()),
  );
}
