import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { configStore } = vi.hoisted(() => ({ configStore: new Map<string, unknown>() }));

vi.mock('vscode', async () =>
  (await import('./helpers/vscodeStub.js')).createVscodeStub(configStore),
);

vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));

vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { scanForRepos } from '../../src/core/scanner';
import type { RepoInfo } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';

const repo = (name: string): RepoInfo => ({
  name,
  path: `/root/${name}`,
  root: '/root',
  relPath: name,
});

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
    configStore.set('directories', ['/root']);
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
});
