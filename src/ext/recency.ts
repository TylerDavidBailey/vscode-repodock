import type * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';

const KEY = 'repodock.recency';
const MAX_ENTRIES = 200;

/** Stable identity for the unset store, so it caches like a populated one. Never mutated. */
const NO_TIMES: Readonly<Record<string, number>> = {};

/**
 * Last-opened timestamps per repository path, persisted in global storage.
 * Keyed by canonical path key so Windows drive-letter casing can't lose an entry;
 * pre-existing duplicates that differ only in case fold to their newest timestamp.
 */
export class RecencyStore {
  private cache?: {
    stored: Readonly<Record<string, number>>;
    times: ReadonlyMap<string, number>;
  };

  constructor(private readonly memento: vscode.Memento) {}

  /**
   * The map is rebuilt only when the stored record changes identity, which `update`
   * guarantees by always writing a fresh one. Every rendered row asks for this, so
   * folding up to 200 entries per row is most of the cost of painting a large tree.
   * A Memento that copies on read never hits the cache, leaving the old per-call behavior.
   */
  all(): ReadonlyMap<string, number> {
    const stored = this.memento.get<Readonly<Record<string, number>>>(KEY, NO_TIMES);
    if (this.cache?.stored !== stored) {
      const times = new Map<string, number>();
      for (const [storedPath, timestamp] of Object.entries(stored)) {
        const key = canonicalPathKey(storedPath);
        times.set(key, Math.max(timestamp, times.get(key) ?? 0));
      }
      this.cache = { stored, times };
    }
    return this.cache.times;
  }

  async touch(repoPath: string): Promise<void> {
    const record = Object.fromEntries(this.all());
    record[canonicalPathKey(repoPath)] = Date.now();
    const entries = Object.entries(record).sort(([, a], [, b]) => b - a);
    await this.memento.update(KEY, Object.fromEntries(entries.slice(0, MAX_ENTRIES)));
  }
}
