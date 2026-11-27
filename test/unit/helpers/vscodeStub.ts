import { vi, type Mock } from 'vitest';
import manifest from '../../../package.json';

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
  /** The view id it was created for. */
  id: string;
  /** The options object `createTreeView` was given, provider included. */
  options: Record<string, unknown>;
  /** Assigned by the extension: the dim text beside the view's title. */
  description?: string;
  visible: boolean;
  reveal: Mock<(element: unknown, options?: unknown) => Promise<void>>;
  dispose: Mock<() => void>;
  onDidChangeVisibility: (listener: (e: { visible: boolean }) => void) => { dispose: () => void };
  fireVisibility: (visible: boolean) => Promise<void>;
  onDidCollapseElement: (listener: (e: { element: unknown }) => void) => { dispose: () => void };
  onDidExpandElement: (listener: (e: { element: unknown }) => void) => { dispose: () => void };
  /** Plays the user folding a row. */
  fireCollapse: (element: unknown) => Promise<void>;
  /** Plays the user unfolding a row. */
  fireExpand: (element: unknown) => Promise<void>;
}

/** Everything the stub records or lets a test steer; read back in assertions. */
export interface StubState {
  /** User (global) settings, keyed WITHOUT the `repodock.` prefix — see `createVscodeStub`. */
  config: Map<string, unknown>;
  /** Workspace settings, same keys; a value here shadows `config` in `get`, as in VS Code. */
  workspaceConfig: Map<string, unknown>;
  /**
   * `workspace.isTrusted`; a Restricted Mode workspace ignores its workspace-scoped values
   * for the settings `package.json` lists as restricted, and only for those.
   */
  workspaceTrusted: boolean;
  /**
   * Settings the window has no schema for, as after an in-place update that skipped the
   * reload: `inspect` reports no default for them and `update` rejects them, as VS Code does.
   */
  unregisteredKeys: Set<string>;
  /** Command id to handler, populated by `commands.registerCommand`. */
  commands: Map<string, (...args: never[]) => unknown>;
  /** Context keys set through `executeCommand('setContext', key, value)`. */
  contextKeys: Map<string, unknown>;
  executeCommand: Mock<(command: string, ...args: unknown[]) => unknown>;
  showWarningMessage: Mock<(message: string, ...items: string[]) => unknown>;
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
  /** Every tree view `createTreeView()` handed out, by view id. */
  treeViews: Map<string, StubTreeView>;
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

/** Unprefixed, like the config stores. Read from the manifest because that is what VS Code enforces. */
const RESTRICTED_KEYS = new Set(
  manifest.capabilities.untrustedWorkspaces.restrictedConfigurations.map((key) =>
    key.slice(CONFIG_SECTION.length + 1),
  ),
);

/** Unprefixed setting key to its `package.json` default, which `inspect` reports. */
const DEFAULTS = new Map(
  Object.entries(manifest.contributes.configuration.properties).map(([key, schema]) => [
    key.slice(CONFIG_SECTION.length + 1),
    (schema as { default: unknown }).default,
  ]),
);

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
    workspaceConfig: new Map(),
    workspaceTrusted: true,
    unregisteredKeys: new Set(),
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
    treeViews: new Map(),
    listeners,
    fireConfigChange: (...keys) => {
      const changed = new Set(keys.flatMap((key) => [key, `${CONFIG_SECTION}.${key}`]));
      return fire(listeners.config, { affectsConfiguration: (key: string) => changed.has(key) });
    },
    fireWindowState: (focused) => fire(listeners.windowState, { focused }),
    fireWorkspaceFoldersChange: () => fire(listeners.workspaceFolders, undefined),
    reset: () => {
      state.config.clear();
      state.workspaceConfig.clear();
      state.workspaceTrusted = true;
      state.unregisteredKeys.clear();
      state.commands.clear();
      state.contextKeys.clear();
      terminals.length = 0;
      state.workspaceFolders = undefined;
      state.quickPick = undefined;
      state.treeViews.clear();
      listeners.config.length = 0;
      listeners.windowState.length = 0;
      listeners.workspaceFolders.length = 0;
      // resetAllMocks, not clearAllMocks: clear drops recorded calls but keeps
      // implementations, so a mockResolvedValue seeded by one test would silently answer
      // the next one. Suites re-seed scanForRepos/loadGitStates in their own beforeEach.
      vi.resetAllMocks();
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
 * One deliberate simplification: `getConfiguration` ignores its section argument and stores
 * keys unprefixed (`'directories'`, not `'repodock.directories'`). Only one section exists,
 * so the prefix would be noise in every assertion — but it means `state.fireConfigChange`
 * has to accept both forms, since `extension.ts` calls `affectsConfiguration('repodock.directories')`.
 *
 * Scopes are modelled: `update` honors its `ConfigurationTarget` (`Workspace` writes to
 * `state.workspaceConfig`, anything else to `state.config`), `get` lets a workspace value
 * shadow a global one, and `inspect` reports both — the pieces a writer needs to avoid
 * updating a scope the workspace is shadowing.
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

  class FileDecoration {
    constructor(
      public badge?: string,
      public tooltip?: string,
      public color?: unknown,
    ) {}
  }

  // accumulates into `value` so tooltip tests can assert the rendered markdown
  class MarkdownString {
    value = '';
    /**
     * Escapes markdown syntax the way the real `appendText` does. Without this a test
     * could not tell `appendText` from `appendMarkdown`, which is the whole point of the
     * tooltip's handling of repo and branch names taken off disk.
     *
     * The character set mirrors `escapeMarkdownSyntaxTokens` in VS Code's
     * `vs/base/common/htmlContent.ts`. Note `~` is escaped (tildify puts one at the front
     * of most repo paths) and `.` is not — an earlier version of this stub had both
     * backwards, which made the tooltip test assert a string VS Code never produces.
     */
    appendText(text: string) {
      this.value += text.replace(/[\\`*_{}[\]()#+\-!~]/g, '\\$&').replace(/\n/g, '\n\n');
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

  const createTreeView = (id: string, options: Record<string, unknown>): StubTreeView => {
    const visibility: ((e: { visible: boolean }) => unknown)[] = [];
    const collapse: ((e: { element: unknown }) => unknown)[] = [];
    const expand: ((e: { element: unknown }) => unknown)[] = [];
    const view: StubTreeView = {
      onDidCollapseElement: (listener) => register(collapse, listener),
      onDidExpandElement: (listener) => register(expand, listener),
      fireCollapse: async (element) => {
        for (const listener of [...collapse]) await listener({ element });
      },
      fireExpand: async (element) => {
        for (const listener of [...expand]) await listener({ element });
      },
      id,
      options,
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
    state.treeViews.set(id, view);
    return view;
  };

  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    FileDecoration,
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
      get isTrusted() {
        return state.workspaceTrusted;
      },
      getConfiguration: () => ({
        get: <T>(key: string, defaultValue: T) => {
          // Restricted Mode drops the workspace value of a restricted setting, nothing else
          const isIgnored = !state.workspaceTrusted && RESTRICTED_KEYS.has(key);
          if (!isIgnored && state.workspaceConfig.has(key)) {
            return state.workspaceConfig.get(key) as T;
          }
          return state.config.has(key) ? (state.config.get(key) as T) : defaultValue;
        },
        inspect: (key: string) => ({
          key,
          defaultValue: state.unregisteredKeys.has(key) ? undefined : DEFAULTS.get(key),
          globalValue: state.config.get(key),
          workspaceValue: state.workspaceConfig.get(key),
        }),
        update: (key: string, value: unknown, target?: number) => {
          if (state.unregisteredKeys.has(key)) {
            return Promise.reject(
              new Error(
                `Unable to write to User Settings because ${CONFIG_SECTION}.${key} is not a registered configuration.`,
              ),
            );
          }
          const store = target === 2 ? state.workspaceConfig : state.config;
          if (value === undefined) {
            store.delete(key);
          } else {
            store.set(key, value);
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
