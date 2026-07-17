import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanForRepos } from '../../src/core/scanner';

let root: string;

async function makeRepo(...segments: string[]): Promise<void> {
  await fs.mkdir(path.join(root, ...segments, '.git'), { recursive: true });
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-scanner-'));
  await makeRepo('todo');
  await makeRepo('todo', 'vendor', 'theme'); // nested repo inside todo
  await makeRepo('clients', 'acme', 'website');
  await makeRepo('clients', 'acme', 'api');
  await makeRepo('node_modules', 'some-pkg'); // excluded
  await fs.mkdir(path.join(root, 'deep', 'a', 'b', 'c'), { recursive: true });
  await makeRepo('deep', 'a', 'b', 'c', 'too-deep'); // depth 5 > maxDepth 4

  // worktree/submodule style: .git is a file, not a directory
  await fs.mkdir(path.join(root, 'worktree-repo'));
  await fs.writeFile(path.join(root, 'worktree-repo', '.git'), 'gitdir: /elsewhere\n');

  // symlink cycle must not recurse forever ('junction' avoids needing elevation on
  // Windows and is ignored on other platforms)
  await fs.symlink(root, path.join(root, 'loop'), 'junction');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('scanForRepos', () => {
  it('finds repos recursively, honoring excludes and depth', async () => {
    const repos = await scanForRepos(root, {
      maxDepth: 4,
      exclude: ['node_modules'],
    });
    const rels = repos.map((r) => r.relPath).sort();
    expect(rels).toEqual([
      'clients/acme/api',
      'clients/acme/website',
      'todo',
      'todo/vendor/theme',
      'worktree-repo',
    ]);
  });

  it('marks repos found inside another repo with parentRepoPath', async () => {
    const repos = await scanForRepos(root, { maxDepth: 4, exclude: [] });
    const nested = repos.find((r) => r.relPath === 'todo/vendor/theme');
    expect(nested?.parentRepoPath).toBe(path.join(root, 'todo'));
    const top = repos.find((r) => r.relPath === 'todo');
    expect(top?.parentRepoPath).toBeUndefined();
  });

  it('treats the scan root itself as a repo when it contains .git', async () => {
    const repoRoot = path.join(root, 'todo');
    const repos = await scanForRepos(repoRoot, { maxDepth: 4, exclude: [] });
    const self = repos.find((r) => r.relPath === '');
    expect(self?.name).toBe('todo');
    expect(self?.path).toBe(repoRoot);
  });

  it('respects maxDepth', async () => {
    const repos = await scanForRepos(root, { maxDepth: 2, exclude: [] });
    expect(repos.map((r) => r.relPath)).not.toContain('clients/acme/website');
    expect(repos.map((r) => r.relPath)).toContain('todo');
  });

  it('finds repos sitting exactly at maxDepth', async () => {
    const repos = await scanForRepos(root, { maxDepth: 3, exclude: ['node_modules'] });
    expect(repos.map((r) => r.relPath)).toContain('clients/acme/website');
  });

  it('handles a trailing separator on the root path', async () => {
    const repos = await scanForRepos(root + path.sep, { maxDepth: 4, exclude: ['node_modules'] });
    expect(repos.map((r) => r.relPath).sort()).toEqual([
      'clients/acme/api',
      'clients/acme/website',
      'todo',
      'todo/vendor/theme',
      'worktree-repo',
    ]);
    expect(repos.every((r) => r.root === root)).toBe(true);
  });

  it('records the nearest ancestor for repos nested more than one level deep', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-nest-'));
    try {
      await fs.mkdir(path.join(dir, 'a', '.git'), { recursive: true });
      await fs.mkdir(path.join(dir, 'a', 'b', '.git'), { recursive: true });
      await fs.mkdir(path.join(dir, 'a', 'b', 'c', '.git'), { recursive: true });
      const repos = await scanForRepos(dir, { maxDepth: 4, exclude: [] });
      const byRel = new Map(repos.map((r) => [r.relPath, r]));
      expect(byRel.get('a')?.parentRepoPath).toBeUndefined();
      expect(byRel.get('a/b')?.parentRepoPath).toBe(path.join(dir, 'a'));
      expect(byRel.get('a/b/c')?.parentRepoPath).toBe(path.join(dir, 'a', 'b'));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing for a missing directory', async () => {
    const repos = await scanForRepos(path.join(root, 'does-not-exist'), {
      maxDepth: 4,
      exclude: [],
    });
    expect(repos).toEqual([]);
  });
});
