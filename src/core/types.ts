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
  detached: boolean;
  /** Staged, unstaged, renamed, and conflicted paths. */
  changes: number;
  untracked: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
}

export interface ScanOptions {
  /** Levels below the scan root to descend into. */
  maxDepth: number;
  /** Directory names to skip. */
  exclude: string[];
}
