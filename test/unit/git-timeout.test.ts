import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadGitStates } from '../../src/core/git';
import type { GitState } from '../../src/core/types';

// simulate git outcomes per repo path: a timeout kill vs. an ordinary failure
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      // the repository follows -C, after the options every call starts with
      const repoPath = args[args.indexOf('-C') + 1];
      if (repoPath === '/slow-repo') {
        callback(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '');
      } else {
        callback(Object.assign(new Error('not a repository'), { code: 128 }), '');
      }
    },
  ),
}));

describe('loadGitStates on git failures', () => {
  it('marks a timeout kill as transient, but not an ordinary git failure', async () => {
    const results = new Map<string, { state: GitState | undefined; timedOut: boolean }>();
    const { gitMissing } = await loadGitStates(
      ['/slow-repo', '/broken-repo'],
      (repoPath, state, timedOut) => {
        results.set(repoPath, { state, timedOut });
      },
    );
    expect(gitMissing).toBe(false);
    expect(results.get('/slow-repo')).toEqual({ state: undefined, timedOut: true });
    expect(results.get('/broken-repo')).toEqual({ state: undefined, timedOut: false });
  });

  it('runs git without optional locks, so a background status never blocks the user', async () => {
    await loadGitStates(['/broken-repo'], () => {});
    const options = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv };
    expect(options.env?.GIT_OPTIONAL_LOCKS).toBe('0');
    // the rest of the environment still reaches git: its own helpers are found on PATH
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it('starts git by absolute path, never by a bare name the current directory could answer', async () => {
    await loadGitStates(['/broken-repo'], () => {});
    for (const [command] of vi.mocked(execFile).mock.calls) {
      expect(path.isAbsolute(command), command).toBe(true);
    }
  });

  it('puts the hardening options ahead of the subcommand on every call', async () => {
    vi.mocked(execFile).mockClear();
    await loadGitStates(['/broken-repo'], () => {});
    const calls = vi.mocked(execFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, args] of calls) {
      const options = (args ?? []).slice(0, (args ?? []).indexOf('-C')).join(' ');
      expect(options).toContain('--no-pager');
      expect(options).toContain('-c core.fsmonitor=');
      expect(options).toContain('-c core.hooksPath=/dev/null');
      expect(options).toContain('-c protocol.allow=never');
    }
  });

  it('reads the config before the status, and gives up on the repository when that fails', async () => {
    vi.mocked(execFile).mockClear();
    await loadGitStates(['/broken-repo'], () => {});
    const subcommands = vi
      .mocked(execFile)
      .mock.calls.map(([, args]) => (args ?? [])[(args ?? []).indexOf('-C') + 2]);
    // the config read failed, so no status was attempted with unknown filters live
    expect(subcommands).toEqual(['config']);
  });
});
