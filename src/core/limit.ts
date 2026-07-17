/** Minimal concurrency limiter: at most `max` (floored to at least 1) run at once. */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: (() => void)[] = [];

  const next = () => {
    active--;
    queue.shift()?.();
  };

  return <T>(fn: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        // Promise.resolve().then(fn) turns synchronous throws into rejections,
        // so `next` always runs and the slot is never leaked.
        Promise.resolve().then(fn).then(resolve, reject).finally(next);
      };
      if (active < limit) {
        run();
      } else {
        queue.push(run);
      }
    });
}
