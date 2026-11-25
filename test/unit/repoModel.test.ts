import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import * as vscode from 'vscode';
import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { GitState, RepoInfo } from '../../src/core/types';
import { RepoModel } from '../../src/ext/repoModel';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

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

const root = absPath('/srv/repos');
const alpha = makeRepo({ path: '/srv/repos/alpha' });
const beta = makeRepo({ path: '/srv/repos/sub/beta' });

beforeEach(() => {
  state.reset();
  state.config.set('directories', [root]);
  scanReturns([alpha, beta]);
  gitReturns({});
});

describe('RepoModel', () => {
  it('never scans the working directory for a blank directories entry', async () => {
    state.config.set('directories', ['']);
    const model = new RepoModel();
    await model.refresh();
    expect(scanForRepos).not.toHaveBeenCalled();
    expect(model.getRepos()).toEqual([]);
  });

  it('scans each configured folder with the configured depth and exclusions', async () => {
    state.config.set('maxDepth', 2);
    state.config.set('exclude', ['vendor']);
    await new RepoModel().refresh();
    expect(scanForRepos).toHaveBeenCalledWith(root, { maxDepth: 2, exclude: ['vendor'] });
  });

  it('drops hidden repos before anything else sees them', async () => {
    state.config.set('hiddenRepos', [alpha.path]);
    const model = new RepoModel();
    await model.refresh();
    expect(model.getRepos().map((repo) => repo.name)).toEqual(['beta']);
  });

  it('keeps both findings of a repo that overlapping roots share, but shows it once', async () => {
    const sub = absPath('/srv/repos/sub');
    // beta is found by both roots: as "sub/beta" under /srv/repos and as "beta" under /srv/repos/sub
    const betaViaSub = makeRepo({ path: '/srv/repos/sub/beta', root: sub });
    state.config.set('directories', [root, sub]);
    scanReturns([alpha, beta, betaViaSub]);

    const model = new RepoModel();
    await model.refresh();

    expect(model.getRepos()).toHaveLength(3);
    const visible = model.visibleRepos();
    expect(visible.map((repo) => repo.name)).toEqual(['alpha', 'beta']);
    // the nearer root wins, which is the one with the shorter relative path
    expect(visible[1]?.relPath).toBe('beta');
  });

  it('leaves nested repos out of what the views show when showNestedRepos is off', async () => {
    const nested = makeRepo({ path: '/srv/repos/alpha/vendor', parentRepoPath: alpha.path });
    scanReturns([alpha, nested]);
    const model = new RepoModel();
    await model.refresh();
    expect(model.visibleRepos()).toHaveLength(2);

    state.config.set('showNestedRepos', false);
    expect(model.visibleRepos().map((repo) => repo.name)).toEqual(['alpha']);
    // the scan result itself is untouched, so turning the setting back on needs no rescan
    expect(model.getRepos()).toHaveLength(2);
  });

  it('loads git state once per repo path, however many roots found it', async () => {
    const sub = absPath('/srv/repos/sub');
    state.config.set('directories', [root, sub]);
    scanReturns([alpha, beta, makeRepo({ path: '/srv/repos/sub/beta', root: sub })]);
    await new RepoModel().refresh();
    expect(vi.mocked(loadGitStates).mock.calls.at(-1)?.[0]).toEqual([alpha.path, beta.path]);
  });

  it('announces each git state as it lands', async () => {
    gitReturns({ [alpha.path]: makeGitState(), [beta.path]: makeGitState() });
    const model = new RepoModel();
    const announced: string[] = [];
    model.onDidChangeGitState((repoPath) => announced.push(repoPath));
    await model.refresh();
    expect(announced).toEqual([alpha.path, beta.path]);
  });

  it('prunes git state for repos that disappear from disk', async () => {
    gitReturns({ [alpha.path]: makeGitState(), [beta.path]: makeGitState() });
    const model = new RepoModel();
    await model.refresh();
    expect(model.getGitStates().has(alpha.path)).toBe(true);

    scanReturns([beta]);
    gitReturns({ [beta.path]: makeGitState() });
    await model.refresh();

    expect(model.getRepos().some((repo) => repo.path === alpha.path)).toBe(false);
    expect(model.getGitStates().has(alpha.path)).toBe(false);
    expect(model.getGitStates().has(beta.path)).toBe(true);
  });

  it('warns exactly once when the git executable is missing', async () => {
    gitReturns({}, true);
    const model = new RepoModel();
    const warn = vi.mocked(vscode.window.showWarningMessage);

    await model.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
    await model.refresh(); // second failure must not nag again
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('knows which repos are open in this window', () => {
    const model = new RepoModel();
    expect(model.isCurrent(alpha.path)).toBe(false);
    model.setCurrentRepos([alpha.path]);
    expect(model.isCurrent(alpha.path)).toBe(true);
    expect(model.isCurrent(beta.path)).toBe(false);
    model.setCurrentRepos([]);
    expect(model.isCurrent(alpha.path)).toBe(false);
  });

  it('stops announcing once disposed', async () => {
    const model = new RepoModel();
    let announced = 0;
    model.onDidChangeRepos(() => announced++);
    model.dispose();
    await model.refresh();
    expect(announced).toBe(0);
  });
});
