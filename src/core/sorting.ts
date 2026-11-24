import * as path from 'node:path';
import { canonicalPathKey } from './paths';
import type { RepoInfo } from './types';

/** Matches the allowed values of the `repodock.sortOrder` setting. */
export type SortOrder = 'recent' | 'alphabetical';

/**
 * Parent path of the repo inside its scan root, with a trailing slash
 * ("abc/" for abc/ginkgo). Empty for top-level repos and the root itself.
 */
export function repoPrefix(repo: RepoInfo): string {
  const lastSlash = repo.relPath.lastIndexOf('/');
  return lastSlash === -1 ? '' : repo.relPath.slice(0, lastSlash + 1);
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
 * The directories above a path, nearest last, as many as `levels` asks for. Joined with
 * '/' on every platform, to match `relPath` and the labels built from it.
 */
function parentContext(p: string, levels: number): string {
  return path.dirname(p).split(path.sep).filter(Boolean).slice(-levels).join('/');
}

/**
 * For paths that would otherwise share a label: the directories above each one, as few
 * levels as it takes to tell them all apart. In the order given.
 */
function distinguishingContexts(paths: readonly string[]): string[] {
  // distinct paths differ somewhere above their last segment, so some depth separates
  // them; the deepest path bounds the search for a list that holds the same path twice
  const deepest = Math.max(...paths.map((p) => p.split(path.sep).length));
  let levels = 1;
  const contexts = () => paths.map((p) => parentContext(p, levels));
  while (levels < deepest && new Set(contexts()).size < paths.length) levels++;
  return contexts();
}

/**
 * Labels for repos listed side by side, keyed by repo path. Each starts as `repoLabel`,
 * which only looks inside the repo's own scan root: two roots holding a same-named repo
 * both yield "web-app", and nothing but the tooltip tells the rows apart. Repos that
 * collide get the directories above them spelled out instead, as many levels as it takes
 * to differ ("web-app (work)" and "web-app (personal)").
 */
export function repoLabels(repos: readonly RepoInfo[]): Map<string, string> {
  const byLabel = new Map<string, RepoInfo[]>();
  for (const repo of repos) {
    const label = repoLabel(repo);
    const sharing = byLabel.get(label);
    if (sharing) {
      sharing.push(repo);
    } else {
      byLabel.set(label, [repo]);
    }
  }

  const labels = new Map<string, string>();
  for (const [label, sharing] of byLabel) {
    if (sharing.length === 1) {
      for (const repo of sharing) labels.set(repo.path, label);
      continue;
    }
    const contexts = distinguishingContexts(sharing.map((repo) => repo.path));
    sharing.forEach((repo, index) => {
      const context = contexts[index] ?? '';
      labels.set(repo.path, context === '' ? repo.name : `${repo.name} (${context})`);
    });
  }
  return labels;
}

/**
 * Labels for scan folders listed side by side, keyed by the folder path as given. Each is
 * the folder's own name, which is the part a person recognizes and the part a narrow
 * sidebar would otherwise cut off the end of the full path. Folders that share a name get
 * the directories above them spelled out, the way `repoLabels` does it ("src (acme)" and
 * "src (globex)"). A path with no name of its own, such as a filesystem root, keeps the
 * whole path.
 */
export function folderLabels(roots: readonly string[]): Map<string, string> {
  const byName = new Map<string, string[]>();
  for (const root of roots) {
    const name = path.basename(root) || root;
    const sharing = byName.get(name);
    if (sharing) {
      sharing.push(root);
    } else {
      byName.set(name, [root]);
    }
  }

  const labels = new Map<string, string>();
  for (const [name, sharing] of byName) {
    if (sharing.length === 1) {
      for (const root of sharing) labels.set(root, name);
      continue;
    }
    const contexts = distinguishingContexts(sharing);
    sharing.forEach((root, index) => {
      const context = contexts[index] ?? '';
      labels.set(root, context === '' ? name : `${name} (${context})`);
    });
  }
  return labels;
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
  // Windows accepts '/' as a separator too; on POSIX a backslash is a filename character
  const separators = path.sep === '\\' ? [path.sep, '/'] : [path.sep];
  return repos.filter((repo) => {
    const key = canonicalPathKey(repo.path);
    return !hidden.some(
      (hiddenKey) =>
        key === hiddenKey || separators.some((separator) => key.startsWith(hiddenKey + separator)),
    );
  });
}

/**
 * Drops repositories sitting inside another repository (submodules, vendored checkouts)
 * when the view is set to hide them, and returns `repos` untouched when it is not.
 * Shared by the tree and the folder manager's repo counts, so a count can never claim
 * repos the tree will not render.
 */
export function filterNestedRepos(repos: RepoInfo[], showNested: boolean): RepoInfo[] {
  return showNested ? repos : repos.filter((repo) => repo.parentRepoPath === undefined);
}

/**
 * One entry per repo path. Overlapping scan roots find the same repo twice under
 * different relative paths; the occurrence with the shortest one wins. Keyed by
 * canonical path key, so two roots that reach the same repo through different casing
 * on a case-insensitive filesystem still collapse to one row.
 */
export function dedupeRepos(repos: RepoInfo[]): RepoInfo[] {
  const byPath = new Map<string, RepoInfo>();
  for (const repo of repos) {
    const key = canonicalPathKey(repo.path);
    const existing = byPath.get(key);
    if (!existing || repo.relPath.length < existing.relPath.length) {
      byPath.set(key, repo);
    }
  }
  return [...byPath.values()];
}

/**
 * Whether two scan results list the same repos in the same order. Scan output is
 * deterministic (per-root path order, roots in configured order), so background
 * rescans that found nothing new compare equal and need no re-render.
 */
export function sameRepoList(a: readonly RepoInfo[], b: readonly RepoInfo[]): boolean {
  return (
    a.length === b.length &&
    a.every((repo, i) => {
      const other = b[i];
      if (other === undefined) return false;
      return (
        repo.path === other.path &&
        repo.root === other.root &&
        repo.relPath === other.relPath &&
        repo.name === other.name &&
        repo.parentRepoPath === other.parentRepoPath
      );
    })
  );
}

/** The repos found under one scan root, rendered as a collapsible section when grouping is on. */
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
 * first and relPath second, so same-named repos end up next to each other. Two scan roots
 * can hold a repo with the same name and relPath; the full path settles those, so their
 * order follows the folder names in their labels rather than the order roots were scanned.
 * `recency` and `pinned` are keyed by canonical path key.
 */
export function sortRepos(
  repos: RepoInfo[],
  order: SortOrder,
  recency: ReadonlyMap<string, number>,
  pinned: ReadonlySet<string>,
): RepoInfo[] {
  const byName = (a: RepoInfo, b: RepoInfo) =>
    a.name.localeCompare(b.name) ||
    a.relPath.localeCompare(b.relPath) ||
    a.path.localeCompare(b.path);
  const openedAt = (repo: RepoInfo) => recency.get(canonicalPathKey(repo.path)) ?? 0;
  const compare =
    order === 'recent'
      ? (a: RepoInfo, b: RepoInfo) => openedAt(b) - openedAt(a) || byName(a, b)
      : byName;
  const sorted = repos.slice().sort(compare);
  return [
    ...sorted.filter((repo) => pinned.has(canonicalPathKey(repo.path))),
    ...sorted.filter((repo) => !pinned.has(canonicalPathKey(repo.path))),
  ];
}

/**
 * Splits an age into the largest unit that still reads naturally: under a minute is 'now',
 * then minutes, hours and days, weeks up to a month, months up to a year, then years.
 * Months and years approximate (30- and 365-day), which is close enough for "last opened".
 */
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
