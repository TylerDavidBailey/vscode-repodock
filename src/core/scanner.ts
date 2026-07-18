import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLimiter } from './limit';
import type { RepoInfo, ScanOptions } from './types';

const readdirLimit = createLimiter(16);
const READDIR_TIMEOUT_MS = 15_000;

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
    if (entries.some((e) => e.name === '.git')) {
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

    const subdirs = entries.filter(
      (e) => e.isDirectory() && !e.isSymbolicLink() && e.name !== '.git' && !excluded.has(e.name),
    );
    await Promise.all(subdirs.map((e) => walk(path.join(dir, e.name), depth + 1, repoHere)));
  };

  await walk(base, 0);
  repos.sort((a, b) => a.path.localeCompare(b.path));
  return repos;
}
