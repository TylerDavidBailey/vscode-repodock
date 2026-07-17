import * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';
import { addDirectories, getConfig, removeDirectory, tildify } from './settings';
import type { RepoTreeProvider } from './treeProvider';

interface FolderItem extends vscode.QuickPickItem {
  /** Absent on the "Add Folder…" row. */
  path?: string;
}

/** The OS folder dialog behind both the Add Folder command and the manager's add row. */
export async function promptAddFolders(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: true,
    openLabel: 'Add to RepoDock',
  });
  if (picked && picked.length > 0) {
    await addDirectories(picked.map((uri) => uri.fsPath));
  }
}

/**
 * One place to manage scan folders: every configured folder with its repo count and an
 * inline remove button, plus an add row. Settings updates trigger the rescan listener.
 */
export function showFolderManager(provider: RepoTreeProvider): void {
  const removeButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('trash'),
    tooltip: 'Remove Folder',
  };

  const picker = vscode.window.createQuickPick<FolderItem>();
  picker.placeholder = 'Folders RepoDock scans for repositories';

  const buildItems = (): FolderItem[] => {
    const repos = provider.getRepos();
    const items: FolderItem[] = getConfig().directories.map((dir) => {
      const key = canonicalPathKey(dir);
      const count = new Set(
        repos.filter((repo) => canonicalPathKey(repo.root) === key).map((repo) => repo.path),
      ).size;
      return {
        label: tildify(dir),
        description: `${count} ${count === 1 ? 'repo' : 'repos'}`,
        iconPath: new vscode.ThemeIcon('folder'),
        buttons: [removeButton],
        path: dir,
      };
    });
    items.push({ label: '$(add) Add Folder…', alwaysShow: true });
    return items;
  };
  picker.items = buildItems();

  picker.onDidTriggerItemButton(async (event) => {
    if (event.item.path !== undefined) {
      await removeDirectory(event.item.path);
      picker.items = buildItems();
    }
  });
  picker.onDidAccept(async () => {
    const selected = picker.selectedItems[0];
    picker.hide(); // the OS dialog takes over; reopen from the title bar if needed
    if (selected && selected.path === undefined) {
      await promptAddFolders();
    }
  });
  picker.onDidHide(() => {
    picker.dispose();
  });
  picker.show();
}
