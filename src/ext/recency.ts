import type * as vscode from 'vscode';

const KEY = 'repodock.recency';
const MAX_ENTRIES = 200;

/** Last-opened timestamps per repository path, persisted in global storage. */
export class RecencyStore {
  constructor(private readonly memento: vscode.Memento) {}

  all(): Map<string, number> {
    return new Map(Object.entries(this.memento.get<Record<string, number>>(KEY, {})));
  }

  async touch(repoPath: string): Promise<void> {
    const record = { ...this.memento.get<Record<string, number>>(KEY, {}) };
    record[repoPath] = Date.now();
    const entries = Object.entries(record).sort(([, a], [, b]) => b - a);
    await this.memento.update(KEY, Object.fromEntries(entries.slice(0, MAX_ENTRIES)));
  }
}
