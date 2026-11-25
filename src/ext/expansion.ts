import type * as vscode from 'vscode';

const KEY = 'repodock.expansion';

/**
 * Enough for every section, folder, and repo a user is likely to have folded by hand. Past
 * it the oldest entries go, and those rows fall back to their default state.
 */
const MAX_ENTRIES = 500;

/** Stable identity for the unset store. Never mutated. */
const NO_STATES: Readonly<Record<string, boolean>> = {};

/**
 * Which rows the user has expanded or collapsed, by tree item id, persisted in global
 * storage. VS Code keeps a tree's fold state for the life of a window only, and opening a
 * repository replaces the window's workspace: without this, a section folded away would
 * be open again after every switch.
 *
 * Only rows the user toggled are stored, so a row never touched keeps following its default.
 */
export class ExpansionStore {
  constructor(private readonly memento: vscode.Memento) {}

  /** Whether a row should render expanded: the user's last choice, else `fallback`. */
  isExpanded(id: string, fallback: boolean): boolean {
    return this.memento.get<Readonly<Record<string, boolean>>>(KEY, NO_STATES)[id] ?? fallback;
  }

  /** Records that the user expanded or collapsed a row. */
  async set(id: string, isExpanded: boolean): Promise<void> {
    const stored = this.memento.get<Readonly<Record<string, boolean>>>(KEY, NO_STATES);
    if (stored[id] === isExpanded) return;
    // deleted first, so a row toggled again moves to the newest end of the record and
    // the cap below drops rows by how long ago they were last touched
    const entries = Object.entries(stored).filter(([key]) => key !== id);
    entries.push([id, isExpanded]);
    await this.memento.update(KEY, Object.fromEntries(entries.slice(-MAX_ENTRIES)));
  }
}
