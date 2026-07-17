import * as vscode from 'vscode';
import type { RepoInfo } from '../core/types';
import { promptAddFolders, showFolderManager } from './folderPicker';
import type { PinStore } from './pins';
import type { RecencyStore } from './recency';
import {
  expandPath,
  getConfig,
  hideRepo,
  removeDirectory,
  setGroupByFolder,
  setSortOrder,
  tildify,
  unhideAllRepos,
} from './settings';
import type { RepoTreeProvider, TreeElement } from './treeProvider';

interface CommandDeps {
  provider: RepoTreeProvider;
  recency: RecencyStore;
  pins: PinStore;
}

function repoOf(element: TreeElement | undefined): RepoInfo | undefined {
  return element?.repo;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { provider, recency, pins } = deps;

  const open = async (repo: RepoInfo, forceNewWindow?: boolean): Promise<void> => {
    await recency.touch(repo.path);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo.path), {
      forceNewWindow: forceNewWindow ?? getConfig().openInNewWindow,
    });
  };

  const withRepo = (fn: (repo: RepoInfo) => unknown) => (element?: TreeElement) => {
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
        await pins.toggle(repo.path);
        provider.rebuild();
      }),
    ),
    vscode.commands.registerCommand(
      'repodock.unpinRepo',
      withRepo(async (repo) => {
        await pins.toggle(repo.path);
        provider.rebuild();
      }),
    ),
    vscode.commands.registerCommand('repodock.manageFolders', () => {
      showFolderManager(provider);
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
    vscode.commands.registerCommand('repodock.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('repodock.sortAlphabetically', () =>
      setSortOrder('alphabetical'),
    ),
    vscode.commands.registerCommand('repodock.sortByRecent', () => setSortOrder('recent')),
    vscode.commands.registerCommand('repodock.groupByFolder', () => setGroupByFolder(true)),
    vscode.commands.registerCommand('repodock.showFlatList', () => setGroupByFolder(false)),
    vscode.commands.registerCommand(
      'repodock.openInTerminal',
      withRepo((repo) => {
        vscode.window.createTerminal({ name: repo.name, cwd: repo.path }).show();
      }),
    ),
    vscode.commands.registerCommand(
      'repodock.addToWorkspace',
      withRepo((repo) =>
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, {
          uri: vscode.Uri.file(repo.path),
        }),
      ),
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
    // updating the setting triggers the configuration listener, which rescans
    vscode.commands.registerCommand(
      'repodock.hideRepo',
      withRepo((repo) => hideRepo(repo.path)),
    ),
    vscode.commands.registerCommand('repodock.unhideAll', () => unhideAllRepos()),
  );
}
