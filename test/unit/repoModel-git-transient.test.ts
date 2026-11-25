import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));

vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import { loadGitStates } from '../../src/core/git';
import type { GitState } from '../../src/core/types';
import { RepoModel } from '../../src/ext/repoModel';
import { scanForRepos } from '../../src/core/scanner';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

const STATE: GitState = makeGitState({ hasUpstream: false });
const alpha = makeRepo({ path: '/srv/repos/alpha' });
vi.mocked(scanForRepos).mockImplementation(() => Promise.resolve([{ ...alpha }]));

/** Queues one loadGitStates outcome: a state, a timeout, or a plain failure. */
function nextGitLoad(gitState: GitState | undefined, timedOut: boolean) {
  vi.mocked(loadGitStates).mockImplementationOnce((paths, onResult) => {
    for (const repoPath of paths) onResult(repoPath, gitState, timedOut);
    return Promise.resolve({ gitMissing: false });
  });
}

describe('RepoModel on transient git failures', () => {
  it('keeps the last known state on a timeout, drops it on a real failure', async () => {
    state.config.set('directories', [absPath('/srv/repos')]);
    const model = new RepoModel();
    const reloaded: string[] = [];
    model.onDidChangeGitState((repoPath) => reloaded.push(repoPath));

    nextGitLoad(STATE, false);
    await model.refresh();
    expect(model.getGitStates().get(alpha.path)?.branch).toBe('main');

    nextGitLoad(undefined, true); // git timed out; keep showing the stale state
    await model.refresh();
    expect(model.getGitStates().get(alpha.path)?.branch).toBe('main');

    nextGitLoad(undefined, false); // git genuinely failed; the repo is gone or corrupt
    await model.refresh();
    expect(model.getGitStates().has(alpha.path)).toBe(false);
    // every load is announced, the failed ones included, so a row can drop a stale branch
    expect(reloaded).toEqual([alpha.path, alpha.path, alpha.path]);
  });
});
