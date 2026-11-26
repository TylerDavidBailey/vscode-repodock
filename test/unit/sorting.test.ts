import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareByName,
  dedupeRepos,
  filterHiddenRepos,
  filterNestedRepos,
  formatRelativeTime,
  groupReposByRoot,
  pinnedRepos,
  repoLabels,
  sameRepoList,
  sortByRecency,
} from '../../src/core/sorting';
import type { RepoInfo } from '../../src/core/types';

const ROOT = '/home/user/repos';

function makeRepo(relPath: string, parentRepoPath?: string): RepoInfo {
  const name = relPath === '' ? 'repos' : (relPath.split('/').pop() ?? relPath);
  return {
    name,
    path: relPath === '' ? ROOT : `${ROOT}/${relPath}`,
    root: ROOT,
    relPath,
    parentRepoPath,
  };
}

describe('repoLabels', () => {
  /**
   * A repo at `repoPath` found under the scan root `root`. Written POSIX-style and stored
   * with the platform's separator, which is what the scanner produces and what the label
   * code splits on.
   */
  function repoAt(repoPath: string, root: string): RepoInfo {
    const native = (posixPath: string) => posixPath.split('/').join(path.sep);
    return {
      name: repoPath.split('/').pop() ?? repoPath,
      path: native(repoPath),
      root: native(root),
      relPath: repoPath === root ? '' : repoPath.slice(root.length + 1),
    };
  }
  const labelsOf = (repos: RepoInfo[]) => repos.map((repo) => repoLabels(repos).get(repo.path));

  it('labels a repo by its bare name however deep it sits, while names are distinct', () => {
    const repos = [
      makeRepo('sandbox'),
      makeRepo('clients/acme/api'),
      makeRepo('todo'),
      makeRepo(''),
    ];
    expect(labelsOf(repos)).toEqual(['sandbox', 'api', 'todo', 'repos']);
  });

  it('names the folder of same-named repos inside one scan root', () => {
    // built with repoAt, not makeRepo: telling the folders apart splits paths on the
    // platform's own separator, and makeRepo writes them with '/' everywhere
    const root = '/home/user/repos';
    const repos = [
      repoAt(`${root}/sandbox`, root),
      repoAt(`${root}/labs/sandbox`, root),
      repoAt(`${root}/todo`, root),
    ];
    expect(labelsOf(repos)).toEqual(['sandbox (repos)', 'sandbox (labs)', 'todo']);
  });

  it('names the folder of same-named repos found under different scan roots', () => {
    const repos = [
      repoAt('/home/user/work/web-app', '/home/user/work'),
      repoAt('/home/user/personal/web-app', '/home/user/personal'),
      repoAt('/home/user/work/api', '/home/user/work'),
    ];
    expect(labelsOf(repos)).toEqual(['web-app (work)', 'web-app (personal)', 'api']);
  });

  it('goes up as many levels as it takes when the folders share a name too', () => {
    const repos = [
      repoAt('/home/user/acme/src/web-app', '/home/user/acme/src'),
      repoAt('/home/user/globex/src/web-app', '/home/user/globex/src'),
      repoAt('/home/user/other/web-app', '/home/user/other'),
    ];
    expect(labelsOf(repos)).toEqual([
      'web-app (acme/src)',
      'web-app (globex/src)',
      'web-app (user/other)',
    ]);
  });

  it('keeps climbing past folders that match, as far as the scan roots', () => {
    const repos = [
      repoAt('/home/user/work/api/vendor/sdk', '/home/user/work'),
      repoAt('/home/user/personal/api/vendor/sdk', '/home/user/personal'),
    ];
    expect(labelsOf(repos)).toEqual(['sdk (work/api/vendor)', 'sdk (personal/api/vendor)']);
  });

  it('tells a scan root that is itself a repo from a same-named repo elsewhere', () => {
    const repos = [
      repoAt('/home/user/solo/web-app', '/home/user/solo/web-app'),
      repoAt('/home/user/work/web-app', '/home/user/work'),
    ];
    expect(labelsOf(repos)).toEqual(['web-app (solo)', 'web-app (work)']);
  });

  it('leaves a repo at the file system root unqualified', () => {
    const repos = [repoAt('/web-app', '/'), repoAt('/srv/web-app', '/srv')];
    expect(labelsOf(repos)).toEqual(['web-app', 'web-app (srv)']);
  });

  it('terminates on a list that holds the same path twice', () => {
    const repo = repoAt('/home/user/work/web-app', '/home/user/work');
    expect(repoLabels([repo, { ...repo }]).get(repo.path)).toBe('web-app (home/user/work)');
  });
});

describe('sameRepoList', () => {
  it('is true for equal lists, including empty ones', () => {
    expect(
      sameRepoList(
        [makeRepo('alpha'), makeRepo('sub/beta')],
        [makeRepo('alpha'), makeRepo('sub/beta')],
      ),
    ).toBe(true);
    expect(sameRepoList([], [])).toBe(true);
  });

  it('is false when length, order, or any repo field differs', () => {
    const a = [makeRepo('alpha'), makeRepo('sub/beta')];
    expect(sameRepoList(a, [makeRepo('alpha')])).toBe(false);
    expect(sameRepoList(a, [makeRepo('sub/beta'), makeRepo('alpha')])).toBe(false);
    expect(sameRepoList(a, [makeRepo('alpha'), makeRepo('sub/beta', `${ROOT}/sub`)])).toBe(false);
  });
});

describe('filterNestedRepos', () => {
  const outer = makeRepo('outer');
  const inner = makeRepo('outer/inner', `${ROOT}/outer`);

  it('returns the same list when nested repos are shown', () => {
    const repos = [outer, inner];
    expect(filterNestedRepos(repos, true)).toBe(repos);
  });

  it('drops repos carrying a parent when nested repos are hidden', () => {
    expect(filterNestedRepos([outer, inner], false)).toEqual([outer]);
  });
});

describe('dedupeRepos', () => {
  it('keeps the occurrence with the shortest relative path when roots overlap', () => {
    const fromOuter = makeRepo('sub/beta');
    const fromInner: RepoInfo = {
      name: 'beta',
      path: `${ROOT}/sub/beta`,
      root: `${ROOT}/sub`,
      relPath: 'beta',
    };
    expect(dedupeRepos([fromOuter, fromInner])).toEqual([fromInner]);
    expect(dedupeRepos([fromInner, fromOuter])).toEqual([fromInner]);
  });

  it('leaves distinct repos alone', () => {
    const repos = [makeRepo('alpha'), makeRepo('beta')];
    expect(dedupeRepos(repos)).toEqual(repos);
  });

  it('collapses paths differing only in case on a case-insensitive filesystem', () => {
    // two roots can reach one repo through different casing; on macOS and Windows that
    // is a single directory, so keying on the raw path would render it twice
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const lower: RepoInfo = { name: 'api', path: '/code/api', root: '/code', relPath: 'api' };
      const upper: RepoInfo = { name: 'api', path: '/Code/API', root: '/Code', relPath: 'api' };
      expect(dedupeRepos([lower, upper])).toEqual([lower]);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('groupReposByRoot', () => {
  const OTHER = '/home/user/other';
  const makeOtherRepo = (relPath: string): RepoInfo => ({
    name: relPath.split('/').pop() ?? relPath,
    path: `${OTHER}/${relPath}`,
    root: OTHER,
    relPath,
  });

  it('returns no groups for an empty repo list', () => {
    expect(groupReposByRoot([], [ROOT, OTHER])).toEqual([]);
  });

  it('splits repos into one group per root, in the configured folder order', () => {
    const repos = [makeOtherRepo('zeta'), makeRepo('alpha'), makeRepo('gamma')];
    const groups = groupReposByRoot(repos, [ROOT, OTHER]);
    expect(groups.map((group) => group.root)).toEqual([ROOT, OTHER]);
    expect(groups.map((group) => group.repos.map((repo) => repo.name))).toEqual([
      ['alpha', 'gamma'],
      ['zeta'],
    ]);
  });

  it('files an overlap-deduped repo under the inner root only', () => {
    // beta sits under both ROOT and ROOT/sub; dedupe keeps the inner occurrence,
    // so grouping shows it once, in the more specific folder's section
    const inner = `${ROOT}/sub`;
    const fromOuter = makeRepo('sub/beta');
    const fromInner: RepoInfo = {
      name: 'beta',
      path: `${ROOT}/sub/beta`,
      root: inner,
      relPath: 'beta',
    };
    const deduped = dedupeRepos([fromOuter, fromInner, makeRepo('alpha')]);
    const groups = groupReposByRoot(deduped, [ROOT, inner]);
    expect(groups.map((group) => group.root)).toEqual([ROOT, inner]);
    expect(groups.map((group) => group.repos.map((repo) => repo.name))).toEqual([
      ['alpha'],
      ['beta'],
    ]);
  });

  it('places roots missing from the configured order last', () => {
    const groups = groupReposByRoot([makeRepo('alpha'), makeOtherRepo('zeta')], [OTHER]);
    expect(groups.map((group) => group.root)).toEqual([OTHER, ROOT]);
  });
});

describe('compareByName', () => {
  it('orders by repo name, not by the folders above it', () => {
    const repos = [makeRepo('zeta'), makeRepo('sub/beta'), makeRepo('alpha')];
    expect(repos.sort(compareByName).map((repo) => repo.name)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('settles same-named repos by path, so their order never depends on scan order', () => {
    const twins = [makeRepo('sandbox'), makeRepo('labs/sandbox')];
    expect(twins.sort(compareByName).map((repo) => repo.relPath)).toEqual([
      'labs/sandbox',
      'sandbox',
    ]);
    expect(
      twins
        .reverse()
        .sort(compareByName)
        .map((repo) => repo.relPath),
    ).toEqual(['labs/sandbox', 'sandbox']);
  });
});

describe('pinnedRepos', () => {
  const repos = [makeRepo('gamma'), makeRepo('alpha'), makeRepo('sub/beta')];
  const names = (list: RepoInfo[]) => list.map((repo) => repo.name);

  it('keeps only pinned repos, in name order', () => {
    const pinned = new Set([`${ROOT}/gamma`, `${ROOT}/sub/beta`]);
    expect(names(pinnedRepos(repos, pinned))).toEqual(['beta', 'gamma']);
  });

  it('is empty when nothing is pinned', () => {
    expect(pinnedRepos(repos, new Set())).toEqual([]);
  });

  it('ignores a pin whose repo is no longer in the list', () => {
    // a pinned repo that was deleted, hidden, or moved out of the scanned folders
    expect(pinnedRepos(repos, new Set([`${ROOT}/gone`]))).toEqual([]);
  });

  it('leaves the list it was given untouched', () => {
    const before = names(repos);
    pinnedRepos(repos, new Set(repos.map((repo) => repo.path)));
    expect(names(repos)).toEqual(before);
  });
});

describe('sortByRecency', () => {
  const repos = [makeRepo('gamma'), makeRepo('alpha'), makeRepo('sub/beta'), makeRepo('never')];
  const names = (list: RepoInfo[]) => list.map((repo) => repo.name);
  const recency = new Map([
    [`${ROOT}/alpha`, 1000],
    [`${ROOT}/sub/beta`, 3000],
    [`${ROOT}/gamma`, 2000],
  ]);

  it('orders by last opened, newest first, then lists the never-opened repos by name', () => {
    const more = [...repos, makeRepo('another')];
    expect(names(sortByRecency(more, recency))).toEqual([
      'beta',
      'gamma',
      'alpha',
      'another',
      'never',
    ]);
  });

  it('lists everything by name when nothing has been opened', () => {
    expect(names(sortByRecency(repos, new Map()))).toEqual(['alpha', 'beta', 'gamma', 'never']);
  });

  it('ignores a timestamp whose repo is no longer in the list', () => {
    const stale = new Map([[`${ROOT}/gone`, 5000]]);
    expect(names(sortByRecency(repos, stale))).toEqual(['alpha', 'beta', 'gamma', 'never']);
  });

  it('breaks a tie in open time by name', () => {
    const tied = new Map([
      [`${ROOT}/gamma`, 1000],
      [`${ROOT}/alpha`, 1000],
    ]);
    expect(names(sortByRecency(repos, tied))).toEqual(['alpha', 'gamma', 'beta', 'never']);
  });

  it('puts a repo opened at timestamp zero ahead of one never opened', () => {
    const zero = new Map([[`${ROOT}/never`, 0]]);
    expect(names(sortByRecency(repos, zero))).toEqual(['never', 'alpha', 'beta', 'gamma']);
  });

  it('leaves the list it was given untouched', () => {
    const before = names(repos);
    sortByRecency(repos, recency);
    expect(names(repos)).toEqual(before);
  });

  it('matches canonically-keyed pins and recency despite path casing on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const win = (name: string): RepoInfo => ({
        name,
        path: `C:\\Repos\\${name}`,
        root: 'C:\\Repos',
        relPath: name,
      });
      const list = [win('alpha'), win('beta'), win('gamma')];
      expect(names(pinnedRepos(list, new Set(['c:\\repos\\gamma'])))).toEqual(['gamma']);
      expect(names(sortByRecency(list, new Map([['c:\\repos\\beta', 2000]])))).toEqual([
        'beta',
        'alpha',
        'gamma',
      ]);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('filterHiddenRepos', () => {
  it('returns the list untouched when nothing is hidden', () => {
    const repos = [makeRepo('alpha'), makeRepo('beta')];
    expect(filterHiddenRepos(repos, [])).toBe(repos);
  });

  it('drops hidden repos', () => {
    const repos = [makeRepo('alpha'), makeRepo('beta')];
    expect(filterHiddenRepos(repos, [`${ROOT}/alpha`]).map((repo) => repo.name)).toEqual(['beta']);
  });

  it('drops repos nested inside a hidden repo, transitively', () => {
    const repos = [
      makeRepo('outer'),
      makeRepo('outer/mid', `${ROOT}/outer`),
      makeRepo('outer/mid/inner', `${ROOT}/outer/mid`),
      makeRepo('other'),
    ];
    expect(filterHiddenRepos(repos, [`${ROOT}/outer`]).map((repo) => repo.name)).toEqual(['other']);
  });

  it('drops a nested repo listed by an overlapping root with no parent chain', () => {
    // ROOT/outer/mid is also a scan root, so its copy of inner carries no parentRepoPath
    const viaOverlap: RepoInfo = {
      name: 'inner',
      path: `${ROOT}/outer/mid/inner`,
      root: `${ROOT}/outer/mid`,
      relPath: 'inner',
    };
    const repos = [makeRepo('outer'), viaOverlap, makeRepo('other')];
    expect(filterHiddenRepos(repos, [`${ROOT}/outer`]).map((repo) => repo.name)).toEqual(['other']);
  });

  it('does not hide a sibling that merely shares the path prefix', () => {
    const repos = [makeRepo('outer'), makeRepo('out')];
    expect(filterHiddenRepos(repos, [`${ROOT}/out`]).map((repo) => repo.name)).toEqual(['outer']);
  });

  it('matches hidden entries case-insensitively on Windows', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const repos: RepoInfo[] = [
        { name: 'alpha', path: 'C:\\Code\\alpha', root: 'C:\\Code', relPath: 'alpha' },
      ];
      expect(filterHiddenRepos(repos, ['c:\\code\\alpha'])).toEqual([]);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

// a fixed `now` keeps the boundary cases below exact rather than clock-dependent
const NOW = Date.UTC(2026, 6, 14, 12, 0, 0);
const MINUTE = 60 * 1000;
const HOUR = 3600 * 1000;
const DAY = 86400 * 1000;

describe('formatRelativeTime', () => {
  const now = NOW;
  const cases: [string, number, string][] = [
    ['zero elapsed', now, 'just now'],
    ['a future timestamp (clock skew)', now + MINUTE, 'just now'],
    ['59 seconds', now - 59 * 1000, 'just now'],
    ['exactly one minute', now - MINUTE, '1m ago'],
    ['five minutes', now - 5 * MINUTE, '5m ago'],
    ['59 minutes', now - 59 * MINUTE, '59m ago'],
    ['exactly one hour', now - HOUR, '1h ago'],
    ['23 hours', now - 23 * HOUR, '23h ago'],
    ['exactly one day', now - 24 * HOUR, 'yesterday'],
    ['30 hours', now - 30 * HOUR, 'yesterday'],
    ['two days', now - 2 * DAY, '2d ago'],
    ['six days', now - 6 * DAY, '6d ago'],
    ['exactly one week', now - 7 * DAY, '1w ago'],
    ['34 days', now - 34 * DAY, '4w ago'],
    ['35 days', now - 35 * DAY, '1mo ago'],
    ['362 days', now - 362 * DAY, '12mo ago'],
    ['exactly one year', now - 365 * DAY, '1y ago'],
    ['400 days', now - 400 * DAY, '1y ago'],
    ['a decade', now - 3650 * DAY, '10y ago'],
  ];
  it.each(cases)('formats %s as %s', (_description, timestamp, expected) => {
    expect(formatRelativeTime(timestamp, now)).toBe(expected);
  });
});
