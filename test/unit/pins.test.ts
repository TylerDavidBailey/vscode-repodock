import { describe, expect, it } from 'vitest';
import { PinStore } from '../../src/ext/pins';
import { fakeMemento } from './helpers/memento';

describe('PinStore', () => {
  it('starts empty', () => {
    const pins = new PinStore(fakeMemento());
    expect(pins.all().size).toBe(0);
    expect(pins.isPinned('/repo/a')).toBe(false);
  });

  it('pins a path and unpins it again', async () => {
    const pins = new PinStore(fakeMemento());
    await pins.pin('/repo/a');
    expect(pins.isPinned('/repo/a')).toBe(true);
    await pins.unpin('/repo/a');
    expect(pins.isPinned('/repo/a')).toBe(false);
  });

  it('pinning an already-pinned path keeps it pinned', async () => {
    const pins = new PinStore(fakeMemento());
    await pins.pin('/repo/a');
    await pins.pin('/repo/a');
    expect([...pins.all()]).toEqual(['/repo/a']);
  });

  it('keeps other pins intact when unpinning one', async () => {
    const pins = new PinStore(fakeMemento());
    await pins.pin('/repo/a');
    await pins.pin('/repo/b');
    await pins.unpin('/repo/a');
    expect([...pins.all()]).toEqual(['/repo/b']);
  });

  it('treats paths differing only in case as the same pin on Windows', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const pins = new PinStore(fakeMemento());
      await pins.pin('C:\\Repos\\API');
      expect(pins.isPinned('c:\\repos\\api')).toBe(true);
      await pins.unpin('c:\\repos\\api');
      expect(pins.isPinned('C:\\Repos\\API')).toBe(false);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});
