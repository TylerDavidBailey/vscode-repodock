import { describe, expect, it } from 'vitest';
import { PinStore } from '../../src/ext/pins';
import { fakeMemento } from './helpers/memento';

describe('PinStore', () => {
  it('starts empty', () => {
    const pins = new PinStore(fakeMemento());
    expect(pins.all().size).toBe(0);
    expect(pins.isPinned('/repo/a')).toBe(false);
  });

  it('pins a path and unpins it again on a second toggle', async () => {
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
