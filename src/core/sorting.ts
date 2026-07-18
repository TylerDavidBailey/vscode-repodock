import * as path from 'node:path';
import { canonicalPathKey } from './paths';
import type { RepoInfo } from './types';

export type SortOrder = 'recent' | 'alphabetical';

/**
 * Parent path of the repo inside its scan root, with a trailing slash
 * ("abc/" for abc/ginkgo). Empty for top-level repos and the root itself.
 */
export function repoPrefix(repo: RepoInfo): string {
  const i = repo.relPath.lastIndexOf('/');
  return i === -1 ? '' : repo.relPath.slice(0, i + 1);
}

/**
 * Display label: the repo name, plus its parent path in parentheses when it has
 * one ("ginkgo (abc)") to tell same-named repos apart.
 */
export function repoLabel(repo: RepoInfo): string {
  const prefix = repoPrefix(repo);
  return prefix === '' ? repo.name : `${repo.name} (${prefix.slice(0, -1)})`;
}

/**
 * Drops hidden repositories from a scan result. Hiding a repo also hides every repo
 * inside its directory, which would otherwise dangle without a parent in the grouped
 * view. Matching by path prefix (instead of walking parentRepoPath chains) also
 * catches duplicates from overlapping scan roots, which may carry no parent chain.
 */
export function filterHiddenRepos(repos: RepoInfo[], hiddenPaths: Iterable<string>): RepoInfo[] {
  const hidden = [...hiddenPaths].map(canonicalPathKey);
  if (hidden.length === 0) return repos;
  return repos.filter((repo) => {
    const key = canonicalPathKey(repo.path);
    return !hidden.some((h) => key === h || key.startsWith(h + path.sep));
  });
}

/**
 * One entry per repo path. Overlapping scan roots find the same repo twice under
 * different relative paths; the occurrence with the shortest one wins.
 */
export function dedupeRepos(repos: RepoInfo[]): RepoInfo[] {
  const byPath = new Map<string, RepoInfo>();
  for (const repo of repos) {
    const existing = byPath.get(repo.path);
    if (!existing || repo.relPath.length < existing.relPath.length) {
      byPath.set(repo.path, repo);
    }
  }
  return [...byPath.values()];
}

export interface RepoGroup {
  /** Absolute path of the scan root, as carried by the repos in the group. */
  root: string;
  repos: RepoInfo[];
}

/**
 * Splits a deduped repo list into one group per scan root, following the configured
 * folder order (roots not in it go last, by path). Call after dedupeRepos so each
 * repo lands in exactly one group.
 */
export function groupReposByRoot(repos: RepoInfo[], rootOrder: readonly string[]): RepoGroup[] {
  const byRoot = new Map<string, RepoGroup>();
  for (const repo of repos) {
    const key = canonicalPathKey(repo.root);
    const group = byRoot.get(key);
    if (group) {
      group.repos.push(repo);
    } else {
      byRoot.set(key, { root: repo.root, repos: [repo] });
    }
  }
  const order = rootOrder.map(canonicalPathKey);
  const rank = (group: RepoGroup): number => {
    const index = order.indexOf(canonicalPathKey(group.root));
    return index === -1 ? order.length : index;
  };
  return [...byRoot.values()].sort((a, b) => rank(a) - rank(b) || a.root.localeCompare(b.root));
}

/**
 * Orders the flat list: pinned repos first, then the rest; each group by most recently
 * opened (falling back to name) or purely by name. Name sorting compares the repo name
 * first and relPath second, so same-named repos end up next to each other. `recency`
 * and `pinned` are keyed by canonical path key.
 */
export function sortRepos(
  repos: RepoInfo[],
  order: SortOrder,
  recency: ReadonlyMap<string, number>,
  pinned: ReadonlySet<string>,
): RepoInfo[] {
  const byName = (a: RepoInfo, b: RepoInfo) =>
    a.name.localeCompare(b.name) || a.relPath.localeCompare(b.relPath);
  const openedAt = (r: RepoInfo) => recency.get(canonicalPathKey(r.path)) ?? 0;
  const cmp =
    order === 'recent'
      ? (a: RepoInfo, b: RepoInfo) => openedAt(b) - openedAt(a) || byName(a, b)
      : byName;
  const sorted = repos.slice().sort(cmp);
  return [
    ...sorted.filter((r) => pinned.has(canonicalPathKey(r.path))),
    ...sorted.filter((r) => !pinned.has(canonicalPathKey(r.path))),
  ];
}

function relativeTimeParts(
  timestamp: number,
  now: number,
): { value: number; unit: 'now' | 'm' | 'h' | 'd' | 'w' | 'mo' | 'y' } {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return { value: 0, unit: 'now' };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: minutes, unit: 'm' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: 'h' };
  const days = Math.floor(hours / 24);
  if (days < 7) return { value: days, unit: 'd' };
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return { value: weeks, unit: 'w' };
  if (days < 365) return { value: Math.floor(days / 30), unit: 'mo' };
  return { value: Math.floor(days / 365), unit: 'y' };
}

/** Prose form ("5m ago", "yesterday"), used in the tooltip. */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const { value, unit } = relativeTimeParts(timestamp, now);
  if (unit === 'now') return 'just now';
  if (unit === 'd' && value === 1) return 'yesterday';
  return `${value}${unit} ago`;
}

/** Compact form ("5m", "1d"), used in the dim row description. */
export function formatCompactRelativeTime(timestamp: number, now: number = Date.now()): string {
  const { value, unit } = relativeTimeParts(timestamp, now);
  return unit === 'now' ? 'now' : `${value}${unit}`;
}
