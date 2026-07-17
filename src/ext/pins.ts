import type * as vscode from 'vscode';

const KEY = 'repodock.pins';

/** Repository paths pinned to the top of lists, persisted in global storage. */
export class PinStore {
  constructor(private readonly memento: vscode.Memento) {}

  all(): ReadonlySet<string> {
    return new Set(this.memento.get<string[]>(KEY, []));
  }

  isPinned(repoPath: string): boolean {
    return this.all().has(repoPath);
  }

  async toggle(repoPath: string): Promise<void> {
    const pins = new Set(this.all());
    if (pins.has(repoPath)) {
      pins.delete(repoPath);
    } else {
      pins.add(repoPath);
    }
    await this.memento.update(KEY, [...pins]);
  }
}
