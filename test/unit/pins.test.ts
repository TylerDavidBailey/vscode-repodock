import { describe, expect, it } from 'vitest';
import type { Memento } from 'vscode';
import { PinStore } from '../../src/ext/pins';

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

describe('PinStore', () => {
  it('starts empty', () => {
    const pins = new PinStore(fakeMemento());
    expect(pins.all().size).toBe(0);
    expect(pins.isPinned('/repo/a')).toBe(false);
  });

  it('toggle pins and unpins a path', async () => {
    const pins = new PinStore(fakeMemento());
    await pins.toggle('/repo/a');
    expect(pins.isPinned('/repo/a')).toBe(true);
    await pins.toggle('/repo/a');
    expect(pins.isPinned('/repo/a')).toBe(false);
  });

  it('keeps other pins intact when toggling one', async () => {
    const pins = new PinStore(fakeMemento());
    await pins.toggle('/repo/a');
    await pins.toggle('/repo/b');
    await pins.toggle('/repo/a');
    expect([...pins.all()]).toEqual(['/repo/b']);
  });

  it('treats paths differing only in case as the same pin on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const pins = new PinStore(fakeMemento());
      await pins.toggle('C:\\Repos\\API');
      expect(pins.isPinned('c:\\repos\\api')).toBe(true);
      await pins.toggle('c:\\repos\\api');
      expect(pins.isPinned('C:\\Repos\\API')).toBe(false);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});
