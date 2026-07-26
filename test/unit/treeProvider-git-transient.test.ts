import { describe, expect, it, vi } from 'vitest';

const { configStore } = vi.hoisted(() => ({ configStore: new Map<string, unknown>() }));

vi.mock('vscode', async () =>
  (await import('./helpers/vscodeStub.js')).createVscodeStub(configStore),
);

vi.mock('../../src/core/scanner', () => ({
  scanForRepos: vi.fn(() =>
    Promise.resolve([{ name: 'alpha', path: '/root/alpha', root: '/root', relPath: 'alpha' }]),
  ),
}));

vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import { loadGitStates } from '../../src/core/git';
import type { GitState } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';

const STATE: GitState = {
  branch: 'main',
  detached: false,
  changes: 0,
  untracked: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
};

/** Queues one loadGitStates outcome: a state, a timeout, or a plain failure. */
function nextGitLoad(state: GitState | undefined, timedOut: boolean) {
  vi.mocked(loadGitStates).mockImplementationOnce((paths, onResult) => {
    for (const repoPath of paths) onResult(repoPath, state, timedOut);
    return Promise.resolve({ gitMissing: false });
  });
}

describe('RepoTreeProvider on transient git failures', () => {
  it('keeps the last known state on a timeout, drops it on a real failure', async () => {
    configStore.set('directories', ['/root']);
    const provider = new RepoTreeProvider(
      new RecencyStore(fakeMemento()),
      new PinStore(fakeMemento()),
    );

    nextGitLoad(STATE, false);
    await provider.refresh();
    expect(provider.getGitStates().get('/root/alpha')?.branch).toBe('main');

    nextGitLoad(undefined, true); // git timed out; keep showing the stale state
    await provider.refresh();
    expect(provider.getGitStates().get('/root/alpha')?.branch).toBe('main');

    nextGitLoad(undefined, false); // git genuinely failed; the repo is gone or corrupt
    await provider.refresh();
    expect(provider.getGitStates().has('/root/alpha')).toBe(false);
  });
});
