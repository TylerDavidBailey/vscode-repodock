import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readGitState } from '../../src/core/git';

/**
 * What `git config` reports is scripted here, so the scope handling can be checked against
 * outputs a single machine cannot produce at will: a system-wide driver next to a local
 * one, and a git too old to report scopes at all.
 */
type Reply = { stdout: string } | { exitCode: number };
let replies: Reply[] = [];

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _cmd: string,
      _args: string[],
      _opts: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      const reply = replies.shift() ?? { exitCode: 128 };
      if ('stdout' in reply) callback(null, reply.stdout);
      else callback(Object.assign(new Error('git failed'), { code: reply.exitCode }), '');
    },
  ),
}));

/** The arguments of every git call so far, each as one string. */
const calls = () => vi.mocked(execFile).mock.calls.map(([, args]) => (args ?? []).join(' '));

const STATUS = '# branch.oid 4a1c9200a1c9200a1c9200a1c9200a1c9200a1c9\n# branch.head main\n';
const NUL = '\0';

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  replies = [];
});

describe('which filter drivers get switched off', () => {
  it("blanks drivers from the local and worktree scopes, and keeps the user's own", async () => {
    replies = [
      {
        stdout: [
          ['system', 'filter.lfs.clean'],
          ['global', 'filter.mine.process'],
          ['local', 'filter.evil.clean'],
          ['local', 'filter.evil.required'],
          ['worktree', 'filter.sneaky.process'],
          ['command', 'filter.cli.clean'],
        ]
          .flat()
          .join(NUL),
      },
      { stdout: STATUS },
    ];

    expect(await readGitState('/repo')).toMatchObject({ branch: 'main' });

    const [, status] = calls();
    for (const name of ['evil', 'sneaky']) {
      expect(status).toContain(`-c filter.${name}.clean= `);
      expect(status).toContain(`-c filter.${name}.process= `);
      expect(status).toContain(`-c filter.${name}.smudge= `);
      expect(status).toContain(`-c filter.${name}.required=false`);
    }
    for (const name of ['lfs', 'mine', 'cli']) expect(status).not.toContain(`filter.${name}.`);
    // each driver once, however many of its settings were listed
    expect(status?.match(/filter\.evil\.clean=/g)).toHaveLength(1);
  });

  it('adds no overrides when the repository defines no filter driver', async () => {
    replies = [{ exitCode: 1 }, { stdout: STATUS }];
    expect(await readGitState('/repo')).toMatchObject({ branch: 'main' });
    expect(calls()[1]).not.toContain('filter.');
  });

  it('treats every driver as untrusted on a git too old to report scopes', async () => {
    replies = [
      { exitCode: 129 }, // --show-scope is unknown before git 2.26
      { stdout: ['filter.lfs.clean', 'filter.evil.clean'].join(NUL) + NUL },
      { stdout: STATUS },
    ];

    expect(await readGitState('/repo')).toMatchObject({ branch: 'main' });

    const [first, second, status] = calls();
    expect(first).toContain('--show-scope');
    expect(second).not.toContain('--show-scope');
    // without scopes there is no telling the user's driver from the repository's
    expect(status).toContain('-c filter.lfs.clean= ');
    expect(status).toContain('-c filter.evil.clean= ');
  });

  it('reports no status when the config cannot be read, rather than run git unprotected', async () => {
    replies = [{ exitCode: 128 }];
    expect(await readGitState('/repo')).toBeUndefined();
    expect(calls()).toHaveLength(1);
  });

  it('reports no status when the retry on an old git fails too', async () => {
    replies = [{ exitCode: 129 }, { exitCode: 128 }];
    expect(await readGitState('/repo')).toBeUndefined();
    expect(calls()).toHaveLength(2);
  });

  it('ignores a listed key that is not a driver setting', async () => {
    replies = [{ stdout: ['local', 'filter.orphan'].join(NUL) + NUL }, { stdout: STATUS }];
    expect(await readGitState('/repo')).toMatchObject({ branch: 'main' });
    expect(calls()[1]).not.toContain('filter.orphan');
  });

  it('reports no status when git exits with an error on the status itself', async () => {
    replies = [{ exitCode: 1 }, { exitCode: 128 }];
    expect(await readGitState('/repo')).toBeUndefined();
  });

  it('never asks git about submodule contents', async () => {
    replies = [{ exitCode: 1 }, { stdout: STATUS }];
    await readGitState('/repo');
    expect(calls()[1]).toContain('--ignore-submodules=dirty');
  });
});
