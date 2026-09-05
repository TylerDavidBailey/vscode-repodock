import { execFile } from 'node:child_process';
import { createLimiter } from './limit';
import type { GitState } from './types';

const MAX_CONCURRENT_GIT = 8;
const GIT_STATUS_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const gitLimit = createLimiter(MAX_CONCURRENT_GIT);

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

/**
 * Runs `git status` in one repository, never rejecting: every failure comes back as a
 * result with no `state`. The two failure modes worth telling apart are git not being
 * installed (`ENOENT`) and our own timeout killing it, since only the latter is transient.
 */
function runGitStatus(repoPath: string): Promise<GitStatusResult> {
  return gitLimit(
    () =>
      new Promise((resolve) => {
        execFile(
          'git',
          ['-C', repoPath, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'],
          {
            timeout: GIT_STATUS_TIMEOUT_MS,
            maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
            // `git status` refreshes the index by default, taking `.git/index.lock` while it
            // does. This runs in the background on every window focus across every repo, so
            // it would race the user's own git commands and fail them with "index.lock
            // exists". Skipping the optional refresh reads the same status without the lock
            // (the same setting VS Code's built-in git extension uses).
            env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
          },
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

/**
 * Reads the git state of a repository, or undefined when git fails (missing, corrupt repo).
 * Exposed for unit tests; the extension uses `loadGitStates` for the whole list at once.
 */
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
    paths.map(async (repoPath) => {
      const result = await runGitStatus(repoPath);
      gitMissing ||= result.gitMissing;
      onResult(repoPath, result.state, result.timedOut);
    }),
  );
  return { gitMissing };
}
