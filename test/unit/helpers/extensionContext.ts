import type * as vscode from 'vscode';
import { fakeMemento } from './memento';

/**
 * The slice of `ExtensionContext` that `activate` touches. `globalState` needs
 * `setKeysForSync`, which plain `Memento` lacks — added here rather than in `fakeMemento`,
 * so the store suites keep the narrower type they actually depend on.
 */
export interface FakeExtensionContext {
  subscriptions: { dispose: () => void }[];
  globalState: vscode.ExtensionContext['globalState'];
  workspaceState: vscode.Memento;
}

export function fakeExtensionContext(): FakeExtensionContext {
  return {
    subscriptions: [],
    globalState: Object.assign(fakeMemento(), { setKeysForSync: () => undefined }),
    workspaceState: fakeMemento(),
  };
}
