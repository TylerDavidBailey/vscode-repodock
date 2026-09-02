import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLimiter } from './limit';
import type { RepoInfo, ScanOptions } from './types';

const MAX_CONCURRENT_READDIR = 16;
const READDIR_TIMEOUT_MS = 15_000;

const readdirLimit = createLimiter(MAX_CONCURRENT_READDIR);

/** readdir that gives up after a timeout, since a dead network mount can hang forever. */
function readdirWithTimeout(dir: string): Promise<Dirent[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`readdir timed out: ${dir}`));
    }, READDIR_TIMEOUT_MS);
    fs.readdir(dir, { withFileTypes: true }).then(
      (entries) => {
        clearTimeout(timer);
        resolve(entries);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Recursively discovers git repositories under `root`. A directory is a repository when it
 * contains a `.git` entry (directory, or file for worktrees/submodules). Scanning continues
 * inside repositories so nested repos are found too; they carry `parentRepoPath`.
 *
 * Symlinked directories are not followed, so a repository reachable only through one is
 * not reported. `root` itself may be a symlink, since it is read rather than traversed.
 */
export async function scanForRepos(root: string, options: ScanOptions): Promise<RepoInfo[]> {
  const base = path.resolve(root);
  const excluded = new Set(options.exclude);
  const repos: RepoInfo[] = [];

  const walk = async (dir: string, depth: number, parentRepoPath?: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdirLimit(() => readdirWithTimeout(dir));
    } catch {
      return; // skip unreadable directories (permissions, races, hung mounts)
    }

    let repoHere = parentRepoPath;
    if (entries.some((entry) => entry.name === '.git')) {
      repos.push({
        name: path.basename(dir),
        path: dir,
        root: base,
        relPath: path.relative(base, dir).split(path.sep).join('/'),
        parentRepoPath,
      });
      repoHere = dir;
    }

    if (depth >= options.maxDepth) {
      return;
    }

    // readdir reports lstat types, so isDirectory() is already false for a symlink
    // pointing at a directory: symlinked directories are never descended into. That is
    // deliberate and load-bearing: it is the only thing keeping the walk free of cycles.
    const subdirs = entries.filter(
      (entry) => entry.isDirectory() && entry.name !== '.git' && !excluded.has(entry.name),
    );
    await Promise.all(
      subdirs.map((entry) => walk(path.join(dir, entry.name), depth + 1, repoHere)),
    );
  };

  await walk(base, 0);
  repos.sort((a, b) => a.path.localeCompare(b.path));
  return repos;
}
