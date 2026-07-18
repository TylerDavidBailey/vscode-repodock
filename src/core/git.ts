import { execFile } from 'node:child_process';
import { createLimiter } from './limit';
import type { GitState } from './types';

const gitLimit = createLimiter(8);

/**
 * Parses `git status --porcelain=v2 --branch` output.
 * Header lines: `# branch.head <name>`, `# branch.oid <sha>`, `# branch.ab +<ahead> -<behind>`.
 * Entry lines: `1`/`2` changed, `u` unmerged, `?` untracked.
 */
export function parsePorcelainV2(output: string): GitState {
  const state: GitState = {
    branch: '',
    detached: false,
    changes: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
  };
  let oid = '';

  for (const line of output.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      state.branch = line.slice('# branch.head '.length).trim();
    } else if (line.startsWith('# branch.oid ')) {
      oid = line.slice('# branch.oid '.length).trim();
    } else if (line.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line.trim());
      if (match) {
        state.ahead = Number(match[1]);
        state.behind = Number(match[2]);
        state.hasUpstream = true;
      }
    } else if (/^[12u] /.test(line)) {
      state.changes++;
    } else if (line.startsWith('? ')) {
      state.untracked++;
    }
  }

  if (state.branch === '(detached)') {
    state.detached = true;
    state.branch = oid === '(initial)' ? oid : oid.slice(0, 7);
  }
  return state;
}

interface GitStatusResult {
  state?: GitState;
  /** True when the git executable itself could not be found. */
  gitMissing: boolean;
  /** True when git was killed by our timeout. Transient: the repo itself may be fine. */
  timedOut: boolean;
}

function runGitStatus(repoPath: string): Promise<GitStatusResult> {
  return gitLimit(
    () =>
      new Promise((resolve) => {
        execFile(
          'git',
          ['-C', repoPath, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
          { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
          (error: Error | null, stdout: string) => {
            if (error) {
              resolve({
                gitMissing: (error as NodeJS.ErrnoException).code === 'ENOENT',
                timedOut: (error as { killed?: boolean }).killed === true,
              });
            } else {
              resolve({ state: parsePorcelainV2(stdout), gitMissing: false, timedOut: false });
            }
          },
        );
      }),
  );
}

/** Reads the git state of a repository, or undefined when git fails (missing, corrupt repo). */
export function readGitState(repoPath: string): Promise<GitState | undefined> {
  return runGitStatus(repoPath).then((result) => result.state);
}

/**
 * Loads git state for every path, calling `onResult` as each result arrives so the UI
 * can update incrementally. `timedOut` means git hit our timeout; the last known state
 * is still worth showing. Also reports whether the git executable was missing, so
 * callers can say why status is absent instead of failing silently.
 */
export async function loadGitStates(
  paths: string[],
  onResult: (path: string, state: GitState | undefined, timedOut: boolean) => void,
): Promise<{ gitMissing: boolean }> {
  let gitMissing = false;
  await Promise.all(
    paths.map(async (p) => {
      const result = await runGitStatus(p);
      gitMissing ||= result.gitMissing;
      onResult(p, result.state, result.timedOut);
    }),
  );
  return { gitMissing };
}
