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
}
