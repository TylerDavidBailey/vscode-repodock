import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { scanForRepos } from '../../src/core/scanner';
import type { RepoInfo } from '../../src/core/types';
import { promptAddFolders, showFolderManager } from '../../src/ext/folderPicker';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';
import { required } from './helpers/required';
import { makeRepo } from './helpers/repoFixture';
import { stubState as state, type StubQuickPick } from './helpers/vscodeStub';

/** Builds a provider whose scan found `repos`, so the manager has counts to render. */
async function providerWith(repos: RepoInfo[]): Promise<RepoTreeProvider> {
  vi.mocked(scanForRepos).mockImplementation((root) =>
    Promise.resolve(repos.filter((repo) => repo.root === root).map((repo) => ({ ...repo }))),
  );
  const provider = new RepoTreeProvider(
    new RecencyStore(fakeMemento()),
    new PinStore(fakeMemento()),
  );
  await provider.refresh();
  return provider;
}

/** The quick pick the manager just opened. */
function openPicker(): StubQuickPick {
  const picker = state.quickPick;
  if (!picker) throw new Error('the folder manager did not open a quick pick');
  return picker;
}

beforeEach(() => {
  state.reset();
  vi.mocked(scanForRepos).mockResolvedValue([]);
});

describe('promptAddFolders', () => {
  it('asks for folders, never files, and allows several at once', async () => {
    state.showOpenDialog.mockResolvedValue(undefined);
    await promptAddFolders();
    expect(state.showOpenDialog).toHaveBeenCalledWith({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Add to RepoDock',
    });
  });

  it('adds every selected folder', async () => {
    state.showOpenDialog.mockResolvedValue([{ fsPath: '/srv/code' }, { fsPath: '/srv/work' }]);
    await promptAddFolders();
    expect(state.config.get('directories')).toEqual(['/srv/code', '/srv/work']);
  });

  it('adds nothing when cancelled or when the selection is empty', async () => {
    state.showOpenDialog.mockResolvedValue(undefined);
    await promptAddFolders();
    expect(state.config.has('directories')).toBe(false);

    state.showOpenDialog.mockResolvedValue([]);
    await promptAddFolders();
    expect(state.config.has('directories')).toBe(false);
  });
});

describe('showFolderManager', () => {
  it('lists each configured folder with a remove button and an add row', async () => {
    state.config.set('directories', ['/srv/code', '/srv/work']);
    showFolderManager(await providerWith([]));

    const picker = openPicker();
    expect(picker.placeholder).toBe('Folders RepoDock scans for repositories');
    expect(picker.show).toHaveBeenCalled();
    expect(picker.items.map((item) => item.label)).toEqual([
      '/srv/code',
      '/srv/work',
      '$(add) Add Folder…',
    ]);
    // every folder row carries a path and the trash button; the add row carries neither
    expect(picker.items.slice(0, 2).every((item) => item.path !== undefined)).toBe(true);
    expect(picker.items.slice(0, 2).every((item) => item.buttons?.length === 1)).toBe(true);
    expect(picker.items[2]?.path).toBeUndefined();
    expect(picker.items[2]?.alwaysShow).toBe(true);
  });

  it('counts the repos found under each folder, singular and plural', async () => {
    state.config.set('directories', ['/srv/code', '/srv/work']);
    const provider = await providerWith([
      makeRepo({ path: '/srv/code/a', root: '/srv/code' }),
      makeRepo({ path: '/srv/code/b', root: '/srv/code' }),
      makeRepo({ path: '/srv/work/c', root: '/srv/work' }),
    ]);

    showFolderManager(provider);

    expect(openPicker().items.map((item) => item.description)).toEqual([
      '2 repos',
      '1 repo',
      undefined,
    ]);
  });

  it('counts a repo once when two scan roots both found it', async () => {
    state.config.set('directories', ['/srv/code']);
    const provider = await providerWith([
      makeRepo({ path: '/srv/code/a', root: '/srv/code' }),
      // the same repo, listed a second time under the same root
      makeRepo({ path: '/srv/code/a', root: '/srv/code', relPath: 'a' }),
    ]);

    showFolderManager(provider);

    expect(openPicker().items[0]?.description).toBe('1 repo');
  });

  it('removes a folder from the trash button and rebuilds the list', async () => {
    state.config.set('directories', ['/srv/code', '/srv/work']);
    showFolderManager(await providerWith([]));
    const picker = openPicker();

    await picker.fireTriggerItemButton({ item: picker.items[0] });

    expect(state.config.get('directories')).toEqual(['/srv/work']);
    expect(picker.items.map((item) => item.label)).toEqual(['/srv/work', '$(add) Add Folder…']);
  });

  it('ignores a button press on the add row', async () => {
    state.config.set('directories', ['/srv/code']);
    showFolderManager(await providerWith([]));
    const picker = openPicker();

    await picker.fireTriggerItemButton({ item: picker.items[1] });

    expect(state.config.get('directories')).toEqual(['/srv/code']);
  });

  it('opens the folder dialog when the add row is accepted', async () => {
    state.config.set('directories', ['/srv/code']);
    state.showOpenDialog.mockResolvedValue([{ fsPath: path.join('/srv', 'new') }]);
    showFolderManager(await providerWith([]));
    const picker = openPicker();
    picker.selectedItems = [required(picker.items[1], 'the add row')];

    await picker.fireAccept();

    // hidden first: the OS dialog takes over the screen
    expect(picker.hide).toHaveBeenCalled();
    expect(state.showOpenDialog).toHaveBeenCalled();
    expect(state.config.get('directories')).toEqual(['/srv/code', path.join('/srv', 'new')]);
  });

  it('just closes when a folder row is accepted', async () => {
    state.config.set('directories', ['/srv/code']);
    showFolderManager(await providerWith([]));
    const picker = openPicker();
    picker.selectedItems = [required(picker.items[0], 'a folder row')];

    await picker.fireAccept();

    expect(picker.hide).toHaveBeenCalled();
    expect(state.showOpenDialog).not.toHaveBeenCalled();
    expect(state.config.get('directories')).toEqual(['/srv/code']);
  });

  it('disposes the picker once it hides', async () => {
    showFolderManager(await providerWith([]));
    const picker = openPicker();

    await picker.fireHide();

    expect(picker.dispose).toHaveBeenCalled();
  });
});
