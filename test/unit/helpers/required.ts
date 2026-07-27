/**
 * Narrows away `undefined` with a message naming what was missing. The lint config forbids
 * `!`, and `noUncheckedIndexedAccess` makes every array index optional, so tests reaching
 * into rendered rows need this constantly.
 */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}
