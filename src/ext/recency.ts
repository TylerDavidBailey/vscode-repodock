import type * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';

const KEY = 'repodock.recency';
const MAX_ENTRIES = 200;

/**
 * Last-opened timestamps per repository path, persisted in global storage.
 * Keyed by canonical path key so Windows drive-letter casing can't lose an entry;
 * pre-existing duplicates that differ only in case fold to their newest timestamp.
 */
export class RecencyStore {
  constructor(private readonly memento: vscode.Memento) {}

  all(): Map<string, number> {
    const map = new Map<string, number>();
    for (const [p, t] of Object.entries(this.memento.get<Record<string, number>>(KEY, {}))) {
      const key = canonicalPathKey(p);
      map.set(key, Math.max(t, map.get(key) ?? 0));
    }
    return map;
  }

  async touch(repoPath: string): Promise<void> {
    const record = Object.fromEntries(this.all());
    record[canonicalPathKey(repoPath)] = Date.now();
    const entries = Object.entries(record).sort(([, a], [, b]) => b - a);
    await this.memento.update(KEY, Object.fromEntries(entries.slice(0, MAX_ENTRIES)));
  }
}
