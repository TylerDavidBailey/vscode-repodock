import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addDirectories,
  expandPath,
  getConfig,
  removeDirectory,
  tildify,
} from '../../src/ext/settings';

// minimal stateful stand-in for vscode.workspace.getConfiguration('repodock')
const { configStore } = vi.hoisted(() => ({ configStore: new Map<string, unknown>() }));
vi.mock('vscode', () => ({
  ConfigurationTarget: { Global: 1 },
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
}));

beforeEach(() => {
  configStore.clear();
});

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
});
