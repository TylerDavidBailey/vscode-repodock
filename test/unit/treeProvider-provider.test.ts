import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
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
    id?: string;
    description?: string;
    tooltip?: unknown;
    contextValue?: string;
    iconPath?: unknown;
    resourceUri?: unknown;
    command?: unknown;
    constructor(
      public label: string,
      public collapsibleState?: number,
    ) {}
  }
  class ThemeIcon {
    constructor(
      public id: string,
      public color?: unknown,
    ) {}
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  class MarkdownString {
    value = '';
    appendText(text: string) {
      this.value += text;
      return this;
    }
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
  }
  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1 },
    Uri: {
      file: (p: string) => ({
        scheme: 'file',
        fsPath: p,
        with(change: { scheme?: string }) {
          return { ...this, ...change };
        },
      }),
    },
    window: { showWarningMessage: vi.fn() },
    workspace: {
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue: T) =>
          configStore.has(key) ? (configStore.get(key) as T) : defaultValue,
        update: (key: string, value: unknown) => {
          configStore.set(key, value);
          return Promise.resolve();
        },
      }),
    },
  };
});

import * as vscode from 'vscode';
import type { Memento } from 'vscode';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider, type TreeNode } from '../../src/ext/treeProvider';

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

let rootA: string;
let alpha: string;
let beta: string;
let provider: RepoTreeProvider;
let recency: RecencyStore;
let pins: PinStore;

const labels = (rows: TreeNode[]) => rows.map((row) => row.label);

beforeAll(async () => {
  rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-tp-'));
  alpha = path.join(rootA, 'alpha');
  beta = path.join(rootA, 'sub', 'beta');
  await fs.mkdir(alpha, { recursive: true });
  await fs.mkdir(beta, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', alpha]);
  execFileSync('git', ['init', '-b', 'main', beta]);
  await fs.writeFile(path.join(beta, 'untracked.txt'), 'dirty\n'); // beta is dirty

  // overlapping scan roots on purpose: beta is found by both
  configStore.set('directories', [rootA, path.join(rootA, 'sub')]);
  recency = new RecencyStore(fakeMemento());
  pins = new PinStore(fakeMemento());
  provider = new RepoTreeProvider(recency, pins);
});

afterAll(async () => {
  await fs.rm(rootA, { recursive: true, force: true });
});

// these tests run in order and share one provider, mirroring a live session
describe('RepoTreeProvider', () => {
  it('scans overlapping roots and loads git state per unique repo', async () => {
    await provider.refresh();
    const paths = provider.getRepos().map((r) => r.path);
    expect(paths).toHaveLength(3); // beta is listed under both roots
    expect(new Set(paths).size).toBe(2);
    expect(provider.getGitStates().get(alpha)?.branch).toBe('main');
    expect(provider.getGitStates().get(beta)?.untracked).toBe(1);
  });

  it('renders one flat row per unique repo, keeping the shortest relative path', () => {
    const rows = provider.getChildren();
    expect(labels(rows)).toEqual(['alpha', 'beta']);
    // beta is "sub/beta" under rootA but "beta" under rootA/sub; the short one wins,
    // so no folder prefix appears in its description
    const beta = rows[1];
    expect(beta && 'repo' in beta ? beta.repo.relPath : undefined).toBe('beta');
  });

  it('sorts by recency, or by label when configured', async () => {
    await recency.touch(beta);
    try {
      expect(labels(provider.getChildren())).toEqual(['beta', 'alpha']);
      configStore.set('sortOrder', 'alphabetical');
      expect(labels(provider.getChildren())).toEqual(['alpha', 'beta']);
    } finally {
      configStore.delete('sortOrder');
      await recency.touch(alpha); // leave alpha most recent for later tests
    }
  });

  it('floats pinned repos to the top and marks them with a pin icon', async () => {
    // alpha is most recent, so pinning beta must lift it above alpha
    await pins.toggle(beta);
    try {
      const rows = provider.getChildren();
      expect(labels(rows)).toEqual(['beta', 'alpha']);
      const icons = rows.map((row) => (provider.getTreeItem(row).iconPath as { id: string }).id);
      expect(icons).toEqual(['pinned', 'source-control']);
    } finally {
      await pins.toggle(beta);
    }
  });

  it('groups repos into one section per folder when groupByFolder is set', () => {
    configStore.set('groupByFolder', true);
    try {
      const sections = provider.getChildren();
      // sections follow the configured folder order, one per scan root
      expect(labels(sections)).toEqual([rootA, path.join(rootA, 'sub')]);
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
    } finally {
      configStore.delete('groupByFolder');
    }
  });

  it('falls back to the flat list when grouping is on but only one folder is configured', async () => {
    configStore.set('groupByFolder', true);
    configStore.set('directories', [rootA]);
    try {
      await provider.refresh();
      // beta is now only found via rootA, so it carries its folder prefix again
      expect(labels(provider.getChildren())).toEqual(['alpha', 'beta (sub)']);
    } finally {
      configStore.set('directories', [rootA, path.join(rootA, 'sub')]);
      configStore.delete('groupByFolder');
      await provider.refresh();
    }
  });

  it('prunes git state for repos that disappear from disk', async () => {
    await fs.rm(alpha, { recursive: true, force: true });
    await provider.refresh();
    expect(provider.getRepos().some((r) => r.path === alpha)).toBe(false);
    expect(provider.getGitStates().has(alpha)).toBe(false);
    expect(provider.getGitStates().has(beta)).toBe(true);
  });

  it('warns exactly once when the git executable is missing', async () => {
    const warn = vi.mocked(vscode.window.showWarningMessage);
    const oldPath = process.env.PATH;
    process.env.PATH = ''; // git can no longer be found
    try {
      await provider.refresh();
      expect(warn).toHaveBeenCalledTimes(1);
      await provider.refresh(); // second failure must not nag again
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
