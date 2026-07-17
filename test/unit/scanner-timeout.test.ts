import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanForRepos } from '../../src/core/scanner';

// simulate a dead network mount: readdir never settles
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(() => new Promise(() => {})),
}));

afterEach(() => {
  vi.useRealTimers();
});

describe('scanForRepos on a hung filesystem', () => {
  it('gives up on directories whose readdir never settles', async () => {
    vi.useFakeTimers();
    const promise = scanForRepos('/dead-mount', { maxDepth: 4, exclude: [] });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(promise).resolves.toEqual([]);
  });
});
