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

  async toggle(repoPath: string): Promise<void> {
    const pins = new Set(this.all());
    const key = canonicalPathKey(repoPath);
    if (pins.has(key)) {
      pins.delete(key);
    } else {
      pins.add(key);
    }
    await this.memento.update(KEY, [...pins]);
  }

  /**
   * Unpins without the toggle's other half: the Unpin command must never pin, since its
   * menu visibility depends on a `contextValue` that can be stale by the time it runs.
   */
  async unpin(repoPath: string): Promise<void> {
    const pins = new Set(this.all());
    if (!pins.delete(canonicalPathKey(repoPath))) return;
    await this.memento.update(KEY, [...pins]);
  }
}
