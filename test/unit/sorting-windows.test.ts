import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// `path.sep` is fixed when node:path loads, so overriding process.platform cannot reach it —
// the win32 branch of filterHiddenRepos is only reachable by faking the separator itself.
vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.win32, default: actual.win32 };
});

import { filterHiddenRepos, folderLabels, repoLabels } from '../../src/core/sorting';
import type { RepoInfo } from '../../src/core/types';

const win = (name: string, path: string, relPath: string): RepoInfo => ({
  name,
  path,
  root: 'C:\\code',
  relPath,
});

let platform: PropertyDescriptor | undefined;

beforeEach(() => {
  platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
});

afterEach(() => {
  if (platform) Object.defineProperty(process, 'platform', platform);
});

describe('filterHiddenRepos on Windows', () => {
  it('hides a nested repo whose path uses a forward slash', () => {
    // Windows accepts '/' as a separator, so a scanned path can mix the two; on POSIX a
    // backslash is an ordinary filename character and must never be treated as a separator
    const repos = [
      win('inner', 'C:\\code\\outer/inner', 'outer/inner'),
      win('other', 'C:\\code\\other', 'other'),
    ];
    expect(filterHiddenRepos(repos, ['C:\\code\\outer']).map((repo) => repo.name)).toEqual([
      'other',
    ]);
  });

  it('hides a nested repo whose path uses a backslash', () => {
    const repos = [
      win('inner', 'C:\\code\\outer\\inner', 'outer/inner'),
      win('other', 'C:\\code\\other', 'other'),
    ];
    expect(filterHiddenRepos(repos, ['C:\\code\\outer']).map((repo) => repo.name)).toEqual([
      'other',
    ]);
  });

  it('still does not hide a sibling that merely shares the prefix', () => {
    const repos = [win('outer2', 'C:\\code\\outer2', 'outer2')];
    expect(filterHiddenRepos(repos, ['C:\\code\\outer']).map((repo) => repo.name)).toEqual([
      'outer2',
    ]);
  });
});

describe('repoLabels on Windows', () => {
  const under = (root: string): RepoInfo => ({
    name: 'web-app',
    path: `${root}\\web-app`,
    root,
    relPath: 'web-app',
  });
  const labelsOf = (repos: RepoInfo[]) => repos.map((repo) => repoLabels(repos).get(repo.path));

  it('reads the folder out of a backslash path and joins levels with a forward slash', () => {
    expect(labelsOf([under('C:\\code\\work'), under('C:\\code\\personal')])).toEqual([
      'web-app (work)',
      'web-app (personal)',
    ]);
    expect(labelsOf([under('C:\\acme\\src'), under('C:\\globex\\src')])).toEqual([
      'web-app (acme/src)',
      'web-app (globex/src)',
    ]);
  });

  it('falls back to the drive when nothing else differs', () => {
    expect(labelsOf([under('C:\\code'), under('D:\\code')])).toEqual([
      'web-app (C:/code)',
      'web-app (D:/code)',
    ]);
  });
});

describe('folderLabels on Windows', () => {
  const labelsOf = (roots: string[]) => roots.map((root) => folderLabels(roots).get(root));

  it('reads the folder name out of a backslash path', () => {
    expect(labelsOf(['C:\\code\\work', 'C:\\code\\personal'])).toEqual(['work', 'personal']);
  });

  it('joins the levels above same-named folders with a forward slash', () => {
    expect(labelsOf(['C:\\acme\\src', 'C:\\globex\\src'])).toEqual(['src (acme)', 'src (globex)']);
    expect(labelsOf(['C:\\code', 'D:\\code'])).toEqual(['code (C:)', 'code (D:)']);
  });

  it('keeps a drive root as it is', () => {
    expect(labelsOf(['C:\\', 'D:\\'])).toEqual(['C:\\', 'D:\\']);
  });
});
