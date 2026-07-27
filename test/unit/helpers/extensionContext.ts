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

/**
 * Typed as a full `ExtensionContext` so callers need no cast, though only the three members
 * above exist. Anything else `activate` starts touching will fail loudly at runtime rather
 * than being silently absent.
 */
export function fakeExtensionContext(): vscode.ExtensionContext {
  const context: FakeExtensionContext = {
    subscriptions: [],
    globalState: Object.assign(fakeMemento(), { setKeysForSync: () => undefined }),
    workspaceState: fakeMemento(),
  };
  return context as vscode.ExtensionContext;
}
