import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { scanForRepos } from '../../src/core/scanner';
import { activate, VIEW_ID, type RepoDockApi } from '../../src/ext/extension';
import type { RepoModel } from '../../src/ext/repoModel';
import { fakeExtensionContext } from './helpers/extensionContext';
import { required } from './helpers/required';
import { absPath, makeRepo } from './helpers/repoFixture';
import { outline } from './helpers/provider';
import { stubState as state, type StubTreeView } from './helpers/vscodeStub';

const alpha = makeRepo({ path: '/srv/repos/alpha' });

/** Activates with `/srv/repos` configured and the scan finding `alpha`, and waits for the first scan. */
async function activateWithAlpha(): Promise<RepoDockApi> {
  state.config.set('directories', [absPath('/srv/repos')]);
  vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }]);
  const api = activate(fakeExtensionContext());
  await api.refresh(); // chains off the initial scan, so this settles activation too
  return api;
}

function treeView(): StubTreeView {
  return required(state.treeViews.get(VIEW_ID), 'the RepoDock tree view');
}

beforeEach(() => {
  state.reset();
  vi.mocked(scanForRepos).mockResolvedValue([]);
});

describe('activation', () => {
  it('creates the tree view, and no file decoration, which would bring a file icon with it', () => {
    const api = activate(fakeExtensionContext());
    expect([...state.treeViews.keys()]).toEqual([VIEW_ID]);
    expect(treeView().options.treeDataProvider).toBe(api.provider);
    expect(state.registerFileDecorationProvider).not.toHaveBeenCalled();
  });

  it('offers Collapse All, since the folders fold', () => {
    activate(fakeExtensionContext());
    expect(treeView().options.showCollapseAll).toBe(true);
  });

  it('registers every command and listener against the context for disposal', () => {
    const context = fakeExtensionContext();
    activate(context);
    expect(context.subscriptions.length).toBeGreaterThan(0);
    expect(state.commands.size).toBeGreaterThan(0);
  });

  it('publishes the context key the welcome views read', () => {
    state.config.set('directories', [absPath('/a'), absPath('/b')]);
    activate(fakeExtensionContext());
    expect(state.contextKeys.get('repodock.noDirectories')).toBe(false);
  });

  it('reports no directories when nothing is configured', () => {
    activate(fakeExtensionContext());
    expect(state.contextKeys.get('repodock.noDirectories')).toBe(true);
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
    state.config.set('directories', [absPath('/srv/repos')]);
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

  it.each(['showNestedRepos', 'layout'])(
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

  it('both rescans and re-renders when one save touches a setting of each kind', async () => {
    // VS Code fires a single event per settings save and affectsConfiguration answers for
    // every key that changed in it. Testing the two lists with `else if` would drop the
    // re-render here, because refresh() skips rebuilding when the repo list is unchanged.
    const api = await activateWithAlpha();
    const rebuild = vi.spyOn(api.provider, 'rebuild');
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    await state.fireConfigChange('maxDepth', 'showNestedRepos');
    await api.refresh();

    expect(rebuild).toHaveBeenCalled();
    expect(vi.mocked(scanForRepos).mock.calls.length).toBeGreaterThan(scans);
  });

  it('ignores openInNewWindow, which is read live on each open', async () => {
    const api = await activateWithAlpha();
    const rebuild = vi.spyOn(api.provider, 'rebuild');
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    await state.fireConfigChange('openInNewWindow');

    expect(rebuild).not.toHaveBeenCalled();
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans);
  });

  it('refreshes the context key on a change', async () => {
    await activateWithAlpha();
    expect(state.contextKeys.get('repodock.noDirectories')).toBe(false);

    state.config.set('directories', []);
    await state.fireConfigChange('directories');

    expect(state.contextKeys.get('repodock.noDirectories')).toBe(true);
  });
});

describe('refreshing when the user comes back', () => {
  /** Stands in for the model so the throttle inside refreshIfStale can't hide the call. */
  function spyOnRefreshIfStale(model: RepoModel) {
    return vi.spyOn(model, 'refreshIfStale').mockResolvedValue();
  }

  it('refreshes when the window regains focus, but not when it loses it', async () => {
    const api = await activateWithAlpha();
    const refreshIfStale = spyOnRefreshIfStale(api.model);

    await state.fireWindowState(false);
    expect(refreshIfStale).not.toHaveBeenCalled();

    await state.fireWindowState(true);
    expect(refreshIfStale).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the view becomes visible, but not when it hides', async () => {
    const api = await activateWithAlpha();
    const refreshIfStale = spyOnRefreshIfStale(api.model);

    await treeView().fireVisibility(false);
    expect(refreshIfStale).not.toHaveBeenCalled();

    await treeView().fireVisibility(true);
    expect(refreshIfStale).toHaveBeenCalledTimes(1);
  });
});

describe('activation while the view opens', () => {
  /**
   * Activates with scans that stay pending until finished by hand, in the order they
   * were started, so a test can decide which of two overlapping scans lands first.
   */
  function activateWithPendingScans() {
    state.config.set('directories', [absPath('/root')]);
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    const pending: ((repos: (typeof alpha)[]) => void)[] = [];
    vi.mocked(scanForRepos).mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    const api = activate(fakeExtensionContext());
    const finishScan = (index: number) => {
      required(pending[index], `scan ${index}`)([{ ...alpha }]);
      // api.refresh() below chains a fresh scan off the initial one; let that one resolve
      vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }]);
    };
    return { api, finishScan };
  }

  it('does not restart the initial scan when the view becomes visible during it', async () => {
    const { api, finishScan } = activateWithPendingScans();
    await treeView().fireVisibility(true);
    expect(scanForRepos).toHaveBeenCalledTimes(1);

    finishScan(0);
    await api.refresh();
    expect(api.getRepos().map((repo) => repo.path)).toEqual([alpha.path]);
  });

  it('still records the current repo after a focus event mid-scan', async () => {
    state.config.set('layout', 'recent');
    const { api, finishScan } = activateWithPendingScans();
    await state.fireWindowState(true);

    finishScan(0);
    await api.refresh();

    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path), 'a row for alpha'),
    );
    expect((item.tooltip as { value: string }).value).toContain('Last opened: just now');
  });

  it('keeps the scanning context set until every overlapping refresh has finished', async () => {
    const { api, finishScan } = activateWithPendingScans();
    // a settings change while the initial scan runs starts a second one that supersedes it
    await state.fireConfigChange('directories');
    expect(scanForRepos).toHaveBeenCalledTimes(2);
    finishScan(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // the first scan has come back, but the second is still running
    expect(state.contextKeys.get('repodock.scanning')).toBe(true);

    finishScan(1);
    await api.refresh();
    expect(state.contextKeys.get('repodock.scanning')).toBe(false);
  });
});

describe('the current workspace', () => {
  it('tells the repo open in this window apart in its tooltip only', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    const api = await activateWithAlpha();

    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path), 'a row for alpha'),
    );
    expect(item.label).toBe('alpha');
    expect((item.tooltip as { value: string }).value).toContain('open in this window');
  });

  it('records the repo this window sits in as recently opened', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    state.config.set('layout', 'recent');
    const api = await activateWithAlpha();

    // the tooltip has a last-opened time only because the initial scan called recency.touch
    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path), 'a row for alpha'),
    );
    expect((item.tooltip as { value: string }).value).toContain('Last opened: just now');
  });

  it('re-renders after recording the current repo, so the recent layout lists it first', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    state.config.set('directories', [absPath('/srv/repos')]);
    vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }]);
    const context = fakeExtensionContext();
    const events: string[] = [];
    const update = context.globalState.update.bind(context.globalState);
    context.globalState.update = async (key: string, value: unknown) => {
      await update(key, value);
      events.push('touch');
    };

    const api = activate(context);
    api.provider.onDidChangeTreeData(() => events.push('render'));
    await vi.waitFor(() => {
      expect(events).toContain('touch');
    });
    await Promise.resolve();

    expect(events.at(-1)).toBe('render');
  });

  it('leaves recency alone when this window is not in a scanned repo', async () => {
    state.workspaceFolders = [{ uri: { fsPath: absPath('/somewhere/else') } }];
    state.config.set('layout', 'recent');
    const api = await activateWithAlpha();

    const row = required(api.provider.findRepoElement(alpha.path), 'a row for alpha');
    expect((api.provider.getTreeItem(row).tooltip as { value: string }).value).not.toContain(
      'Last opened',
    );
  });

  it('never reveals or selects a row, which would scroll the pinned repos out of view', async () => {
    // the current repo is colored, and heads the recent layout; a reveal into the folder
    // layout would scroll the pinned repos away and reopen folders the user had folded
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    await activateWithAlpha();
    await treeView().fireVisibility(true);
    expect(treeView().reveal).not.toHaveBeenCalled();
  });

  it('re-derives the highlight when workspace folders change', async () => {
    const api = await activateWithAlpha();
    const rebuild = vi.spyOn(api.provider, 'rebuild');
    const setCurrentRepos = vi.spyOn(api.model, 'setCurrentRepos');

    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    await state.fireWorkspaceFoldersChange();

    expect(setCurrentRepos).toHaveBeenCalledWith([alpha.path]);
    expect(rebuild).toHaveBeenCalled();
  });
});

describe('the rows after activation', () => {
  const beta = makeRepo({ path: '/srv/repos/beta' });

  async function activateWithBoth(): Promise<RepoDockApi> {
    state.config.set('directories', [absPath('/srv/repos')]);
    vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }, { ...beta }]);
    const api = activate(fakeExtensionContext());
    await api.refresh();
    return api;
  }

  it("list the window's own repo first in the recent layout as soon as the first scan lands", async () => {
    state.workspaceFolders = [{ uri: { fsPath: beta.path } }];
    state.config.set('layout', 'recent');
    const api = await activateWithBoth();
    expect(outline(api.provider)).toEqual(['beta', 'alpha']);
  });

  it('move a repo to the top, past a gap, as it is pinned and back as it is unpinned', async () => {
    const api = await activateWithBoth();
    const element = required(api.provider.findRepoElement(beta.path), 'a row for beta');
    const run = (command: string) =>
      (required(state.commands.get(command), command) as (...args: unknown[]) => unknown)(element);

    await run('repodock.pinRepo');
    expect(outline(api.provider)).toEqual(['beta', '', 'alpha']);

    await run('repodock.unpinRepo');
    expect(outline(api.provider)).toEqual(['alpha', 'beta']);
  });

  it('switch layout through the title-bar commands, and the context key follows', async () => {
    state.workspaceFolders = [{ uri: { fsPath: beta.path } }];
    const api = await activateWithBoth();
    expect(state.contextKeys.get('repodock.layout')).toBe('folders');

    await required(state.commands.get('repodock.showRecent'), 'showRecent')();
    await state.fireConfigChange('layout');
    expect(state.contextKeys.get('repodock.layout')).toBe('recent');
    expect(outline(api.provider)).toEqual(['beta', 'alpha']);

    await required(state.commands.get('repodock.showFolders'), 'showFolders')();
    await state.fireConfigChange('layout');
    expect(state.contextKeys.get('repodock.layout')).toBe('folders');
    expect(outline(api.provider)).toEqual(['alpha', 'beta']);
  });

  it('all go once a rescan finds nothing, leaving the welcome text to show', async () => {
    const api = await activateWithAlpha();
    expect(outline(api.provider)).toEqual(['alpha']);

    vi.mocked(scanForRepos).mockResolvedValue([]);
    await api.refresh();
    expect(outline(api.provider)).toEqual([]);
  });
});

describe('fold state across windows', () => {
  it('stores a collapse and an expand, and a later window renders them', async () => {
    const context = fakeExtensionContext();
    state.config.set('directories', [absPath('/srv/repos')]);
    vi.mocked(scanForRepos).mockResolvedValue([makeRepo({ path: '/srv/repos/group/alpha' })]);
    const first = activate(context);
    await first.refresh();
    const [folder] = first.provider.getChildren();
    expect(first.provider.getTreeItem(required(folder, 'the folder')).collapsibleState).toBe(2);

    await treeView().fireCollapse(folder);

    // a second activation over the same global state stands in for the window that
    // opens when the user switches to another repo
    state.treeViews.clear();
    const second = activate(context);
    await second.refresh();
    const [reopened] = second.provider.getChildren();
    const item = () => second.provider.getTreeItem(required(reopened, 'the folder'));
    expect(item().collapsibleState).toBe(1); // Collapsed

    await treeView().fireExpand(reopened);
    expect(item().collapsibleState).toBe(2); // Expanded
  });
});
