import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { configStore } = vi.hoisted(() => ({ configStore: new Map<string, unknown>() }));

// minimal vscode stand-in: just enough surface for RepoTreeProvider and settings
vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e: T) {
      for (const listener of this.listeners) listener(e);
    }
  }
  class TreeItem {
    constructor(
      public label: string,
      public collapsibleState?: number,
    ) {}
  }
  class ThemeIcon {
    constructor(public id: string) {}
  }
  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor: class {
      constructor(public id: string) {}
    },
    MarkdownString: class {
      appendText() {
        return this;
      }
      appendMarkdown() {
        return this;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    Uri: { file: (p: string) => ({ fsPath: p, with: () => ({}) }) },
    window: { showWarningMessage: vi.fn() },
    workspace: {
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue: T) =>
          configStore.has(key) ? (configStore.get(key) as T) : defaultValue,
      }),
    },
  };
});

vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));

vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import type { Memento } from 'vscode';
import { scanForRepos } from '../../src/core/scanner';
import type { RepoInfo } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider } from '../../src/ext/treeProvider';

function fakeMemento(): Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: <T>(key: string, defaultValue?: T) =>
      store.has(key) ? (store.get(key) as T) : defaultValue,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
  };
}

const repo = (name: string): RepoInfo => ({
  name,
  path: `/root/${name}`,
  root: '/root',
  relPath: name,
});

// what the next scan finds; copied per call so equality can't come from identity
let scanResult: RepoInfo[] = [];
vi.mocked(scanForRepos).mockImplementation(() =>
  Promise.resolve(scanResult.map((r) => ({ ...r }))),
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
