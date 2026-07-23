import { describe, expect, it } from 'vitest';
import {
  dedupeRepos,
  filterHiddenRepos,
  formatCompactRelativeTime,
  formatRelativeTime,
  groupReposByRoot,
  repoLabel,
  repoPrefix,
  sameRepoList,
  sortRepos,
} from '../../src/core/sorting';
import type { RepoInfo } from '../../src/core/types';

const ROOT = '/home/user/repos';

function repo(relPath: string, parentRepoPath?: string): RepoInfo {
  const name = relPath === '' ? 'repos' : (relPath.split('/').pop() ?? relPath);
  return {
    name,
    path: relPath === '' ? ROOT : `${ROOT}/${relPath}`,
    root: ROOT,
    relPath,
    parentRepoPath,
  };
}

describe('repoPrefix', () => {
  it('returns the parent path with a trailing slash for repos below the top level', () => {
    expect(repoPrefix(repo('clients/acme/api'))).toBe('clients/acme/');
  });

  it('is empty for top-level repos and the scan root itself', () => {
    expect(repoPrefix(repo('todo'))).toBe('');
    expect(repoPrefix(repo(''))).toBe('');
  });
});

describe('repoLabel', () => {
  it('qualifies the name with its parent path in parentheses', () => {
    expect(repoLabel(repo('abc/ginkgo'))).toBe('ginkgo (abc)');
    expect(repoLabel(repo('clients/acme/api'))).toBe('api (clients/acme)');
  });

  it('is just the name for top-level repos and the scan root itself', () => {
    expect(repoLabel(repo('ginkgo'))).toBe('ginkgo');
    expect(repoLabel(repo(''))).toBe('repos');
  });
});

describe('sameRepoList', () => {
  it('is true for equal lists, including empty ones', () => {
    expect(sameRepoList([repo('alpha'), repo('sub/beta')], [repo('alpha'), repo('sub/beta')])).toBe(
      true,
    );
    expect(sameRepoList([], [])).toBe(true);
  });

  it('is false when length, order, or any repo field differs', () => {
    const a = [repo('alpha'), repo('sub/beta')];
    expect(sameRepoList(a, [repo('alpha')])).toBe(false);
    expect(sameRepoList(a, [repo('sub/beta'), repo('alpha')])).toBe(false);
    expect(sameRepoList(a, [repo('alpha'), repo('sub/beta', `${ROOT}/sub`)])).toBe(false);
  });
});

describe('dedupeRepos', () => {
  it('keeps the occurrence with the shortest relative path when roots overlap', () => {
    const fromOuter = repo('sub/beta');
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
    const repos = [repo('alpha'), repo('beta')];
    expect(dedupeRepos(repos)).toEqual(repos);
  });
});

describe('groupReposByRoot', () => {
  const OTHER = '/home/user/other';
  const otherRepo = (relPath: string): RepoInfo => ({
    name: relPath.split('/').pop() ?? relPath,
    path: `${OTHER}/${relPath}`,
    root: OTHER,
    relPath,
  });

  it('splits repos into one group per root, in the configured folder order', () => {
    const repos = [otherRepo('zeta'), repo('alpha'), repo('gamma')];
    const groups = groupReposByRoot(repos, [ROOT, OTHER]);
    expect(groups.map((g) => g.root)).toEqual([ROOT, OTHER]);
    expect(groups.map((g) => g.repos.map((r) => r.name))).toEqual([['alpha', 'gamma'], ['zeta']]);
  });

  it('files an overlap-deduped repo under the inner root only', () => {
    // beta sits under both ROOT and ROOT/sub; dedupe keeps the inner occurrence,
    // so grouping shows it once, in the more specific folder's section
    const inner = `${ROOT}/sub`;
    const fromOuter = repo('sub/beta');
    const fromInner: RepoInfo = {
      name: 'beta',
      path: `${ROOT}/sub/beta`,
      root: inner,
      relPath: 'beta',
    };
    const deduped = dedupeRepos([fromOuter, fromInner, repo('alpha')]);
    const groups = groupReposByRoot(deduped, [ROOT, inner]);
    expect(groups.map((g) => g.root)).toEqual([ROOT, inner]);
    expect(groups.map((g) => g.repos.map((r) => r.name))).toEqual([['alpha'], ['beta']]);
  });

  it('places roots missing from the configured order last', () => {
    const groups = groupReposByRoot([repo('alpha'), otherRepo('zeta')], [OTHER]);
    expect(groups.map((g) => g.root)).toEqual([OTHER, ROOT]);
  });
});

describe('sortRepos', () => {
  const repos = [repo('gamma'), repo('alpha'), repo('sub/beta')];
  const none = new Set<string>();
  const names = (list: RepoInfo[]) => list.map((r) => r.name);

  it('orders by recency, falling back to name', () => {
    const recency = new Map([[`${ROOT}/sub/beta`, 2000]]);
    expect(names(sortRepos(repos, 'recent', recency, none))).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('orders purely by name when alphabetical, ignoring the folder prefix', () => {
    const recency = new Map([[`${ROOT}/gamma`, 2000]]);
    // sub/beta sorts as "beta", not under "s"
    expect(names(sortRepos(repos, 'alphabetical', recency, none))).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('keeps same-named repos adjacent, tie-broken by their relative path', () => {
    const twins = [repo('ginkgo'), repo('abc/ginkgo')];
    expect(sortRepos(twins, 'alphabetical', new Map(), none).map((r) => r.relPath)).toEqual([
      'abc/ginkgo',
      'ginkgo',
    ]);
  });

  it('floats pinned repos above everything, in both orders', () => {
    const pinned = new Set([`${ROOT}/gamma`]);
    const recency = new Map([[`${ROOT}/alpha`, 2000]]);
    expect(names(sortRepos(repos, 'recent', recency, pinned))).toEqual(['gamma', 'alpha', 'beta']);
    expect(names(sortRepos(repos, 'alphabetical', recency, pinned))).toEqual([
      'gamma',
      'alpha',
      'beta',
    ]);
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
      const pinned = new Set(['c:\\repos\\gamma']);
      const recency = new Map([['c:\\repos\\beta', 2000]]);
      expect(names(sortRepos(list, 'recent', recency, pinned))).toEqual(['gamma', 'beta', 'alpha']);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('filterHiddenRepos', () => {
  it('returns the list untouched when nothing is hidden', () => {
    const repos = [repo('alpha'), repo('beta')];
    expect(filterHiddenRepos(repos, [])).toBe(repos);
  });

  it('drops hidden repos', () => {
    const repos = [repo('alpha'), repo('beta')];
    expect(filterHiddenRepos(repos, [`${ROOT}/alpha`]).map((r) => r.name)).toEqual(['beta']);
  });

  it('drops repos nested inside a hidden repo, transitively', () => {
    const repos = [
      repo('outer'),
      repo('outer/mid', `${ROOT}/outer`),
      repo('outer/mid/inner', `${ROOT}/outer/mid`),
      repo('other'),
    ];
    expect(filterHiddenRepos(repos, [`${ROOT}/outer`]).map((r) => r.name)).toEqual(['other']);
  });

  it('drops a nested repo listed by an overlapping root with no parent chain', () => {
    // ROOT/outer/mid is also a scan root, so its copy of inner carries no parentRepoPath
    const viaOverlap: RepoInfo = {
      name: 'inner',
      path: `${ROOT}/outer/mid/inner`,
      root: `${ROOT}/outer/mid`,
      relPath: 'inner',
    };
    const repos = [repo('outer'), viaOverlap, repo('other')];
    expect(filterHiddenRepos(repos, [`${ROOT}/outer`]).map((r) => r.name)).toEqual(['other']);
  });

  it('does not hide a sibling that merely shares the path prefix', () => {
    const repos = [repo('outer'), repo('out')];
    expect(filterHiddenRepos(repos, [`${ROOT}/out`]).map((r) => r.name)).toEqual(['outer']);
  });
});

describe('formatRelativeTime', () => {
  const now = Date.UTC(2026, 6, 14, 12, 0, 0);
  const MINUTE = 60 * 1000;
  const HOUR = 3600 * 1000;
  const DAY = 86400 * 1000;
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

describe('formatCompactRelativeTime', () => {
  const now = Date.UTC(2026, 6, 14, 12, 0, 0);
  const MINUTE = 60 * 1000;
  const HOUR = 3600 * 1000;
  const DAY = 86400 * 1000;
  const cases: [string, number, string][] = [
    ['zero elapsed', now, 'now'],
    ['a future timestamp (clock skew)', now + MINUTE, 'now'],
    ['five minutes', now - 5 * MINUTE, '5m'],
    ['23 hours', now - 23 * HOUR, '23h'],
    ['30 hours', now - 30 * HOUR, '1d'],
    ['six days', now - 6 * DAY, '6d'],
    ['34 days', now - 34 * DAY, '4w'],
    ['35 days', now - 35 * DAY, '1mo'],
    ['400 days', now - 400 * DAY, '1y'],
  ];
  it.each(cases)('formats %s as %s', (_description, timestamp, expected) => {
    expect(formatCompactRelativeTime(timestamp, now)).toBe(expected);
  });
});
