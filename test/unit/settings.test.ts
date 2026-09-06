import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDirectories,
  expandPath,
  getConfig,
  hideRepo,
  removeDirectory,
  setGroupByFolder,
  setSortOrder,
  tildify,
  unhideAllRepos,
} from '../../src/ext/settings';
import { absPath } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

beforeEach(() => {
  state.reset();
});

const configStore = state.config;

const home = os.homedir();

describe('expandPath', () => {
  it('expands a bare ~ to the home directory', () => {
    expect(expandPath('~')).toBe(home);
  });

  it('expands ~/ prefixes', () => {
    expect(expandPath('~/code')).toBe(path.join(home, 'code'));
  });

  it('expands ~\\ prefixes (Windows-style)', () => {
    expect(expandPath('~\\code')).toBe(path.resolve(home, 'code'));
  });

  it('normalizes trailing separators so duplicates dedupe', () => {
    expect(expandPath('~/code/')).toBe(expandPath('~/code'));
  });

  it('normalizes . and .. segments in absolute paths', () => {
    const abs = [home, 'a', '..', 'b'].join(path.sep); // join() would pre-normalize
    expect(expandPath(abs)).toBe(path.join(home, 'b'));
  });

  it('resolves relative paths against the working directory', () => {
    expect(expandPath('some/dir')).toBe(path.resolve('some/dir'));
  });

  it('does not expand ~ in the middle of a path', () => {
    const p = path.join(home, 'data', '~backup');
    expect(expandPath(p)).toBe(p);
  });
});

describe('tildify', () => {
  it('replaces the home directory itself with ~', () => {
    expect(tildify(home)).toBe('~');
  });

  it('replaces a home-directory prefix with ~', () => {
    expect(tildify(path.join(home, 'code'))).toBe('~' + path.sep + 'code');
  });

  it('leaves paths outside the home directory alone', () => {
    const p = path.join(path.sep, 'srv', 'repos');
    expect(tildify(p)).toBe(p);
  });

  it('does not tildify a sibling directory that merely shares the prefix', () => {
    const sibling = home + '-backup';
    expect(tildify(sibling)).toBe(sibling);
  });

  it('matches the home directory case-insensitively on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(tildify(home.toUpperCase() + path.sep + 'code')).toBe('~' + path.sep + 'code');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('getConfig', () => {
  it('returns defaults when nothing is configured', () => {
    const config = getConfig();
    expect(config.directories).toEqual([]);
    expect(config.maxDepth).toBe(4);
    expect(config.exclude).toContain('node_modules');
    expect(config.sortOrder).toBe('recent');
    expect(config.showNestedRepos).toBe(true);
    expect(config.openInNewWindow).toBe(false);
  });

  it('expands and dedupes directories that differ only in form', () => {
    configStore.set('directories', ['~/code', path.join(home, 'code'), '~/code/']);
    expect(getConfig().directories).toEqual([path.join(home, 'code')]);
  });

  it('ignores blank and relative directory entries instead of resolving them against cwd', () => {
    // an empty string is what a hand-edited settings.json most often ends up with; resolving
    // it would scan the extension host's working directory, which is '/' on macOS
    configStore.set('directories', ['', '   ', 'code', './code', '../code', '~/code']);
    expect(getConfig().directories).toEqual([path.join(home, 'code')]);
  });

  it('ignores entries that are not strings', () => {
    configStore.set('directories', [42, null, { path: '~/code' }, '~/code']);
    expect(getConfig().directories).toEqual([path.join(home, 'code')]);
  });

  it('keeps ~ and absolute entries in every accepted form', () => {
    // absPath gives a drive-letter path on Windows; a bare `\srv\repos` passes isAbsolute
    // there but path.resolve still prefixes the current drive, so the two would not match
    const abs = absPath('/srv/repos');
    configStore.set('directories', ['~', '~/code', '~\\other', abs]);
    expect(getConfig().directories).toEqual([
      home,
      path.join(home, 'code'),
      path.resolve(home, 'other'),
      abs,
    ]);
  });

  it('applies the same filtering to hiddenRepos', () => {
    configStore.set('hiddenRepos', ['', 'alpha', 7, '~/code/alpha']);
    expect(getConfig().hiddenRepos).toEqual([path.join(home, 'code', 'alpha')]);
  });
});

describe('addDirectories', () => {
  it('appends new directories tildified', async () => {
    configStore.set('directories', ['~/code']);
    await addDirectories([path.join(home, 'projects')]);
    expect(configStore.get('directories')).toEqual(['~/code', '~' + path.sep + 'projects']);
  });

  it('skips directories already present in another form', async () => {
    configStore.set('directories', ['~/code']);
    await addDirectories([path.join(home, 'code')]);
    expect(configStore.get('directories')).toEqual(['~/code']);
  });
});

describe('removeDirectory', () => {
  it('removes entries matching the expanded path in any stored form', async () => {
    configStore.set('directories', ['~/code', path.join(home, 'code'), '~/other']);
    await removeDirectory(path.join(home, 'code'));
    expect(configStore.get('directories')).toEqual(['~/other']);
  });

  it('leaves the list alone when the path is not configured', async () => {
    configStore.set('directories', ['~/code']);
    await removeDirectory(path.join(home, 'elsewhere'));
    expect(configStore.get('directories')).toEqual(['~/code']);
  });
});

describe('hideRepo', () => {
  it('appends the repo tildified', async () => {
    await hideRepo(path.join(home, 'code', 'alpha'));
    expect(configStore.get('hiddenRepos')).toEqual(['~' + path.sep + path.join('code', 'alpha')]);
  });

  it('keeps repos hidden earlier', async () => {
    configStore.set('hiddenRepos', ['~/code/alpha']);
    await hideRepo(path.join(home, 'code', 'beta'));
    expect(configStore.get('hiddenRepos')).toHaveLength(2);
  });

  it('does nothing when the repo is already hidden in another form', async () => {
    configStore.set('hiddenRepos', ['~/code/alpha']);
    await hideRepo(path.join(home, 'code', 'alpha'));
    expect(configStore.get('hiddenRepos')).toEqual(['~/code/alpha']);
  });
});

describe('writing where the workspace supplies the value', () => {
  // VS Code resolves a setting workspace-first, so a write to the global scope while the
  // workspace scope holds a value changes nothing the user can see: the tree keeps
  // rendering the workspace value and the command looks broken
  const workspaceStore = state.workspaceConfig;

  it('adds a directory to the workspace list that is in effect', async () => {
    configStore.set('directories', ['~/global']);
    workspaceStore.set('directories', ['~/work']);
    await addDirectories([path.join(home, 'projects')]);
    expect(workspaceStore.get('directories')).toEqual(['~/work', '~' + path.sep + 'projects']);
    expect(configStore.get('directories')).toEqual(['~/global']);
    expect(getConfig().directories).toContain(path.join(home, 'projects'));
  });

  it('removes a directory from every scope that lists it', async () => {
    configStore.set('directories', ['~/code', '~/global']);
    workspaceStore.set('directories', ['~/code', '~/work']);
    await removeDirectory(path.join(home, 'code'));
    expect(workspaceStore.get('directories')).toEqual(['~/work']);
    expect(configStore.get('directories')).toEqual(['~/global']);
  });

  it('hides a repo in the workspace list that is in effect', async () => {
    workspaceStore.set('hiddenRepos', []);
    await hideRepo(path.join(home, 'code', 'alpha'));
    expect(workspaceStore.get('hiddenRepos')).toEqual([
      '~' + path.sep + path.join('code', 'alpha'),
    ]);
    expect(configStore.has('hiddenRepos')).toBe(false);
    expect(getConfig().hiddenRepos).toEqual([path.join(home, 'code', 'alpha')]);
  });

  it('unhides everything by clearing both scopes', async () => {
    configStore.set('hiddenRepos', ['~/code/alpha']);
    workspaceStore.set('hiddenRepos', ['~/code/beta']);
    await unhideAllRepos();
    expect(workspaceStore.has('hiddenRepos')).toBe(false);
    expect(configStore.has('hiddenRepos')).toBe(false);
    expect(getConfig().hiddenRepos).toEqual([]);
  });

  it('sets the sort order and grouping in the scope that is in effect', async () => {
    workspaceStore.set('sortOrder', 'alphabetical');
    workspaceStore.set('groupByFolder', true);
    await setSortOrder('recent');
    await setGroupByFolder(false);
    expect(workspaceStore.get('sortOrder')).toBe('recent');
    expect(workspaceStore.get('groupByFolder')).toBe(false);
    expect(configStore.has('sortOrder')).toBe(false);
    expect(getConfig().sortOrder).toBe('recent');
    expect(getConfig().groupByFolder).toBe(false);
  });

  it('falls back to the global scope when only it holds a value', async () => {
    configStore.set('sortOrder', 'alphabetical');
    await setSortOrder('recent');
    expect(configStore.get('sortOrder')).toBe('recent');
    expect(workspaceStore.has('sortOrder')).toBe(false);
  });

  it('writes globally in an untrusted workspace, whose workspace values VS Code ignores', async () => {
    state.workspaceTrusted = false;
    workspaceStore.set('sortOrder', 'alphabetical');
    await setSortOrder('recent');
    expect(configStore.get('sortOrder')).toBe('recent');
    expect(workspaceStore.get('sortOrder')).toBe('alphabetical');
  });
});

describe('unhideAllRepos', () => {
  it('clears the setting rather than writing an empty list', async () => {
    configStore.set('hiddenRepos', ['~/code/alpha']);
    await unhideAllRepos();
    // undefined resets to the package.json default instead of shadowing it
    expect(configStore.has('hiddenRepos')).toBe(false);
  });
});

describe('view-state writers', () => {
  it('sets each sort order', async () => {
    await setSortOrder('alphabetical');
    expect(configStore.get('sortOrder')).toBe('alphabetical');
    await setSortOrder('recent');
    expect(configStore.get('sortOrder')).toBe('recent');
  });

  it('sets grouping on and off', async () => {
    await setGroupByFolder(true);
    expect(configStore.get('groupByFolder')).toBe(true);
    await setGroupByFolder(false);
    expect(configStore.get('groupByFolder')).toBe(false);
  });
});
