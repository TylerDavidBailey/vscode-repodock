import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { scanForRepos } from '../../src/core/scanner';
import { registerCommands } from '../../src/ext/commands';
import { activate } from '../../src/ext/extension';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { getConfig } from '../../src/ext/settings';
import { RepoTreeProvider } from '../../src/ext/treeProvider';
import contributes from '../../package.json';
import { fakeExtensionContext } from './helpers/extensionContext';
import { fakeMemento } from './helpers/memento';
import { absPath, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

/**
 * These assert the seams that no behavioral test can reach: package.json declares commands,
 * menus, settings and context keys as data, and the code produces the values those
 * declarations match on. Rename a `contextValue` or add a command and only these fail.
 */

const { commands, menus, configuration, views, viewsWelcome } = contributes.contributes;

const REPO_VIEW = views.repodock[0];
if (!REPO_VIEW) throw new Error('package.json contributes no repodock view');

interface RowContextValues {
  plain: string;
  pinned: string;
  nested: string;
  nestedPinned: string;
}

/**
 * Renders one row of every shape a repo row can take and returns the `contextValue` each
 * produced, keyed by shape. Derived from the code rather than hardcoded: a rename in
 * `treeProvider.ts` has to fail the `when`-clause assertions below, not slip past them.
 */
async function renderedContextValues(): Promise<RowContextValues> {
  const plain = makeRepo({ path: '/srv/repos/plain' });
  const pinned = makeRepo({ path: '/srv/repos/pinned' });
  const nested = makeRepo({ path: '/srv/repos/plain/nested', parentRepoPath: plain.path });
  const nestedPinned = makeRepo({
    path: '/srv/repos/plain/nested-pinned',
    parentRepoPath: plain.path,
  });
  const repos = [plain, pinned, nested, nestedPinned];

  vi.mocked(scanForRepos).mockResolvedValue(repos.map((repo) => ({ ...repo })));
  state.config.set('directories', [absPath('/srv/repos')]);

  const pins = new PinStore(fakeMemento());
  await pins.pin(pinned.path);
  await pins.pin(nestedPinned.path);
  const provider = new RepoTreeProvider(new RecencyStore(fakeMemento()), pins);
  await provider.refresh();

  const byPath = new Map(
    provider.getChildren().map((node) => {
      const item = provider.getTreeItem(node);
      return ['repo' in node ? node.repo.path : node.label, item.contextValue ?? ''];
    }),
  );
  const valueFor = (repoPath: string) => {
    const value = byPath.get(repoPath);
    if (value === undefined) throw new Error(`no row rendered for ${repoPath}`);
    return value;
  };
  return {
    plain: valueFor(plain.path),
    pinned: valueFor(pinned.path),
    nested: valueFor(nested.path),
    nestedPinned: valueFor(nestedPinned.path),
  };
}

/** Pulls the `viewItem =~ /.../` regex out of a `when` clause. */
function viewItemPattern(when: string): RegExp | undefined {
  const match = /viewItem =~ \/(.+?)\/(?: |$|&)/.exec(when);
  return match?.[1] === undefined ? undefined : new RegExp(match[1]);
}

/** Every `repodock.*` context key a `when` clause or welcome view depends on. */
function referencedContextKeys(): Set<string> {
  const clauses = [
    ...menus['view/title'].map((entry) => entry.when),
    ...viewsWelcome.map((entry) => entry.when),
  ];
  const keys = new Set<string>();
  for (const clause of clauses) {
    // drop `view == repodock.repos`; the view id is not a context key
    for (const [, key] of clause.replace(/view == \S+/g, '').matchAll(/repodock\.(\w+)/g)) {
      if (key) keys.add(`repodock.${key}`);
    }
  }
  return keys;
}

beforeEach(() => {
  state.reset();
});

function registerAll(): void {
  const provider = new RepoTreeProvider(
    new RecencyStore(fakeMemento()),
    new PinStore(fakeMemento()),
  );
  registerCommands(fakeExtensionContext(), {
    provider,
    recency: new RecencyStore(fakeMemento()),
    pins: new PinStore(fakeMemento()),
    refresh: () => Promise.resolve(),
  });
}

describe('contributed commands', () => {
  it('registers exactly the commands package.json contributes', () => {
    registerAll();
    expect([...state.commands.keys()].sort()).toEqual(
      commands.map((command) => command.command).sort(),
    );
  });

  it('hides from the palette exactly the commands that need a tree element', () => {
    // a palette invocation passes no element, so these would be silent no-ops
    const hidden = menus.commandPalette
      .filter((entry) => entry.when === 'false')
      .map((entry) => entry.command);
    // every row menu entry, plus the command a row click invokes via TreeItem.command
    const elementCommands = new Set([
      ...menus['view/item/context'].map((entry) => entry.command),
      'repodock.open',
    ]);
    expect(hidden.sort()).toEqual([...elementCommands].sort());
  });

  it('names a contributed command in every menu entry', () => {
    const contributed = new Set(commands.map((command) => command.command));
    const referenced = [
      ...menus.commandPalette,
      ...menus['view/title'],
      ...menus['view/item/context'],
    ].map((entry) => entry.command);
    expect(referenced.filter((command) => !contributed.has(command))).toEqual([]);
  });
});

describe('view/item/context when clauses', () => {
  const byCommand = new Map(menus['view/item/context'].map((entry) => [entry.command, entry.when]));
  const whenFor = (command: string) => byCommand.get(command) ?? '';

  it('offers pin on unpinned rows and unpin on pinned rows, nested or not', async () => {
    const values = await renderedContextValues();
    const matches = (command: string, shape: keyof typeof values) =>
      viewItemPattern(whenFor(command))?.test(values[shape]) ?? false;

    expect(matches('repodock.pinRepo', 'plain')).toBe(true);
    expect(matches('repodock.pinRepo', 'nested')).toBe(true);
    expect(matches('repodock.pinRepo', 'pinned')).toBe(false);
    expect(matches('repodock.pinRepo', 'nestedPinned')).toBe(false);

    expect(matches('repodock.unpinRepo', 'pinned')).toBe(true);
    expect(matches('repodock.unpinRepo', 'nestedPinned')).toBe(true);
    expect(matches('repodock.unpinRepo', 'plain')).toBe(false);
    expect(matches('repodock.unpinRepo', 'nested')).toBe(false);
  });

  it('offers every other row command on every row shape', async () => {
    const { plain, pinned, nested, nestedPinned } = await renderedContextValues();
    const values = [plain, pinned, nested, nestedPinned];
    const alwaysOffered = menus['view/item/context']
      .map((entry) => entry.command)
      .filter((command) => command !== 'repodock.pinRepo' && command !== 'repodock.unpinRepo');

    for (const command of alwaysOffered) {
      const pattern = viewItemPattern(whenFor(command));
      for (const value of values) {
        expect(pattern?.test(value), `${command} does not match "${value}"`).toBe(true);
      }
    }
  });

  it('leaves no menu entry that can never appear', async () => {
    const { plain, pinned, nested, nestedPinned } = await renderedContextValues();
    const values = [plain, pinned, nested, nestedPinned];
    for (const entry of menus['view/item/context']) {
      const pattern = viewItemPattern(entry.when);
      expect(pattern, `${entry.command} has no viewItem pattern`).toBeDefined();
      expect(
        values.some((value) => pattern?.test(value)),
        `${entry.command} matches no contextValue treeProvider produces`,
      ).toBe(true);
    }
  });

  it('scopes every row and title menu entry to the RepoDock view', () => {
    for (const entry of [...menus['view/item/context'], ...menus['view/title']]) {
      expect(entry.when, entry.command).toContain(`view == ${REPO_VIEW.id}`);
    }
  });
});

describe('configuration defaults', () => {
  it('match the fallbacks getConfig applies when nothing is set', () => {
    const config = getConfig();
    const defaults = configuration.properties;
    expect(config.directories).toEqual(defaults['repodock.directories'].default);
    expect(config.maxDepth).toBe(defaults['repodock.maxDepth'].default);
    expect(config.exclude).toEqual(defaults['repodock.exclude'].default);
    expect(config.hiddenRepos).toEqual(defaults['repodock.hiddenRepos'].default);
    expect(config.showNestedRepos).toBe(defaults['repodock.showNestedRepos'].default);
    expect(config.sortOrder).toBe(defaults['repodock.sortOrder'].default);
    expect(config.groupByFolder).toBe(defaults['repodock.groupByFolder'].default);
    expect(config.openInNewWindow).toBe(defaults['repodock.openInNewWindow'].default);
  });

  it('offers exactly the sort orders the setting enumerates', () => {
    expect(configuration.properties['repodock.sortOrder'].enum).toEqual(['recent', 'alphabetical']);
  });
});

describe('context keys', () => {
  it('sets every key a when clause depends on', () => {
    activate(fakeExtensionContext());
    // repodock.scanning is set by the refresh wrapper rather than at activation
    const set = new Set([...state.contextKeys.keys(), 'repodock.scanning']);
    for (const key of referencedContextKeys()) expect([...set], key).toContain(key);
  });
});

describe('view registration', () => {
  it('creates the tree view package.json declares', () => {
    activate(fakeExtensionContext());
    expect(state.treeView).toBeDefined();
    expect(REPO_VIEW.id).toBe('repodock.repos');
    expect(viewsWelcome.every((entry) => entry.view === REPO_VIEW.id)).toBe(true);
  });
});
