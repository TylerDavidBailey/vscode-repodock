import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGitStates, parsePorcelainV2, readGitState } from '../../src/core/git';

describe('parsePorcelainV2', () => {
  it('parses branch, ahead/behind, and change counts', () => {
    const output = [
      '# branch.oid 4a1c9200a1c9200a1c9200a1c9200a1c9200a1c9',
      '# branch.head feat/auth-flow',
      '# branch.upstream origin/feat/auth-flow',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 abc def src/index.ts',
      '1 M. N... 100644 100644 100644 abc def src/other.ts',
      '2 R. N... 100644 100644 100644 abc def R100 new.ts\told.ts',
      'u UU N... 100644 100644 100644 100644 abc def ghi conflict.ts',
      '? untracked.txt',
      '',
    ].join('\n');
    const state = parsePorcelainV2(output);
    expect(state).toEqual({
      branch: 'feat/auth-flow',
      detached: false,
      changes: 4,
      untracked: 1,
      ahead: 2,
      behind: 1,
      hasUpstream: true,
    });
  });

  it('parses a clean branch without upstream', () => {
    const output = [
      '# branch.oid 4a1c9200a1c9200a1c9200a1c9200a1c9200a1c9',
      '# branch.head main',
      '',
    ].join('\n');
    const state = parsePorcelainV2(output);
    expect(state.branch).toBe('main');
    expect(state.hasUpstream).toBe(false);
    expect(state.changes + state.untracked).toBe(0);
  });

  it('uses the short commit hash for a detached HEAD', () => {
    const output = [
      '# branch.oid 4a1c9200a1c9200a1c9200a1c9200a1c9200a1c9',
      '# branch.head (detached)',
      '',
    ].join('\n');
    const state = parsePorcelainV2(output);
    expect(state.detached).toBe(true);
    expect(state.branch).toBe('4a1c920');
  });

  it('handles a repository with no commits yet', () => {
    const output = ['# branch.oid (initial)', '# branch.head main', ''].join('\n');
    const state = parsePorcelainV2(output);
    expect(state.branch).toBe('main');
    expect(state.detached).toBe(false);
  });

  it('returns a benign default for empty output', () => {
    expect(parsePorcelainV2('')).toEqual({
      branch: '',
      detached: false,
      changes: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    });
  });

  it('handles CRLF line endings', () => {
    const output = [
      '# branch.oid 4a1c9200a1c9200a1c9200a1c9200a1c9200a1c9',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +1 -0',
      '1 .M N... 100644 100644 100644 abc def src/index.ts',
      '? untracked.txt',
      '',
    ].join('\r\n');
    const state = parsePorcelainV2(output);
    expect(state.branch).toBe('main');
    expect(state.ahead).toBe(1);
    expect(state.hasUpstream).toBe(true);
    expect(state.changes).toBe(1);
    expect(state.untracked).toBe(1);
  });

  it('reports an in-sync upstream (+0 -0) as having an upstream', () => {
    const output = [
      '# branch.oid 4a1c9200a1c9200a1c9200a1c9200a1c9200a1c9',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
      '',
    ].join('\n');
    const state = parsePorcelainV2(output);
    expect(state.hasUpstream).toBe(true);
    expect(state.ahead).toBe(0);
    expect(state.behind).toBe(0);
  });
});

describe('readGitState (real git)', () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-git-'));
    execFileSync('git', ['init', '-b', 'main', repo]);
    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
    git('add', 'a.txt');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init');
  });

  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('reports a clean repo on main', async () => {
    const state = await readGitState(repo);
    expect(state?.branch).toBe('main');
    expect(state?.changes).toBe(0);
    expect(state?.untracked).toBe(0);
  });

  it('counts modified and untracked files', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'changed\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'new\n');
    const state = await readGitState(repo);
    expect(state?.changes).toBe(1);
    expect(state?.untracked).toBe(1);
  });

  it('returns undefined for a directory that is not a repo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-notrepo-'));
    try {
      expect(await readGitState(dir)).toBeUndefined();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('loadGitStates', () => {
  let repo: string;
  let notRepo: string;

  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-load-'));
    execFileSync('git', ['init', '-b', 'main', repo]);
    notRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-load-notrepo-'));
  });

  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(notRepo, { recursive: true, force: true });
  });

  it('reports a result for every path and no missing git', async () => {
    const results = new Map<string, unknown>();
    const { gitMissing } = await loadGitStates([repo, notRepo], (p, state) => {
      results.set(p, state);
    });
    expect(gitMissing).toBe(false);
    expect(results.size).toBe(2);
    expect(results.get(repo)).toMatchObject({ branch: 'main' });
    expect(results.get(notRepo)).toBeUndefined();
  });

  it('flags a missing git executable instead of failing silently', async () => {
    const oldPath = process.env.PATH;
    process.env.PATH = ''; // git can no longer be found
    try {
      const results = new Map<string, unknown>();
      const { gitMissing } = await loadGitStates([repo], (p, state) => {
        results.set(p, state);
      });
      expect(gitMissing).toBe(true);
      expect(results.get(repo)).toBeUndefined();
    } finally {
      process.env.PATH = oldPath;
    }
  });
});
