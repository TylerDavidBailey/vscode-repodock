import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));

vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import { loadGitStates } from '../../src/core/git';
import type { GitState } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';
import { scanForRepos } from '../../src/core/scanner';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

const STATE: GitState = makeGitState({ hasUpstream: false });
const alpha = makeRepo({ path: '/root/alpha' });
vi.mocked(scanForRepos).mockImplementation(() => Promise.resolve([{ ...alpha }]));

/** Queues one loadGitStates outcome: a state, a timeout, or a plain failure. */
function nextGitLoad(gitState: GitState | undefined, timedOut: boolean) {
  vi.mocked(loadGitStates).mockImplementationOnce((paths, onResult) => {
    for (const repoPath of paths) onResult(repoPath, gitState, timedOut);
    return Promise.resolve({ gitMissing: false });
  });
}

describe('RepoTreeProvider on transient git failures', () => {
  it('keeps the last known state on a timeout, drops it on a real failure', async () => {
    state.config.set('directories', [absPath('/root')]);
    const provider = new RepoTreeProvider(
      new RecencyStore(fakeMemento()),
      new PinStore(fakeMemento()),
    );

    nextGitLoad(STATE, false);
    await provider.refresh();
    expect(provider.getGitStates().get(alpha.path)?.branch).toBe('main');

    nextGitLoad(undefined, true); // git timed out; keep showing the stale state
    await provider.refresh();
    expect(provider.getGitStates().get(alpha.path)?.branch).toBe('main');

    nextGitLoad(undefined, false); // git genuinely failed; the repo is gone or corrupt
    await provider.refresh();
    expect(provider.getGitStates().has(alpha.path)).toBe(false);
  });
});
