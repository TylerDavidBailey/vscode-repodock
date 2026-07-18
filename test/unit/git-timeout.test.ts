import { describe, expect, it, vi } from 'vitest';
import type { GitState } from '../../src/core/types';
import { loadGitStates } from '../../src/core/git';

// simulate git outcomes per repo path: a timeout kill vs. an ordinary failure
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      args: string[],
      _opts: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      const repoPath = args[1];
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
      (p, state, timedOut) => {
        results.set(p, { state, timedOut });
      },
    );
    expect(gitMissing).toBe(false);
    expect(results.get('/slow-repo')).toEqual({ state: undefined, timedOut: true });
    expect(results.get('/broken-repo')).toEqual({ state: undefined, timedOut: false });
  });
});
