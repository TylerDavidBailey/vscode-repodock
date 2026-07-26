export interface RepoInfo {
  /** Directory basename, e.g. "api-server". */
  name: string;
  /** Absolute path to the repository. */
  path: string;
  /** Absolute path of the scan root this repo was found under. */
  root: string;
  /** Path relative to the scan root, '' when the root itself is a repo. Always '/'-separated. */
  relPath: string;
  /** Absolute path of the nearest ancestor repository, when this repo is nested inside one. */
  parentRepoPath?: string;
}

export interface GitState {
  /** Branch name, or the short commit hash when detached. */
  branch: string;
  /** True when HEAD points at a commit rather than a branch. */
  detached: boolean;
  /** Number of tracked files that are staged, unstaged, renamed, or conflicted. */
  changes: number;
  untracked: number;
  ahead: number;
  behind: number;
  /** False when the branch has no remote tracking branch, making `ahead`/`behind` meaningless. */
  hasUpstream: boolean;
}

export interface ScanOptions {
  /** Levels below the scan root to descend into. */
  maxDepth: number;
  /** Directory names to skip. */
  exclude: string[];
}
