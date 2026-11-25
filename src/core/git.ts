import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createLimiter } from './limit';
import type { GitState } from './types';

const MAX_CONCURRENT_GIT = 8;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

const gitLimit = createLimiter(MAX_CONCURRENT_GIT);

/**
 * Passed to every git call, ahead of the subcommand. RepoDock runs git in every repository
 * under the scanned folders without the user opening any of them, and a repository's own
 * config is not trustworthy: one unpacked from an archive, or sitting on a shared drive,
 * carries whatever `.git/config` its author wrote. Git runs programs named in that config
 * during an ordinary `git status`, so each route is closed here:
 *
 * - `core.fsmonitor` names a program git runs to ask which files changed. Empty turns it
 *   off, and stops `core.fsmonitor=true` from leaving a daemon running per repository.
 * - `core.hooksPath` is pointed at nothing, so no hook can run.
 * - `protocol.allow=never` refuses every transport. A repository can declare itself a
 *   partial clone, and git then fetches a missing object on demand, through
 *   `core.sshCommand` or `remote.<name>.uploadpack`, both of which are shell commands.
 * - `--no-pager` keeps `core.pager` out of it.
 *
 * Filter drivers are the remaining route and need the repository's config to be read
 * first: see `untrustedFilterOverrides`.
 */
const HARDENING_ARGS: readonly string[] = [
  '--no-pager',
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'protocol.allow=never',
];

/** The environment every git call runs in: the editor's own, plus what keeps git passive. */
function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // `git status` refreshes the index by default, taking `.git/index.lock` while it
    // does. This runs in the background on every window focus across every repo, so
    // it would race the user's own git commands and fail them with "index.lock
    // exists". Skipping the optional refresh reads the same status without the lock
    // (the same setting VS Code's built-in git extension uses). Not writing the index
    // also means the post-index-change hook has nothing to fire on.
    GIT_OPTIONAL_LOCKS: '0',
    // newer gits take this instead of failing a fetch on the protocol setting above
    GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** The file names an executable can have on a platform, in the order to try them. */
export function executableNames(name: string, platform: NodeJS.Platform): string[] {
  // Only what can be started without a shell. A `.cmd` or `.bat` wrapper needs one, and
  // a shell would reopen the argument-quoting problems `execFile` exists to avoid.
  return platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [name];
}

/**
 * Finds an executable on `searchPath` and returns its absolute path, or undefined.
 *
 * Git is started by this absolute path, never by the bare name `git`. Handed a bare name,
 * Windows looks in the process's current directory before `PATH`, and VS Code's current
 * directory can be a folder the user opened, so a `git.exe` dropped into a project would
 * run in place of the real one. POSIX does the same for an empty or relative `PATH` entry
 * (a trailing `:` is enough). Entries that are not absolute are skipped for that reason.
 */
export async function resolveExecutable(
  name: string,
  searchPath: string | undefined = process.env.PATH,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  for (const entry of (searchPath ?? '').split(pathApi.delimiter)) {
    // Windows allows a PATH entry to be wrapped in quotes
    const directory = platform === 'win32' ? entry.replace(/^"(.*)"$/, '$1') : entry;
    if (!pathApi.isAbsolute(directory)) continue;
    for (const fileName of executableNames(name, platform)) {
      const candidate = pathApi.join(directory, fileName);
      try {
        // X_OK is what POSIX needs; Windows has no such bit and answers for existence
        await fs.access(candidate, fs.constants.X_OK);
        if ((await fs.stat(candidate)).isFile()) return candidate;
      } catch {
        // not here; try the next candidate
      }
    }
  }
  return undefined;
}

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

const FAILED: GitStatusResult = { gitMissing: false, timedOut: false };

interface GitRun {
  stdout: string;
  /** The exit status, or undefined when git ran to a clean exit or never started. */
  exitCode?: number;
  /** Set when git did not produce a usable result at all. */
  failure?: GitStatusResult;
}

/** Runs git once in a repository with the hardening applied. Never rejects. */
function runGit(git: string, repoPath: string, args: readonly string[]): Promise<GitRun> {
  return new Promise((resolve) => {
    execFile(
      git,
      [...HARDENING_ARGS, '-C', repoPath, ...args],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, env: gitEnvironment() },
      (error: Error | null, stdout: string) => {
        if (!error) {
          resolve({ stdout });
          return;
        }
        const { code, killed } = error as { code?: number | string; killed?: boolean };
        if (killed === true) {
          resolve({ stdout, failure: { gitMissing: false, timedOut: true } });
        } else if (typeof code === 'number') {
          resolve({ stdout, exitCode: code });
        } else {
          resolve({ stdout, failure: { gitMissing: code === 'ENOENT', timedOut: false } });
        }
      },
    );
  });
}

/** `git config` exits with this when no key matched, which is an answer, not a failure. */
const EXIT_NO_MATCH = 1;

/** Git exits with this for an option it does not know, here `--show-scope` before 2.26. */
const EXIT_USAGE = 129;

/** Config scopes written by the user or the machine's administrator, not by a repository. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command']);

/**
 * The `-c` arguments that switch off every filter driver a repository defines for itself,
 * or a failure when that cannot be established.
 *
 * A filter driver (`filter.<name>.clean` or `.process`) is a shell command git runs on a
 * file's content, and `git status` runs it on any file whose timestamp differs from the
 * index. Which files get which driver is set by `.gitattributes` inside the repository, so
 * a repository that defines a driver in its own config has a command run on every status.
 * There is no switch for filters as a whole: each driver has to be blanked by name, so the
 * names are read first, with `git config`, which runs nothing.
 *
 * Drivers from the user's own global or system config are left alone. Those are programs
 * the user installed, such as Git LFS, and blanking them would report every LFS file as
 * modified. A repository that sets LFS up in its own config (`git lfs install --local`) is
 * indistinguishable from a hostile one, so its driver is blanked and such a file can be
 * counted as changed when only its timestamp moved.
 */
async function untrustedFilterOverrides(
  git: string,
  repoPath: string,
): Promise<{ args: string[] } | { failure: GitStatusResult }> {
  const list = ['--includes', '--name-only', '-z', '--get-regexp', '^filter\\.'];
  let run = await runGit(git, repoPath, ['config', '--show-scope', ...list]);
  let hasScopes = true;
  if (run.exitCode === EXIT_USAGE) {
    // a git too old to say where a setting came from: treat every driver as untrusted
    run = await runGit(git, repoPath, ['config', ...list]);
    hasScopes = false;
  }
  if (run.failure) return { failure: run.failure };
  if (run.exitCode === EXIT_NO_MATCH) return { args: [] };
  if (run.exitCode !== undefined) return { failure: FAILED };

  const fields = run.stdout.split('\0').filter((field) => field !== '');
  const drivers = new Set<string>();
  for (let index = 0; index < fields.length; index += hasScopes ? 2 : 1) {
    const scope = hasScopes ? fields[index] : undefined;
    const key = fields[index + (hasScopes ? 1 : 0)] ?? '';
    if (scope !== undefined && TRUSTED_SCOPES.has(scope)) continue;
    // filter.<name>.<variable>: the name can itself contain dots
    const name = /^filter\.(.+)\.[^.]+$/.exec(key)?.[1];
    if (name === undefined) continue;
    // `-c key=value` splits at the first '=', so a name holding one cannot be overridden
    // this way. Giving up on the repository beats running git with the driver live.
    if (/[=\n]/.test(name)) return { failure: FAILED };
    drivers.add(name);
  }
  return {
    args: [...drivers].flatMap((name) => [
      '-c',
      `filter.${name}.clean=`,
      '-c',
      `filter.${name}.smudge=`,
      '-c',
      `filter.${name}.process=`,
      // a driver marked required fails the whole status once its command is blank
      '-c',
      `filter.${name}.required=false`,
    ]),
  };
}

/**
 * Runs `git status` in one repository, never rejecting: every failure comes back as a
 * result with no `state`. The two failure modes worth telling apart are git not being
 * installed and our own timeout killing it, since only the latter is transient.
 */
function runGitStatus(git: string | undefined, repoPath: string): Promise<GitStatusResult> {
  if (git === undefined) return Promise.resolve({ gitMissing: true, timedOut: false });
  return gitLimit(async () => {
    const overrides = await untrustedFilterOverrides(git, repoPath);
    if ('failure' in overrides) return overrides.failure;
    const run = await runGit(git, repoPath, [
      ...overrides.args,
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=normal',
      // Without this git runs a second `git status` inside each submodule, under that
      // submodule's own config. A submodule on a different commit still counts as a
      // change; uncommitted edits inside it do not.
      '--ignore-submodules=dirty',
    ]);
    if (run.failure) return run.failure;
    if (run.exitCode !== undefined) return FAILED;
    return { state: parsePorcelainV2(run.stdout), gitMissing: false, timedOut: false };
  });
}

/**
 * Reads the git state of a repository, or undefined when git fails (missing, corrupt repo).
 * Exposed for unit tests; the extension uses `loadGitStates` for the whole list at once.
 */
export async function readGitState(repoPath: string): Promise<GitState | undefined> {
  const git = await resolveExecutable('git');
  return (await runGitStatus(git, repoPath)).state;
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
  // found once per load rather than per repository, and again on the next load, so a git
  // installed while the editor is open is picked up without a restart
  const git = await resolveExecutable('git');
  await Promise.all(
    paths.map(async (repoPath) => {
      const result = await runGitStatus(git, repoPath);
      gitMissing ||= result.gitMissing;
      onResult(repoPath, result.state, result.timedOut);
    }),
  );
  return { gitMissing };
}
