import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { scanForRepos } from '../../src/core/scanner';
import { activate, type RepoDockApi } from '../../src/ext/extension';
import { CurrentRepoDecorationProvider, type RepoTreeProvider } from '../../src/ext/treeProvider';
import { fakeExtensionContext } from './helpers/extensionContext';
import { required } from './helpers/required';
import { absPath, makeRepo } from './helpers/repoFixture';
import { stubState as state, type StubTreeView } from './helpers/vscodeStub';

const alpha = makeRepo({ path: '/root/alpha' });

/** Activates with `/root` configured and the scan finding `alpha`, and waits for the first scan. */
async function activateWithAlpha(): Promise<RepoDockApi> {
  state.config.set('directories', [absPath('/root')]);
  vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }]);
  const api = activate(fakeExtensionContext());
  await api.refresh(); // chains off the initial scan, so this settles activation too
  return api;
}

function treeView(): StubTreeView {
  const view = state.treeView;
  if (!view) throw new Error('activate did not create a tree view');
  return view;
}

beforeEach(() => {
  state.reset();
  vi.mocked(scanForRepos).mockResolvedValue([]);
});

describe('activation', () => {
  it('creates the tree view and registers the current-repo decoration', () => {
    activate(fakeExtensionContext());
    expect(state.treeView).toBeDefined();
    expect(state.registerFileDecorationProvider).toHaveBeenCalledWith(
      expect.any(CurrentRepoDecorationProvider),
    );
  });

  it('registers every command and listener against the context for disposal', () => {
    const context = fakeExtensionContext();
    activate(context);
    expect(context.subscriptions.length).toBeGreaterThan(0);
    expect(state.commands.size).toBeGreaterThan(0);
  });

  it('publishes the context keys the view menus and welcome views read', () => {
    state.config.set('directories', [absPath('/a'), absPath('/b')]);
    state.config.set('sortOrder', 'alphabetical');
    state.config.set('groupByFolder', true);

    activate(fakeExtensionContext());

    expect(state.contextKeys.get('repodock.noDirectories')).toBe(false);
    expect(state.contextKeys.get('repodock.sortOrder')).toBe('alphabetical');
    expect(state.contextKeys.get('repodock.multipleFolders')).toBe(true);
    expect(state.contextKeys.get('repodock.groupByFolder')).toBe(true);
  });

  it('reports no directories and a single folder when nothing is configured', () => {
    activate(fakeExtensionContext());
    expect(state.contextKeys.get('repodock.noDirectories')).toBe(true);
    expect(state.contextKeys.get('repodock.multipleFolders')).toBe(false);
  });

  it('scans on activation without the caller awaiting it', async () => {
    const api = await activateWithAlpha();
    expect(api.getRepos().map((repo) => repo.path)).toEqual([alpha.path]);
  });
});

describe('the scanning context', () => {
  it('is cleared once a user-requested refresh finishes', async () => {
    const api = await activateWithAlpha();
    await api.refresh();
    expect(state.contextKeys.get('repodock.scanning')).toBe(false);
  });

  it('is cleared even when the scan fails', async () => {
    state.config.set('directories', [absPath('/root')]);
    vi.mocked(scanForRepos).mockRejectedValue(new Error('disk on fire'));

    const api = activate(fakeExtensionContext());
    await expect(api.refresh()).rejects.toThrow('disk on fire');

    // the welcome view keys off !repodock.scanning; a stuck true hides it forever
    expect(state.contextKeys.get('repodock.scanning')).toBe(false);
  });
});

describe('the configuration listener', () => {
  it('rescans when a setting changes which repos exist', async () => {
    const api = await activateWithAlpha();
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    await state.fireConfigChange('directories');
    await api.refresh();

    expect(vi.mocked(scanForRepos).mock.calls.length).toBeGreaterThan(scans);
  });

  it.each(['maxDepth', 'exclude', 'hiddenRepos'])('rescans on %s too', async (key) => {
    const api = await activateWithAlpha();
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    await state.fireConfigChange(key);
    await api.refresh();

    expect(vi.mocked(scanForRepos).mock.calls.length).toBeGreaterThan(scans);
  });

  it.each(['sortOrder', 'showNestedRepos', 'groupByFolder'])(
    'only re-renders on %s, without touching the disk',
    async (key) => {
      const api = await activateWithAlpha();
      const rebuild = vi.spyOn(api.provider, 'rebuild');
      const scans = vi.mocked(scanForRepos).mock.calls.length;

      await state.fireConfigChange(key);

      expect(rebuild).toHaveBeenCalled();
      expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans);
    },
  );

  it('ignores openInNewWindow, which is read live on each open', async () => {
    const api = await activateWithAlpha();
    const rebuild = vi.spyOn(api.provider, 'rebuild');
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    await state.fireConfigChange('openInNewWindow');

    expect(rebuild).not.toHaveBeenCalled();
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans);
  });

  it('refreshes the context keys on a change', async () => {
    await activateWithAlpha();
    expect(state.contextKeys.get('repodock.multipleFolders')).toBe(false);

    state.config.set('directories', [absPath('/root'), absPath('/other')]);
    await state.fireConfigChange('directories');

    expect(state.contextKeys.get('repodock.multipleFolders')).toBe(true);
  });
});

describe('refreshing when the user comes back', () => {
  /** Stands in for the provider so the throttle inside refreshIfStale can't hide the call. */
  function spyOnRefreshIfStale(provider: RepoTreeProvider) {
    return vi.spyOn(provider, 'refreshIfStale').mockResolvedValue();
  }

  it('refreshes when the window regains focus, but not when it loses it', async () => {
    const api = await activateWithAlpha();
    const refreshIfStale = spyOnRefreshIfStale(api.provider);

    await state.fireWindowState(false);
    expect(refreshIfStale).not.toHaveBeenCalled();

    await state.fireWindowState(true);
    expect(refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the view becomes visible, but not when it hides', async () => {
    const api = await activateWithAlpha();
    const refreshIfStale = spyOnRefreshIfStale(api.provider);

    await treeView().fireVisibility(false);
    expect(refreshIfStale).not.toHaveBeenCalled();

    await treeView().fireVisibility(true);
    expect(refreshIfStale).toHaveBeenCalledTimes(1);
  });
});

describe('the current workspace', () => {
  it('highlights the repo open in this window', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    const api = await activateWithAlpha();

    const element = api.provider.findRepoElement(alpha.path);
    expect(element).toBeDefined();
    const item = api.provider.getTreeItem(required(element, 'an element for alpha'));
    expect((item.iconPath as { color?: unknown }).color).toBeDefined();
  });

  it('records the repo this window sits in as recently opened', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    const api = await activateWithAlpha();

    // git state is mocked away, so the description is the last-opened time alone —
    // it exists only because the initial scan called recency.touch
    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path), 'an element for alpha'),
    );
    expect(item.description).toBe('now');
  });

  it('records the repo even when it is not the first workspace folder', async () => {
    state.workspaceFolders = [
      { uri: { fsPath: absPath('/somewhere/else') } },
      { uri: { fsPath: alpha.path } },
    ];
    const api = await activateWithAlpha();

    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path), 'an element for alpha'),
    );
    expect(item.description).toBe('now');
  });

  it('leaves recency alone when this window is not in a scanned repo', async () => {
    state.workspaceFolders = [{ uri: { fsPath: absPath('/somewhere/else') } }];
    const api = await activateWithAlpha();

    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path), 'an element for alpha'),
    );
    expect(item.description).toBe('');
  });

  it('reveals the current repo once the view is visible', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    await activateWithAlpha();
    expect(treeView().reveal).toHaveBeenCalled();
  });

  it('defers the reveal until a hidden view opens, then stops listening', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    state.config.set('directories', [absPath('/root')]);
    vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }]);

    const api = activate(fakeExtensionContext());
    treeView().visible = false;
    await api.refresh();
    expect(treeView().reveal).not.toHaveBeenCalled();

    // a visibility change that leaves the view hidden must not trigger the reveal
    await treeView().fireVisibility(false);
    expect(treeView().reveal).not.toHaveBeenCalled();

    await treeView().fireVisibility(true);
    expect(treeView().reveal).toHaveBeenCalledTimes(1);

    // the one-shot listener disposed itself, so opening again must not reveal twice
    await treeView().fireVisibility(true);
    expect(treeView().reveal).toHaveBeenCalledTimes(1);
  });

  it('survives a reveal the tree view rejects', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    state.config.set('directories', [absPath('/root')]);
    vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }]);

    const api = activate(fakeExtensionContext());
    treeView().reveal.mockRejectedValue(new Error('element was never rendered'));

    await expect(api.refresh()).resolves.toBeUndefined();
    // the rejection has to have actually happened, or this proves nothing
    expect(treeView().reveal).toHaveBeenCalled();
  });

  it('does nothing when the workspace folder is not a scanned repo', async () => {
    state.workspaceFolders = [{ uri: { fsPath: absPath('/somewhere/else') } }];
    await activateWithAlpha();
    expect(treeView().reveal).not.toHaveBeenCalled();
  });

  it('re-derives the highlight when workspace folders change', async () => {
    const api = await activateWithAlpha();
    const rebuild = vi.spyOn(api.provider, 'rebuild');
    const setCurrentRepos = vi.spyOn(api.provider, 'setCurrentRepos');

    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    await state.fireWorkspaceFoldersChange();

    expect(setCurrentRepos).toHaveBeenCalledWith([alpha.path]);
    expect(rebuild).toHaveBeenCalled();
  });
});
