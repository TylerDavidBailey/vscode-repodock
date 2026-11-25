import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { scanForRepos } from '../../src/core/scanner';
import { activate, VIEW_ID, type RepoDockApi } from '../../src/ext/extension';
import type { RepoModel } from '../../src/ext/repoModel';
import { RepoDecorationProvider } from '../../src/ext/treeProvider';
import { fakeExtensionContext } from './helpers/extensionContext';
import { required } from './helpers/required';
import { absPath, makeRepo } from './helpers/repoFixture';
import { labelOf, sectionRows } from './helpers/sections';
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
  it('creates the tree view and registers the row decoration', () => {
    const api = activate(fakeExtensionContext());
    expect([...state.treeViews.keys()]).toEqual([VIEW_ID]);
    expect(treeView().options.treeDataProvider).toBe(api.provider);
    expect(state.registerFileDecorationProvider).toHaveBeenCalledWith(
      expect.any(RepoDecorationProvider),
    );
  });

  it('offers Collapse All, since the sections and folders all fold', () => {
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

  it.each(['showNestedRepos', 'recentCount'])(
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
    const { api, finishScan } = activateWithPendingScans();
    await state.fireWindowState(true);

    finishScan(0);
    await api.refresh();

    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path, 'recent'), 'a Recent row for alpha'),
    );
    expect(item.description).toBe('now');
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
  it('highlights the repo open in this window', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    const api = await activateWithAlpha();

    for (const section of ['all', 'recent'] as const) {
      const item = api.provider.getTreeItem(
        required(api.provider.findRepoElement(alpha.path, section), `a ${section} row for alpha`),
      );
      expect((item.iconPath as { color?: unknown }).color).toBeDefined();
    }
  });

  it('records the repo this window sits in as recently opened', async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    const api = await activateWithAlpha();

    // git state is mocked away, so the description is the last-opened time alone, and
    // the row is in Recent at all only because the initial scan called recency.touch
    const item = api.provider.getTreeItem(
      required(api.provider.findRepoElement(alpha.path, 'recent'), 'a Recent row for alpha'),
    );
    expect(item.description).toBe('now');
  });

  it('re-renders after recording the current repo, so it appears at the top of Recent', async () => {
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
    const api = await activateWithAlpha();

    expect(sectionRows(api.provider, 'recent')).toEqual([]);
    expect(api.provider.findRepoElement(alpha.path)).toBeDefined();
  });

  it('never reveals or selects a row, which would scroll the sections out of view', async () => {
    // the current repo heads Recent and is colored in every section, so it is already on
    // screen; a reveal into All Repositories would scroll Pinned and Recent away
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

describe('the section headings after activation', () => {
  const beta = makeRepo({ path: '/srv/repos/beta' });
  const headings = (api: RepoDockApi) =>
    api.provider
      .getChildren()
      .map(
        (node) =>
          `${labelOf(api.provider, node)} ${String(api.provider.getTreeItem(node).description)}`,
      );

  it("list the window's own repo under Recent as soon as the first scan lands", async () => {
    state.workspaceFolders = [{ uri: { fsPath: alpha.path } }];
    state.config.set('directories', [absPath('/srv/repos')]);
    vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }, { ...beta }]);
    const api = activate(fakeExtensionContext());
    await api.refresh();

    expect(headings(api)).toEqual(['Recent 1', 'All Repositories 2']);
  });

  it('gain and lose Pinned as a repo is pinned and unpinned through the commands', async () => {
    const api = await activateWithAlpha();
    const element = required(api.provider.findRepoElement(alpha.path), 'a row for alpha');
    const run = (command: string) =>
      (required(state.commands.get(command), command) as (...args: unknown[]) => unknown)(element);

    await run('repodock.pinRepo');
    expect(headings(api)).toEqual(['Pinned 1', 'All Repositories 1']);

    await run('repodock.unpinRepo');
    expect(headings(api)).toEqual(['All Repositories 1']);
  });

  it('all go once a rescan finds nothing, leaving the welcome text to show', async () => {
    const api = await activateWithAlpha();
    expect(headings(api)).toEqual(['All Repositories 1']);

    vi.mocked(scanForRepos).mockResolvedValue([]);
    await api.refresh();
    expect(headings(api)).toEqual([]);
  });
});

describe('fold state across windows', () => {
  it('stores a collapse and an expand, and a later window renders them', async () => {
    const context = fakeExtensionContext();
    state.config.set('directories', [absPath('/srv/repos')]);
    vi.mocked(scanForRepos).mockResolvedValue([{ ...alpha }]);
    const first = activate(context);
    await first.refresh();
    const [heading] = first.provider.getChildren();
    expect(first.provider.getTreeItem(required(heading, 'the heading')).collapsibleState).toBe(2);

    await treeView().fireCollapse(heading);

    // a second activation over the same global state stands in for the window that
    // opens when the user switches to another repo
    state.treeViews.clear();
    const second = activate(context);
    await second.refresh();
    const [reopened] = second.provider.getChildren();
    const item = () => second.provider.getTreeItem(required(reopened, 'the heading'));
    expect(item().collapsibleState).toBe(1); // Collapsed

    await treeView().fireExpand(reopened);
    expect(item().collapsibleState).toBe(2); // Expanded
  });
});
