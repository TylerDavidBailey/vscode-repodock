import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import * as vscode from 'vscode';
import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { GitState, RepoInfo } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider, type TreeNode } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

const labels = (rows: TreeNode[]) => rows.map((row) => row.label);

/** Builds a provider with fresh stores, so no test can observe another's pins or recency. */
function newProvider(): { provider: RepoTreeProvider; recency: RecencyStore; pins: PinStore } {
  const recency = new RecencyStore(fakeMemento());
  const pins = new PinStore(fakeMemento());
  return { provider: new RepoTreeProvider(recency, pins), recency, pins };
}

/** Makes the mocked scanner return `repos` for every configured root. */
function scanReturns(repos: RepoInfo[]): void {
  // fresh copies per call: sameRepoList must compare by value, not by object identity
  vi.mocked(scanForRepos).mockImplementation((root) =>
    Promise.resolve(repos.filter((repo) => repo.root === root).map((repo) => ({ ...repo }))),
  );
}

/** Makes the mocked git loader report `states` (keyed by repo path) for the paths it is given. */
function gitReturns(states: Record<string, GitState>, gitMissing = false): void {
  vi.mocked(loadGitStates).mockImplementation((paths, onResult) => {
    for (const repoPath of paths) onResult(repoPath, states[repoPath], false);
    return Promise.resolve({ gitMissing });
  });
}

beforeEach(() => {
  state.reset();
  vi.mocked(scanForRepos).mockResolvedValue([]);
  gitReturns({});
});

describe('RepoTreeProvider', () => {
  const root = absPath('/root');
  const alpha = makeRepo({ path: '/root/alpha' });
  const beta = makeRepo({ path: '/root/sub/beta' });

  beforeEach(() => {
    state.config.set('directories', [root]);
    scanReturns([alpha, beta]);
  });

  it('renders one flat row per repo, labelled by folder when nested', async () => {
    const { provider } = newProvider();
    await provider.refresh();
    expect(labels(provider.getChildren())).toEqual(['alpha', 'beta (sub)']);
  });

  it('keeps the shortest relative path when overlapping roots find the same repo', async () => {
    const sub = absPath('/root/sub');
    // beta is found by both roots: as "sub/beta" under /root and as "beta" under /root/sub
    const betaViaSub = makeRepo({ path: '/root/sub/beta', root: sub });
    state.config.set('directories', [root, sub]);
    scanReturns([alpha, beta, betaViaSub]);

    const { provider } = newProvider();
    await provider.refresh();

    expect(provider.getRepos()).toHaveLength(3);
    const rows = provider.getChildren();
    expect(labels(rows)).toEqual(['alpha', 'beta']);
    const row = rows[1];
    expect(row && 'repo' in row ? row.repo.relPath : undefined).toBe('beta');
  });

  it('sorts by recency, or by label when configured', async () => {
    const { provider, recency } = newProvider();
    await provider.refresh();
    await recency.touch(beta.path);

    expect(labels(provider.getChildren())).toEqual(['beta (sub)', 'alpha']);
    state.config.set('sortOrder', 'alphabetical');
    expect(labels(provider.getChildren())).toEqual(['alpha', 'beta (sub)']);
  });

  it('floats pinned repos to the top and marks them with a pin icon', async () => {
    const { provider, recency, pins } = newProvider();
    await provider.refresh();
    await recency.touch(alpha.path); // alpha is most recent, so the pin has to outrank it
    await pins.pin(beta.path);

    const rows = provider.getChildren();
    expect(labels(rows)).toEqual(['beta (sub)', 'alpha']);
    const icons = rows.map((row) => (provider.getTreeItem(row).iconPath as { id: string }).id);
    expect(icons).toEqual(['pinned', 'source-control']);
  });

  it('groups repos into one section per folder when groupByFolder is set', async () => {
    const sub = absPath('/root/sub');
    const betaViaSub = makeRepo({ path: '/root/sub/beta', root: sub });
    state.config.set('directories', [root, sub]);
    state.config.set('groupByFolder', true);
    scanReturns([alpha, beta, betaViaSub]);

    const { provider } = newProvider();
    await provider.refresh();

    const sections = provider.getChildren();
    // sections follow the configured folder order, one per scan root
    expect(labels(sections)).toEqual([root, sub]);
    const [outer, inner] = sections;
    if (!outer || !inner) throw new Error('expected two folder sections');
    // beta is found by both overlapping roots; after dedupe it appears only
    // in the inner (more specific) folder's section
    expect(labels(provider.getChildren(outer))).toEqual(['alpha']);
    const innerRows = provider.getChildren(inner);
    expect(labels(innerRows)).toEqual(['beta']);
    // reveal support: repo rows report their section as parent
    expect(innerRows[0] && provider.getParent(innerRows[0])).toBe(inner);
    const item = provider.getTreeItem(inner);
    expect(item.collapsibleState).toBe(2); // Expanded
    expect(item.description).toBe('1');
  });

  it('falls back to the flat list when grouping is on but only one folder is configured', async () => {
    state.config.set('groupByFolder', true);
    const { provider } = newProvider();
    await provider.refresh();
    expect(labels(provider.getChildren())).toEqual(['alpha', 'beta (sub)']);
  });

  it('falls back to the flat list when only one of several folders holds repos', async () => {
    // the group-by-folder toggle is offered whenever 2+ folders are configured, but a
    // single section is indistinguishable from a flat list, so don't render one
    state.config.set('directories', [root, absPath('/other')]);
    state.config.set('groupByFolder', true);
    const { provider } = newProvider();
    await provider.refresh();
    expect(labels(provider.getChildren())).toEqual(['alpha', 'beta (sub)']);
  });

  it('prunes git state for repos that disappear from disk', async () => {
    gitReturns({ [alpha.path]: makeGitState(), [beta.path]: makeGitState() });
    const { provider } = newProvider();
    await provider.refresh();
    expect(provider.getGitStates().has(alpha.path)).toBe(true);

    scanReturns([beta]);
    gitReturns({ [beta.path]: makeGitState() });
    await provider.refresh();

    expect(provider.getRepos().some((repo) => repo.path === alpha.path)).toBe(false);
    expect(provider.getGitStates().has(alpha.path)).toBe(false);
    expect(provider.getGitStates().has(beta.path)).toBe(true);
  });

  it('warns exactly once when the git executable is missing', async () => {
    gitReturns({}, true);
    const { provider } = newProvider();
    const warn = vi.mocked(vscode.window.showWarningMessage);

    await provider.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
    await provider.refresh(); // second failure must not nag again
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
