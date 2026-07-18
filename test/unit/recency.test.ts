import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Memento } from 'vscode';
import { RecencyStore } from '../../src/ext/recency';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RecencyStore', () => {
  it('starts empty and records touches', async () => {
    const store = new RecencyStore(fakeMemento());
    expect(store.all().size).toBe(0);
    await store.touch('/repos/alpha');
    expect(store.all().has('/repos/alpha')).toBe(true);
  });

  it('updates the timestamp when a path is touched again', async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    const store = new RecencyStore(fakeMemento());
    await store.touch('/repos/alpha');
    const first = store.all().get('/repos/alpha');
    await store.touch('/repos/alpha');
    const second = store.all().get('/repos/alpha');
    expect(second).toBeGreaterThan(first ?? Number.MAX_SAFE_INTEGER);
    expect(store.all().size).toBe(1);
  });

  it('caps the store at 200 entries, evicting the oldest', async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    const store = new RecencyStore(fakeMemento());
    for (let i = 0; i < 205; i++) {
      await store.touch(`/repos/repo-${i}`);
    }
    const all = store.all();
    expect(all.size).toBe(200);
    expect(all.has('/repos/repo-4')).toBe(false); // five oldest evicted
    expect(all.has('/repos/repo-5')).toBe(true);
    expect(all.has('/repos/repo-204')).toBe(true);
  });

  it('folds path case on Windows so a drive-letter casing change keeps the entry', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const store = new RecencyStore(fakeMemento());
      await store.touch('C:\\Repos\\API');
      await store.touch('c:\\repos\\api');
      const all = store.all();
      expect(all.size).toBe(1);
      expect(all.has('c:\\repos\\api')).toBe(true);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('re-touching an old entry saves it from eviction', async () => {
    let t = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    const store = new RecencyStore(fakeMemento());
    for (let i = 0; i < 200; i++) {
      await store.touch(`/repos/repo-${i}`);
    }
    await store.touch('/repos/repo-0'); // refresh the oldest
    await store.touch('/repos/new-arrival'); // pushes the store over the cap
    const all = store.all();
    expect(all.has('/repos/repo-0')).toBe(true);
    expect(all.has('/repos/repo-1')).toBe(false); // now the oldest, evicted
  });
});
