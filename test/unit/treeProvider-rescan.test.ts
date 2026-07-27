import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));

vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { RepoInfo } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';
import { absPath, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

const repo = (name: string): RepoInfo => makeRepo({ path: `/root/${name}` });

// what the next scan finds; copied per call so equality can't come from identity
let scanResult: RepoInfo[] = [];
vi.mocked(scanForRepos).mockImplementation(() =>
  Promise.resolve(scanResult.map((repo) => ({ ...repo }))),
);

function newProvider(): RepoTreeProvider {
  return new RepoTreeProvider(new RecencyStore(fakeMemento()), new PinStore(fakeMemento()));
}

describe('RepoTreeProvider background rescans', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    state.config.set('directories', [absPath('/root')]);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('re-renders only when a rescan changes the repo list', async () => {
    const provider = newProvider();
    let fullRenders = 0;
    provider.onDidChangeTreeData((element) => {
      if (element === undefined) fullRenders++;
    });

    scanResult = [repo('alpha')];
    await provider.refresh();
    expect(fullRenders).toBe(1);

    await provider.refresh(); // identical result: the tree must stay untouched
    expect(fullRenders).toBe(1);

    scanResult = [repo('alpha'), repo('beta')];
    await provider.refresh();
    expect(fullRenders).toBe(2);
  });

  it('rescans via refreshIfStale only after the throttle interval', async () => {
    const provider = newProvider();
    scanResult = [repo('alpha')];
    await provider.refresh();
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    await provider.refreshIfStale(); // right after a scan: no disk hit
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans);

    vi.advanceTimersByTime(30_000);
    await provider.refreshIfStale();
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans + 1);
  });

  it('reloads git state without rescanning between the two throttle intervals', async () => {
    const provider = newProvider();
    scanResult = [repo('alpha')];
    await provider.refresh();
    const scans = vi.mocked(scanForRepos).mock.calls.length;
    const loads = vi.mocked(loadGitStates).mock.calls.length;

    // inside the 5s git window: neither the disk nor git is touched
    vi.advanceTimersByTime(4_000);
    await provider.refreshIfStale();
    expect(vi.mocked(loadGitStates).mock.calls.length).toBe(loads);

    // past 5s but short of the 30s rescan window: git reloads, the disk is left alone
    vi.advanceTimersByTime(2_000);
    await provider.refreshIfStale();
    expect(vi.mocked(loadGitStates).mock.calls.length).toBe(loads + 1);
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans);
  });

  it('collapses a burst of git reloads into one per throttle window', async () => {
    const provider = newProvider();
    scanResult = [repo('alpha')];
    await provider.refresh();
    const loads = vi.mocked(loadGitStates).mock.calls.length;

    // window focus fires in bursts; the window opens when a load starts, not when it
    // finishes, so calls arriving inside it collapse into a single load
    vi.advanceTimersByTime(6_000);
    await Promise.all([
      provider.refreshGitStates(),
      provider.refreshGitStates(),
      provider.refreshGitStates(),
    ]);
    expect(vi.mocked(loadGitStates).mock.calls.length).toBe(loads + 1);
  });
});
