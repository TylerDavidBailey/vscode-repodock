import { describe, expect, it } from 'vitest';
import { createLimiter } from '../../src/core/limit';

describe('createLimiter', () => {
  it('never runs more than max functions at once', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;

    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return i;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('propagates rejections without stalling the queue', async () => {
    const limit = createLimiter(1);
    await expect(limit(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limit(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('rejects synchronous throws without leaking the slot', async () => {
    const limit = createLimiter(1);
    await expect(
      limit(() => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');
    // with a leaked slot this would queue forever and time out
    await expect(limit(() => Promise.resolve('still works'))).resolves.toBe('still works');
  });

  it('runs queued functions in submission order', async () => {
    const limit = createLimiter(1);
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((i) =>
        limit(() => {
          order.push(i);
          return Promise.resolve();
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('treats a max below 1 as a serial limiter instead of deadlocking', async () => {
    const limit = createLimiter(0);
    await expect(limit(() => Promise.resolve(42))).resolves.toBe(42);
  });
});
