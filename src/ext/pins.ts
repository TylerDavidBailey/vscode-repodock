import type * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';

const KEY = 'repodock.pins';

/**
 * Repository paths pinned to the top of lists, persisted in global storage.
 * Keyed by canonical path key so Windows drive-letter casing can't lose a pin.
 */
export class PinStore {
  constructor(private readonly memento: vscode.Memento) {}

  all(): ReadonlySet<string> {
    return new Set(this.memento.get<string[]>(KEY, []).map(canonicalPathKey));
  }

  isPinned(repoPath: string): boolean {
    return this.all().has(canonicalPathKey(repoPath));
  }

  /**
   * Pins idempotently: the Pin command must never unpin, since its menu visibility
   * depends on a `contextValue` that can be stale by the time it runs.
   */
  async pin(repoPath: string): Promise<void> {
    const pins = new Set(this.all());
    const key = canonicalPathKey(repoPath);
    if (pins.has(key)) return;
    pins.add(key);
    await this.memento.update(KEY, [...pins]);
  }

  /** Unpins idempotently, for the same reason `pin` never unpins. */
  async unpin(repoPath: string): Promise<void> {
    const pins = new Set(this.all());
    if (!pins.delete(canonicalPathKey(repoPath))) return;
    await this.memento.update(KEY, [...pins]);
  }
}
