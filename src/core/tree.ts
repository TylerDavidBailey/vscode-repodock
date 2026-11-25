import * as path from 'node:path';
import { canonicalPathKey } from './paths';
import { groupReposByRoot } from './sorting';
import type { RepoInfo } from './types';

/** A directory shown only because repositories sit somewhere below it. */
export interface FolderNode {
  kind: 'folder';
  /** Absolute path. For a merged chain of folders, the path of the deepest one. */
  path: string;
  /**
   * The directory name, or several joined with '/' where a chain of folders that each
   * hold nothing but the next was merged into one row. A scan root is labelled with its
   * absolute path, which the view shortens for display.
   */
  label: string;
  /** True for a configured scan folder, false for a directory inside one. */
  isRoot: boolean;
  children: RepoTreeNode[];
  /** Repositories anywhere below, nested ones included. */
  repoCount: number;
}

/** A repository, holding the repositories nested inside it. */
export interface RepoNode {
  kind: 'repo';
  repo: RepoInfo;
  /** The repo name. A nested repo is labelled by its path inside its parent ("vendor/sdk"). */
  label: string;
  children: RepoNode[];
}

/** Either row the repository tree can hold. */
export type RepoTreeNode = FolderNode | RepoNode;

/** A directory while the hierarchy is being assembled, before it becomes a node. */
interface Directory {
  name: string;
  path: string;
  repo?: RepoNode;
  entries: Map<string, Directory>;
}

const slashed = (relativePath: string) => relativePath.split(path.sep).join('/');

const byLabel = (a: RepoTreeNode, b: RepoTreeNode) =>
  a.label.localeCompare(b.label) || nodePath(a).localeCompare(nodePath(b));

function nodePath(node: RepoTreeNode): string {
  return node.kind === 'repo' ? node.repo.path : node.path;
}

/** How many repositories a node stands for: itself and everything nested below. */
function countRepos(node: RepoTreeNode): number {
  return node.kind === 'folder'
    ? node.repoCount
    : 1 + node.children.reduce((total, child) => total + countRepos(child), 0);
}

/** Folders before repositories, each group in name order, the way a file explorer lists them. */
function sortChildren(children: RepoTreeNode[]): RepoTreeNode[] {
  return [
    ...children.filter((child) => child.kind === 'folder').sort(byLabel),
    ...children.filter((child) => child.kind === 'repo').sort(byLabel),
  ];
}

/** Every repository below a directory, however deep. */
function reposBelow(directory: Directory): RepoNode[] {
  return [...directory.entries.values()].flatMap((entry) =>
    entry.repo ? [entry.repo, ...reposBelow(entry)] : reposBelow(entry),
  );
}

function toNode(directory: Directory): RepoTreeNode {
  if (directory.repo) {
    // The scanner links every repo to the repo containing it, so nothing should be filed
    // under a repo's directory by folders alone. If a list ever arrives without that
    // link, hang those repos off this one rather than drop them from the tree.
    for (const stray of reposBelow(directory)) {
      stray.label = slashed(path.relative(directory.repo.repo.path, stray.repo.path));
      directory.repo.children.push(stray);
    }
    directory.repo.children.sort(byLabel);
    return directory.repo;
  }
  // A folder holding nothing but one other folder is merged into it ("tools/experiments"), so a
  // deep path costs one row instead of one row per level.
  let deepest = directory;
  let label = directory.name;
  for (;;) {
    const [only] = deepest.entries.values();
    if (deepest.entries.size !== 1 || !only || only.repo) break;
    label = `${label}/${only.name}`;
    deepest = only;
  }
  return toFolder(deepest, label, false);
}

function toFolder(directory: Directory, label: string, isRoot: boolean): FolderNode {
  const children = sortChildren([...directory.entries.values()].map(toNode));
  return {
    kind: 'folder',
    path: directory.path,
    label,
    isRoot,
    children,
    repoCount: children.reduce((total, child) => total + countRepos(child), 0),
  };
}

/** Builds the node for one scan root: a folder, or a repo when the root is a repository itself. */
function buildRoot(root: string, repos: readonly RepoInfo[]): RepoTreeNode {
  const nodes = new Map<string, RepoNode>();
  for (const repo of repos) {
    nodes.set(canonicalPathKey(repo.path), { kind: 'repo', repo, label: repo.name, children: [] });
  }
  const rootRepo = nodes.get(canonicalPathKey(root));
  const top: Directory = { name: root, path: root, repo: rootRepo, entries: new Map() };

  for (const repo of repos) {
    const node = nodes.get(canonicalPathKey(repo.path));
    if (!node || node === rootRepo) continue;
    // A parent can be missing even though parentRepoPath names one: overlapping scan
    // roots are deduped per repo, so the parent may have been kept under another root.
    // Such a repo is placed by its folders instead, unless the root is itself a repo
    // and so has to hold everything found below it.
    const parent =
      (repo.parentRepoPath === undefined
        ? undefined
        : nodes.get(canonicalPathKey(repo.parentRepoPath))) ?? rootRepo;
    if (parent) {
      node.label = slashed(path.relative(parent.repo.path, repo.path));
      parent.children.push(node);
      continue;
    }
    let directory = top;
    const segments = repo.relPath.split('/');
    for (const [index, name] of segments.entries()) {
      let next = directory.entries.get(name);
      if (!next) {
        next = { name, path: path.join(directory.path, name), entries: new Map() };
        directory.entries.set(name, next);
      }
      if (index === segments.length - 1) next.repo = node;
      directory = next;
    }
  }
  for (const node of nodes.values()) node.children.sort(byLabel);
  return rootRepo ?? toFolder(top, root, true);
}

/**
 * Arranges repositories the way they sit on disk: scan root, then folders, then repos, with
 * a nested repo under the repo that contains it. Pass a deduped list (`dedupeRepos`), so
 * each repo lands under exactly one root. Roots follow `rootOrder`, and a root holding no
 * repos is left out.
 *
 * When only one root has repos its own row is dropped and its contents become the top
 * level, since a single row that everything hides behind tells the user nothing.
 */
export function buildRepoTree(
  repos: readonly RepoInfo[],
  rootOrder: readonly string[],
): RepoTreeNode[] {
  const roots = groupReposByRoot([...repos], rootOrder).map((group) =>
    buildRoot(group.root, group.repos),
  );
  const [only] = roots;
  return roots.length === 1 && only?.kind === 'folder' ? only.children : roots;
}
