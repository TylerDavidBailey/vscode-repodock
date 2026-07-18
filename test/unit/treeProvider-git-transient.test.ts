import { describe, expect, it, vi } from 'vitest';

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

vi.mock('../../src/core/scanner', () => ({
  scanForRepos: vi.fn(() =>
    Promise.resolve([{ name: 'alpha', path: '/root/alpha', root: '/root', relPath: 'alpha' }]),
  ),
}));

vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import type { Memento } from 'vscode';
import { loadGitStates } from '../../src/core/git';
import type { GitState } from '../../src/core/types';
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
    for (const p of paths) onResult(p, state, timedOut);
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

    nextGitLoad(undefined, true); // git timed out — stale state beats no state
    await provider.refresh();
    expect(provider.getGitStates().get('/root/alpha')?.branch).toBe('main');

    nextGitLoad(undefined, false); // git genuinely failed — the repo is gone or corrupt
    await provider.refresh();
    expect(provider.getGitStates().has('/root/alpha')).toBe(false);
  });
});
