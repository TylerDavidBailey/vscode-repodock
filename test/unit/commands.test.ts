import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn(() => Promise.resolve([])) }));
vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { canonicalPathKey } from '../../src/core/paths';
import { registerCommands } from '../../src/ext/commands';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider, type TreeElement } from '../../src/ext/treeProvider';
import { fakeExtensionContext } from './helpers/extensionContext';
import { fakeMemento } from './helpers/memento';
import { absPath, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

const repo = makeRepo({ path: '/root/alpha' });
const CODE = absPath('/srv/code');
const WORK = absPath('/srv/work');
// under $HOME on purpose: the picker shows tildify'd labels and feeds the choice back
// through expandPath, and neither step is observable with a path outside the home dir
const HOME_DIR = path.join(os.homedir(), 'code');
const HOME_LABEL = '~' + path.sep + 'code';
const element: TreeElement = { repo, label: 'alpha' };

let provider: RepoTreeProvider;
let recency: RecencyStore;
let pins: PinStore;
let refresh: Mock<() => Promise<void>>;

/** Invokes a registered command the way VS Code would, with the clicked element. */
function run(command: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.commands.get(command);
  if (!handler) throw new Error(`command ${command} is not registered`);
  return Promise.resolve((handler as (...a: unknown[]) => unknown)(...args));
}

/** Arguments of the last `executeCommand` call for `command`, or undefined if never called. */
function lastExecute(command: string): unknown[] | undefined {
  const calls = state.executeCommand.mock.calls.filter((call) => call[0] === command);
  return calls.at(-1)?.slice(1);
}

beforeEach(() => {
  state.reset();
  recency = new RecencyStore(fakeMemento());
  pins = new PinStore(fakeMemento());
  provider = new RepoTreeProvider(recency, pins);
  refresh = vi.fn(() => Promise.resolve());
  registerCommands(fakeExtensionContext(), { provider, recency, pins, refresh });
});

describe('opening a repository', () => {
  it('records the open and hands the folder to VS Code', async () => {
    await run('repodock.open', element);

    // recency is keyed canonically, which folds drive-letter case on Windows
    expect([...recency.all().keys()]).toEqual([canonicalPathKey(repo.path)]);
    const [uri, options] = lastExecute('vscode.openFolder') ?? [];
    expect((uri as { fsPath: string }).fsPath).toBe(repo.path);
    expect(options).toEqual({ forceNewWindow: false });
  });

  it('honours the openInNewWindow setting, read live rather than cached', async () => {
    await run('repodock.open', element);
    expect(lastExecute('vscode.openFolder')?.[1]).toEqual({ forceNewWindow: false });

    state.config.set('openInNewWindow', true);
    await run('repodock.open', element);
    expect(lastExecute('vscode.openFolder')?.[1]).toEqual({ forceNewWindow: true });
  });

  it('overrides that setting for the explicit open commands', async () => {
    state.config.set('openInNewWindow', true);
    await run('repodock.openInCurrentWindow', element);
    expect(lastExecute('vscode.openFolder')?.[1]).toEqual({ forceNewWindow: false });

    state.config.set('openInNewWindow', false);
    await run('repodock.openInNewWindow', element);
    expect(lastExecute('vscode.openFolder')?.[1]).toEqual({ forceNewWindow: true });
  });
});

describe('pinning', () => {
  it('toggles a pin on and off again', async () => {
    await run('repodock.pinRepo', element);
    expect(pins.isPinned(repo.path)).toBe(true);
    await run('repodock.pinRepo', element);
    expect(pins.isPinned(repo.path)).toBe(false);
  });

  it('unpins without ever pinning', async () => {
    // the menu only offers Unpin on a -pinned row, but a stale contextValue or a
    // programmatic executeCommand must not turn the command into a pin
    await run('repodock.unpinRepo', element);
    expect(pins.isPinned(repo.path)).toBe(false);

    await pins.toggle(repo.path);
    await run('repodock.unpinRepo', element);
    expect(pins.isPinned(repo.path)).toBe(false);
  });

  it('re-renders the tree after either command', async () => {
    const rebuild = vi.spyOn(provider, 'rebuild');
    await run('repodock.pinRepo', element);
    await run('repodock.unpinRepo', element);
    expect(rebuild).toHaveBeenCalledTimes(2);
  });
});

describe('removing a folder', () => {
  it('does not prompt when no folders are configured', async () => {
    await run('repodock.removeFolder');
    expect(state.showQuickPick).not.toHaveBeenCalled();
  });

  it('offers the configured folders by their display form', async () => {
    state.config.set('directories', [HOME_DIR, WORK]);
    state.showQuickPick.mockResolvedValue(undefined);

    await run('repodock.removeFolder');

    // the home-relative one is shown tildified, the outside one unchanged
    expect(state.showQuickPick).toHaveBeenCalledWith([HOME_LABEL, WORK], {
      placeHolder: 'Remove a folder from RepoDock',
    });
  });

  it('removes the picked folder, expanding the display form back to a path', async () => {
    state.config.set('directories', [HOME_DIR, WORK]);
    // the picker hands back the label it displayed, which is the ~ form
    state.showQuickPick.mockResolvedValue(HOME_LABEL);

    await run('repodock.removeFolder');

    expect(state.config.get('directories')).toEqual([WORK]);
  });

  it('writes nothing when the picker is cancelled', async () => {
    state.config.set('directories', [CODE]);
    state.showQuickPick.mockResolvedValue(undefined);

    await run('repodock.removeFolder');

    expect(state.config.get('directories')).toEqual([CODE]);
  });
});

describe('settings-writing commands', () => {
  it('sets the sort order both ways', async () => {
    await run('repodock.sortAlphabetically');
    expect(state.config.get('sortOrder')).toBe('alphabetical');
    await run('repodock.sortByRecent');
    expect(state.config.get('sortOrder')).toBe('recent');
  });

  it('toggles folder grouping both ways', async () => {
    await run('repodock.groupByFolder');
    expect(state.config.get('groupByFolder')).toBe(true);
    await run('repodock.showFlatList');
    expect(state.config.get('groupByFolder')).toBe(false);
  });

  it('hides a repo by appending it to hiddenRepos', async () => {
    await run('repodock.hideRepo', element);
    expect(state.config.get('hiddenRepos')).toEqual([repo.path]);
  });

  it('unhides everything by clearing the setting', async () => {
    state.config.set('hiddenRepos', [repo.path]);
    await run('repodock.unhideAll');
    expect(state.config.has('hiddenRepos')).toBe(false);
  });
});

describe('operating-system commands', () => {
  it('opens a terminal in the repository directory', async () => {
    await run('repodock.openInTerminal', element);
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0]).toMatchObject({ name: repo.name, cwd: repo.path });
    expect(state.terminals[0]?.show).toHaveBeenCalled();
  });

  it('copies the repository path to the clipboard', async () => {
    await run('repodock.copyPath', element);
    expect(state.clipboard.writeText).toHaveBeenCalledWith(repo.path);
  });

  it('reveals in the OS file manager under either platform name', async () => {
    await run('repodock.revealInFinder', element);
    await run('repodock.revealInFileExplorer', element);
    const reveals = state.executeCommand.mock.calls.filter((call) => call[0] === 'revealFileInOS');
    expect(reveals).toHaveLength(2);
    expect((reveals[0]?.[1] as { fsPath: string }).fsPath).toBe(repo.path);
  });

  it('appends the repository to the workspace after the existing folders', async () => {
    state.workspaceFolders = [{ uri: { fsPath: '/other' } }, { uri: { fsPath: '/another' } }];
    await run('repodock.addToWorkspace', element);

    const [start, deleteCount, added] = state.updateWorkspaceFolders.mock.calls[0] ?? [];
    expect([start, deleteCount]).toEqual([2, 0]);
    expect((added as { uri: { fsPath: string } }).uri.fsPath).toBe(repo.path);
  });

  it('appends at index 0 when no workspace is open', async () => {
    await run('repodock.addToWorkspace', element);
    expect(state.updateWorkspaceFolders).toHaveBeenCalledWith(0, 0, expect.anything());
  });
});

describe('refresh', () => {
  it('delegates to the wrapper that sets the scanning context', async () => {
    await run('repodock.refresh');
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('commands invoked without a tree element', () => {
  // reachable via executeCommand; the palette hides all of these
  const elementCommands = [
    'repodock.open',
    'repodock.openInCurrentWindow',
    'repodock.openInNewWindow',
    'repodock.pinRepo',
    'repodock.unpinRepo',
    'repodock.openInTerminal',
    'repodock.addToWorkspace',
    'repodock.copyPath',
    'repodock.revealInFinder',
    'repodock.revealInFileExplorer',
    'repodock.hideRepo',
  ];

  it.each(elementCommands)('%s does nothing', async (command) => {
    await expect(run(command, undefined)).resolves.toBeUndefined();
    expect(state.executeCommand).not.toHaveBeenCalled();
    expect(state.config.size).toBe(0);
    expect(state.terminals).toHaveLength(0);
    expect(state.clipboard.writeText).not.toHaveBeenCalled();
    expect(state.updateWorkspaceFolders).not.toHaveBeenCalled();
  });
});

describe('folder management commands', () => {
  it('adds the folders picked from the open dialog', async () => {
    state.showOpenDialog.mockResolvedValue([{ fsPath: CODE }]);
    await run('repodock.addFolder');
    expect(state.config.get('directories')).toEqual([CODE]);
  });

  it('adds nothing when the dialog is cancelled', async () => {
    state.showOpenDialog.mockResolvedValue(undefined);
    await run('repodock.addFolder');
    expect(state.config.has('directories')).toBe(false);
  });

  it('shows the folder manager', async () => {
    await run('repodock.manageFolders');
    expect(state.quickPick?.show).toHaveBeenCalled();
  });
});
