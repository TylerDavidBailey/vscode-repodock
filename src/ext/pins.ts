import type * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';

const KEY = 'repodock.pins';

/** Stable identity for the unset store, so it caches like a populated one. Never mutated. */
const NO_PINS: readonly string[] = [];

/**
 * Repository paths pinned to the top of lists, persisted in global storage.
 * Keyed by canonical path key so Windows drive-letter casing can't lose a pin.
 */
export class PinStore {
  private cache?: { stored: readonly string[]; pins: ReadonlySet<string> };

  constructor(private readonly memento: vscode.Memento) {}

  /**
   * The set is rebuilt only when the stored array changes identity, which `update`
   * guarantees by always writing a fresh one. Every rendered row asks for this, so
   * rebuilding per row is most of the cost of painting a large tree. A Memento that
   * copies on read never hits the cache, leaving the old per-call behavior.
   */
  all(): ReadonlySet<string> {
    const stored = this.memento.get<readonly string[]>(KEY, NO_PINS);
    if (this.cache?.stored !== stored) {
      this.cache = { stored, pins: new Set(stored.map(canonicalPathKey)) };
    }
    return this.cache.pins;
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
