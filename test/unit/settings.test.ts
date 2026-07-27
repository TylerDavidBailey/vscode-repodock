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
