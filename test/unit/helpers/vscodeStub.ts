import { vi } from 'vitest';

/**
 * The slice of the VS Code API that `RepoTreeProvider` and `settings.ts` touch, backed by
 * `configStore` so a suite can seed settings before a call and assert writes after one.
 *
 * Deliberately a superset of what any single suite needs: one shared stub can't drift the
 * way four hand-maintained copies did. Because `vi.mock` factories are hoisted above
 * imports, call this through a dynamic import:
 *
 * ```ts
 * const { configStore } = vi.hoisted(() => ({ configStore: new Map<string, unknown>() }));
 * vi.mock('vscode', async () => (await import('./helpers/vscodeStub')).createVscodeStub(configStore));
 * ```
 */
export function createVscodeStub(configStore: Map<string, unknown>) {
  class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(e: T) {
      for (const listener of this.listeners) listener(e);
    }
  }

  class TreeItem {
    id?: string;
    description?: string;
    tooltip?: unknown;
    contextValue?: string;
    iconPath?: unknown;
    resourceUri?: unknown;
    command?: unknown;
    constructor(
      public label: string,
      public collapsibleState?: number,
    ) {}
  }

  class ThemeIcon {
    constructor(
      public id: string,
      public color?: unknown,
    ) {}
  }

  class ThemeColor {
    constructor(public id: string) {}
  }

  // accumulates into `value` so tooltip tests can assert the rendered markdown
  class MarkdownString {
    value = '';
    appendText(text: string) {
      this.value += text;
      return this;
    }
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
  }

  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1 },
    Uri: {
      file: (p: string) => ({
        scheme: 'file',
        fsPath: p,
        with(change: { scheme?: string }) {
          return { ...this, ...change };
        },
      }),
    },
    window: { showWarningMessage: vi.fn() },
    workspace: {
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue: T) =>
          configStore.has(key) ? (configStore.get(key) as T) : defaultValue,
        update: (key: string, value: unknown) => {
          configStore.set(key, value);
          return Promise.resolve();
        },
      }),
    },
  };
}
