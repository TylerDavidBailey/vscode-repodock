import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { scanForRepos } from '../../src/core/scanner';
import { registerCommands } from '../../src/ext/commands';
import { activate, VIEW_ID } from '../../src/ext/extension';
import { getConfig, RESTRICTED_SETTINGS } from '../../src/ext/settings';
import contributes from '../../package.json';
import { fakeExtensionContext } from './helpers/extensionContext';
import { absPath, makeRepo } from './helpers/repoFixture';
import { required } from './helpers/required';
import { createProvider } from './helpers/sections';
import { stubState as state } from './helpers/vscodeStub';

/**
 * These assert the seams that no behavioral test can reach: package.json declares commands,
 * menus, settings and context keys as data, and the code produces the values those
 * declarations match on. Rename a `contextValue` or add a command and only these fail.
 */

const { commands, menus, configuration, views, viewsWelcome } = contributes.contributes;

const VIEWS = views.repodock;

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

  const { model, pins, provider } = createProvider();
  await pins.pin(pinned.path);
  await pins.pin(nestedPinned.path);
  await model.refresh();

  const valueFor = (repoPath: string) => {
    const row = required(provider.findRepoElement(repoPath), `a row for ${repoPath}`);
    return provider.getTreeItem(row).contextValue ?? '';
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

/** Every `repodock.*` context key a `when` clause of a menu or welcome view depends on. */
function referencedContextKeys(): Set<string> {
  const clauses = [
    ...menus['view/title'].map((entry) => entry.when),
    ...menus['view/item/context'].map((entry) => entry.when),
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
  const { model, recency, pins } = createProvider();
  registerCommands(fakeExtensionContext(), {
    model,
    recency,
    pins,
    refresh: () => Promise.resolve(),
    rebuildViews: () => undefined,
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

  it('gives an icon to every command shown as a button', () => {
    // a button without an icon falls back to its full title, which blows up a row
    const iconOf = new Map(
      commands.map((command) => [command.command, 'icon' in command ? command.icon : undefined]),
    );
    const buttons = [...menus['view/title'], ...menus['view/item/context']]
      .filter((entry) => /^(inline|navigation)/.test(entry.group))
      .map((entry) => entry.command);
    expect(buttons.length).toBeGreaterThan(0);
    for (const command of buttons) expect(iconOf.get(command), command).toBeDefined();
  });
});

describe('view/item/context when clauses', () => {
  const byCommand = new Map(menus['view/item/context'].map((entry) => [entry.command, entry.when]));
  const whenFor = (command: string) => byCommand.get(command) ?? '';

  it('uses one when clause per command, whether it is a row button or a menu item', () => {
    // pin, unpin and open-in-new-window each appear twice; the map above keeps one clause
    // per command, which is only sound while both entries agree
    for (const [command, when] of byCommand) {
      const clauses = menus['view/item/context']
        .filter((entry) => entry.command === command)
        .map((entry) => entry.when);
      expect(new Set(clauses), command).toEqual(new Set([when]));
    }
  });

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
      expect(entry.when, entry.command).toContain(`view == ${VIEW_ID}`);
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
    expect(config.recentCount).toBe(defaults['repodock.recentCount'].default);
    expect(config.openInNewWindow).toBe(defaults['repodock.openInNewWindow'].default);
  });

  it('covers every setting, so a new one cannot ship without a default being checked', () => {
    expect(Object.keys(configuration.properties).sort()).toEqual(
      Object.keys(getConfig())
        .map((key) => `repodock.${key}`)
        .sort(),
    );
  });

  it('declares the range getConfig clamps recentCount to', () => {
    const schema = configuration.properties['repodock.recentCount'];
    state.config.set('recentCount', schema.minimum - 1);
    expect(getConfig().recentCount).toBe(schema.minimum);
    state.config.set('recentCount', schema.maximum + 1);
    expect(getConfig().recentCount).toBe(schema.maximum);
  });
});

describe('restricted configurations', () => {
  // VS Code enforces the manifest list; settings.ts picks a write scope from its own copy.
  // If they drift, a Restricted Mode write lands in a scope VS Code is not reading.
  it('match the settings the writers treat as ignored in Restricted Mode', () => {
    const declared = contributes.capabilities.untrustedWorkspaces.restrictedConfigurations;
    expect([...declared].sort()).toEqual(
      [...RESTRICTED_SETTINGS].map((key) => `repodock.${key}`).sort(),
    );
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
  it('creates exactly the tree view package.json declares', () => {
    activate(fakeExtensionContext());
    expect(VIEWS.map((view) => view.id)).toEqual([VIEW_ID]);
    expect([...state.treeViews.keys()]).toEqual([VIEW_ID]);
  });

  it('keeps the view id RepoDock has always used', () => {
    // keybindings and a moved view from an earlier version point at this id
    expect(VIEW_ID).toBe('repodock.repos');
  });

  it('attaches every welcome message to that view, and always shows the view itself', () => {
    expect(viewsWelcome.every((entry) => entry.view === VIEW_ID)).toBe(true);
    // the view holds the Add Folder button, so nothing may hide it
    expect(VIEWS.every((view) => !('when' in view))).toBe(true);
  });
});
