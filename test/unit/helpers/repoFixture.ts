import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitState, RepoInfo } from '../../../src/core/types';

const DEFAULT_ROOT = '/root';

/**
 * A POSIX-looking test path in the platform's own form — `/srv/code` becomes `D:\srv\code`
 * on Windows. Anything a test puts in settings or compares against a scanned path has to go
 * through this, because `expandPath` resolves configured paths the same way.
 */
export function absPath(p: string): string {
  return path.resolve(p);
}

/**
 * A `RepoInfo` for tests that never touch disk. Write `path` and `root` POSIX-style; both
 * come back resolved for the current platform. `name` and `relPath` are derived from `path`,
 * with `relPath` always '/'-separated, exactly as `scanForRepos` builds it.
 */
export function makeRepo(overrides: Partial<RepoInfo> & { path: string }): RepoInfo {
  const repoPath = absPath(overrides.path);
  const root = absPath(overrides.root ?? DEFAULT_ROOT);
  return {
    name: path.basename(repoPath),
    relPath: path.relative(root, repoPath).split(path.sep).join('/'),
    ...overrides,
    path: repoPath,
    root,
  };
}

/** A clean `GitState` on `main` with an in-sync upstream; override the fields a test cares about. */
export function makeGitState(overrides: Partial<GitState> = {}): GitState {
  return {
    branch: 'main',
    detached: false,
    changes: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    ...overrides,
  };
}

/** A temp directory holding real git repositories, plus the cleanup that removes it. */
export interface GitFixture {
  root: string;
  /** Absolute path of a repo created under `root`, by its relative path. */
  repo: (relPath: string) => string;
  cleanup: () => Promise<void>;
}

/**
 * Creates real git repositories at each relative path under a fresh temp directory, each with
 * one commit on `main`. Real git, because parsing its porcelain output is the point — the
 * mocked equivalents live in the suites that mock `loadGitStates` instead.
 */
export async function withGitRepos(relPaths: string[]): Promise<GitFixture> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-')));
  for (const relPath of relPaths) {
    const dir = path.join(root, relPath);
    await fs.mkdir(dir, { recursive: true });
    execFileSync('git', ['init', '-b', 'main', dir]);
    await fs.writeFile(path.join(dir, 'README.md'), '# fixture\n');
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', [
      '-C',
      dir,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'init',
    ]);
  }
  return {
    root,
    repo: (relPath) => path.join(root, relPath),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
