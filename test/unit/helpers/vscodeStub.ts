import { vi, type Mock } from 'vitest';

/** A quick pick item as `folderPicker.ts` builds them. */
interface StubQuickPickItem {
  label: string;
  description?: string;
  iconPath?: unknown;
  buttons?: readonly unknown[];
  alwaysShow?: boolean;
  path?: string;
}

/**
 * The `createQuickPick()` object, plus `fire*` helpers a test uses to play the user:
 * the production code registers handlers, the test triggers them.
 */
export interface StubQuickPick {
  items: StubQuickPickItem[];
  placeholder?: string;
  selectedItems: readonly StubQuickPickItem[];
  show: Mock<() => void>;
  hide: Mock<() => void>;
  dispose: Mock<() => void>;
  onDidTriggerItemButton: (listener: (e: unknown) => void) => { dispose: () => void };
  onDidAccept: (listener: () => void) => { dispose: () => void };
  onDidHide: (listener: () => void) => { dispose: () => void };
  fireTriggerItemButton: (event: unknown) => Promise<void>;
  fireAccept: () => Promise<void>;
  fireHide: () => Promise<void>;
}

/** The fake `TreeView` returned by `window.createTreeView`. */
export interface StubTreeView {
  visible: boolean;
  reveal: Mock<(element: unknown, options?: unknown) => Promise<void>>;
  dispose: Mock<() => void>;
  onDidChangeVisibility: (listener: (e: { visible: boolean }) => void) => { dispose: () => void };
  fireVisibility: (visible: boolean) => Promise<void>;
}

/** Everything the stub records or lets a test steer; read back in assertions. */
export interface StubState {
  /** Settings, keyed WITHOUT the `repodock.` prefix — see `createVscodeStub`. */
  config: Map<string, unknown>;
  /** Command id to handler, populated by `commands.registerCommand`. */
  commands: Map<string, (...args: never[]) => unknown>;
  /** Context keys set through `executeCommand('setContext', key, value)`. */
  contextKeys: Map<string, unknown>;
  executeCommand: Mock<(command: string, ...args: unknown[]) => unknown>;
  showWarningMessage: Mock<(message: string) => unknown>;
  showInformationMessage: Mock<(message: string) => unknown>;
  /** Resolves `window.showQuickPick`; set per test. Undefined models cancellation. */
  showQuickPick: Mock<(items: unknown, options?: unknown) => unknown>;
  /** Resolves `window.showOpenDialog`; set per test. Undefined models cancellation. */
  showOpenDialog: Mock<(options?: unknown) => unknown>;
  createTerminal: Mock<(options: { name?: string; cwd?: string }) => unknown>;
  terminals: { name?: string; cwd?: string; show: Mock<() => void> }[];
  clipboard: { writeText: Mock<(text: string) => unknown> };
  updateWorkspaceFolders: Mock<
    (start: number, deleteCount: number, ...added: unknown[]) => boolean
  >;
  registerFileDecorationProvider: Mock<(provider: unknown) => unknown>;
  workspaceFolders: { uri: { fsPath: string } }[] | undefined;
  /** The last quick pick `createQuickPick()` handed out. */
  quickPick?: StubQuickPick;
  /** The last tree view `createTreeView()` handed out. */
  treeView?: StubTreeView;
  /** Fires `onDidChangeConfiguration` for the given keys, with or without the section prefix. */
  fireConfigChange: (...keys: string[]) => Promise<void>;
  /** Fires `onDidChangeWindowState`. */
  fireWindowState: (focused: boolean) => Promise<void>;
  /** Fires `onDidChangeWorkspaceFolders`. */
  fireWorkspaceFoldersChange: () => Promise<void>;
  /** Shared between the `fire*` helpers and the stub's `onDidChange*` registrations. */
  listeners: Listeners;
  reset: () => void;
}

const CONFIG_SECTION = 'repodock';

/** Listener lists the `fire*` helpers dispatch to. */
interface Listeners {
  config: ((e: { affectsConfiguration: (key: string) => boolean }) => unknown)[];
  windowState: ((e: { focused: boolean }) => unknown)[];
  workspaceFolders: (() => unknown)[];
}

/** Fresh recording state; most suites use the `stubState` singleton below instead. */
export function createStubState(): StubState {
  const listeners: Listeners = { config: [], windowState: [], workspaceFolders: [] };
  const terminals: StubState['terminals'] = [];

  // handlers may be async; awaiting the fan-out lets a test await the fire helper
  const fire = async (handlers: ((arg: never) => unknown)[], event: unknown): Promise<void> => {
    for (const handler of handlers) await (handler as (arg: unknown) => unknown)(event);
  };

  const state: StubState = {
    config: new Map(),
    commands: new Map(),
    contextKeys: new Map(),
    executeCommand: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showOpenDialog: vi.fn(),
    createTerminal: vi.fn(),
    terminals,
    clipboard: { writeText: vi.fn() },
    updateWorkspaceFolders: vi.fn(),
    registerFileDecorationProvider: vi.fn(),
    workspaceFolders: undefined,
    listeners,
    fireConfigChange: (...keys) => {
      const changed = new Set(keys.flatMap((key) => [key, `${CONFIG_SECTION}.${key}`]));
      return fire(listeners.config, { affectsConfiguration: (key: string) => changed.has(key) });
    },
    fireWindowState: (focused) => fire(listeners.windowState, { focused }),
    fireWorkspaceFoldersChange: () => fire(listeners.workspaceFolders, undefined),
    reset: () => {
      state.config.clear();
      state.commands.clear();
      state.contextKeys.clear();
      terminals.length = 0;
      state.workspaceFolders = undefined;
      state.quickPick = undefined;
      state.treeView = undefined;
      listeners.config.length = 0;
      listeners.windowState.length = 0;
      listeners.workspaceFolders.length = 0;
      vi.clearAllMocks();
    },
  };
  return state;
}

/**
 * The state the default `createVscodeStub()` records into. Vitest gives each test file its own
 * module registry, so this is per-suite, not shared across files — and being module-level means
 * a suite can `import { stubState }` normally instead of threading it through `vi.hoisted`,
 * which cannot `await` an import in a CommonJS file.
 */
export const stubState = createStubState();

/**
 * The slice of the VS Code API the extension touches, backed by `state` so a suite can seed
 * settings and dialog results before a call and assert writes and API calls after one.
 *
 * Deliberately a superset of what any single suite needs: one shared stub can't drift the
 * way four hand-maintained copies did. Because `vi.mock` factories are hoisted above
 * imports, call this through a dynamic import, then read the recorded calls from the
 * `stubState` singleton:
 *
 * ```ts
 * vi.mock('vscode', async () => (await import('./helpers/vscodeStub')).createVscodeStub());
 * import { stubState as state } from './helpers/vscodeStub';
 * ```
 *
 * Two deliberate simplifications: `getConfiguration` ignores its section argument and stores
 * keys unprefixed (`'directories'`, not `'repodock.directories'`), and `update` ignores its
 * `ConfigurationTarget`. Only one section exists, so the prefix would be noise in every
 * assertion — but it means `state.fireConfigChange` has to accept both forms, since
 * `extension.ts` calls `affectsConfiguration('repodock.directories')`.
 */
export function createVscodeStub(state: StubState = stubState) {
  const { listeners } = state;

  class EventEmitter<T> {
    private listeners: ((e: T) => void)[] = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          const index = this.listeners.indexOf(listener);
          if (index !== -1) this.listeners.splice(index, 1);
        },
      };
    };
    fire(e: T) {
      // copy first: a listener may dispose itself, as the one-shot reveal in extension.ts does
      for (const listener of [...this.listeners]) listener(e);
    }
    dispose() {
      this.listeners = [];
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
    /**
     * Escapes markdown syntax the way the real `appendText` does. Without this a test
     * could not tell `appendText` from `appendMarkdown`, which is the whole point of the
     * tooltip's handling of repo and branch names taken off disk.
     */
    appendText(text: string) {
      this.value += text.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&').replace(/\n/g, '\n\n');
      return this;
    }
    appendMarkdown(text: string) {
      this.value += text;
      return this;
    }
  }

  const register = <T>(list: T[], listener: T) => {
    list.push(listener);
    return {
      dispose: () => {
        const index = list.indexOf(listener);
        if (index !== -1) list.splice(index, 1);
      },
    };
  };

  const createQuickPick = (): StubQuickPick => {
    const accept: (() => unknown)[] = [];
    const hide: (() => unknown)[] = [];
    const triggerItemButton: ((e: unknown) => unknown)[] = [];
    const fire = async (handlers: ((arg: never) => unknown)[], event: unknown) => {
      for (const handler of handlers) await (handler as (arg: unknown) => unknown)(event);
    };
    const picker: StubQuickPick = {
      items: [],
      selectedItems: [],
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
      onDidAccept: (listener) => register(accept, listener),
      onDidHide: (listener) => register(hide, listener),
      onDidTriggerItemButton: (listener) => register(triggerItemButton, listener),
      fireAccept: () => fire(accept, undefined),
      fireHide: () => fire(hide, undefined),
      fireTriggerItemButton: (event) => fire(triggerItemButton, event),
    };
    state.quickPick = picker;
    return picker;
  };

  const createTreeView = (): StubTreeView => {
    const visibility: ((e: { visible: boolean }) => unknown)[] = [];
    const view: StubTreeView = {
      visible: true,
      reveal: vi.fn(() => Promise.resolve()),
      dispose: vi.fn(),
      onDidChangeVisibility: (listener) => register(visibility, listener),
      fireVisibility: async (visible) => {
        view.visible = visible;
        // copy: the one-shot listener in extension.ts disposes itself while being called
        for (const listener of [...visibility]) await listener({ visible });
      },
    };
    state.treeView = view;
    return view;
  };

  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    MarkdownString,
    Disposable: class {
      constructor(public dispose: () => void) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    Uri: {
      file: (p: string) => ({
        scheme: 'file',
        fsPath: p,
        with(change: { scheme?: string }) {
          return { ...this, ...change };
        },
      }),
    },
    commands: {
      registerCommand: (id: string, handler: (...args: never[]) => unknown) => {
        state.commands.set(id, handler);
        return { dispose: () => state.commands.delete(id) };
      },
      executeCommand: (command: string, ...args: unknown[]) => {
        if (command === 'setContext') state.contextKeys.set(args[0] as string, args[1]);
        return state.executeCommand(command, ...args) ?? Promise.resolve();
      },
    },
    env: { clipboard: state.clipboard },
    window: {
      showWarningMessage: state.showWarningMessage,
      showInformationMessage: state.showInformationMessage,
      showQuickPick: state.showQuickPick,
      showOpenDialog: state.showOpenDialog,
      createQuickPick,
      createTreeView,
      registerFileDecorationProvider: (provider: unknown) => {
        state.registerFileDecorationProvider(provider);
        return { dispose: () => undefined };
      },
      createTerminal: (options: { name?: string; cwd?: string }) => {
        const terminal = { ...options, show: vi.fn() };
        state.terminals.push(terminal);
        state.createTerminal(options);
        return terminal;
      },
      onDidChangeWindowState: (listener: (e: { focused: boolean }) => unknown) =>
        register(listeners.windowState, listener),
    },
    workspace: {
      get workspaceFolders() {
        return state.workspaceFolders;
      },
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue: T) =>
          state.config.has(key) ? (state.config.get(key) as T) : defaultValue,
        update: (key: string, value: unknown) => {
          if (value === undefined) {
            state.config.delete(key);
          } else {
            state.config.set(key, value);
          }
          return Promise.resolve();
        },
      }),
      updateWorkspaceFolders: state.updateWorkspaceFolders,
      onDidChangeConfiguration: (
        listener: (e: { affectsConfiguration: (key: string) => boolean }) => unknown,
      ) => register(listeners.config, listener),
      onDidChangeWorkspaceFolders: (listener: () => unknown) =>
        register(listeners.workspaceFolders, listener),
    },
  };
}
