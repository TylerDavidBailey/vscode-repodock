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
    const rels = repos.map((repo) => repo.relPath).sort();
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
    const nested = repos.find((repo) => repo.relPath === 'todo/vendor/theme');
    expect(nested?.parentRepoPath).toBe(path.join(root, 'todo'));
    const top = repos.find((repo) => repo.relPath === 'todo');
    expect(top?.parentRepoPath).toBeUndefined();
  });

  it('treats the scan root itself as a repo when it contains .git', async () => {
    const repoRoot = path.join(root, 'todo');
    const repos = await scanForRepos(repoRoot, { maxDepth: 4, exclude: [] });
    const self = repos.find((repo) => repo.relPath === '');
    expect(self?.name).toBe('todo');
    expect(self?.path).toBe(repoRoot);
  });

  it('respects maxDepth', async () => {
    const repos = await scanForRepos(root, { maxDepth: 2, exclude: [] });
    expect(repos.map((repo) => repo.relPath)).not.toContain('clients/acme/website');
    expect(repos.map((repo) => repo.relPath)).toContain('todo');
  });

  it('finds repos sitting exactly at maxDepth', async () => {
    const repos = await scanForRepos(root, { maxDepth: 3, exclude: ['node_modules'] });
    expect(repos.map((repo) => repo.relPath)).toContain('clients/acme/website');
  });

  it('handles a trailing separator on the root path', async () => {
    const repos = await scanForRepos(root + path.sep, { maxDepth: 4, exclude: ['node_modules'] });
    expect(repos.map((repo) => repo.relPath).sort()).toEqual([
      'clients/acme/api',
      'clients/acme/website',
      'todo',
      'todo/vendor/theme',
      'worktree-repo',
    ]);
    expect(repos.every((repo) => repo.root === root)).toBe(true);
  });

  it('records the nearest ancestor for repos nested more than one level deep', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-nest-'));
    try {
      await fs.mkdir(path.join(dir, 'a', '.git'), { recursive: true });
      await fs.mkdir(path.join(dir, 'a', 'b', '.git'), { recursive: true });
      await fs.mkdir(path.join(dir, 'a', 'b', 'c', '.git'), { recursive: true });
      const repos = await scanForRepos(dir, { maxDepth: 4, exclude: [] });
      const byRel = new Map(repos.map((repo) => [repo.relPath, repo]));
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

  it('treats a .git file as a repository, for worktrees and submodules', async () => {
    const repos = await scanForRepos(root, { maxDepth: 4, exclude: ['node_modules'] });
    const worktree = repos.find((repo) => repo.relPath === 'worktree-repo');
    expect(worktree?.path).toBe(path.join(root, 'worktree-repo'));
  });

  it('terminates on a symlink cycle instead of recursing forever', async () => {
    // 'loop' points back at the scan root; nothing may be reported through it
    const repos = await scanForRepos(root, { maxDepth: 4, exclude: ['node_modules'] });
    expect(repos.filter((repo) => repo.relPath.startsWith('loop'))).toEqual([]);
  });

  it('does not report a repository reachable only through a symlinked directory', async () => {
    // not following symlinks is what makes the cycle above terminate, so this is the
    // price of that: a repo behind a link is invisible. Pinned here so the skip stays
    // deliberate rather than becoming an accident of how readdir types entries.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-link-'));
    try {
      const outside = path.join(dir, 'outside');
      await fs.mkdir(path.join(outside, 'linked-repo', '.git'), { recursive: true });
      const scanned = path.join(dir, 'scanned');
      await fs.mkdir(scanned);
      await fs.symlink(outside, path.join(scanned, 'link'), 'junction');

      expect(await scanForRepos(scanned, { maxDepth: 4, exclude: [] })).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('scans a root that is itself a symlink, because the root is read, not traversed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-link-root-'));
    try {
      const outside = path.join(dir, 'outside');
      await fs.mkdir(path.join(outside, 'linked-repo', '.git'), { recursive: true });
      const link = path.join(dir, 'link');
      await fs.symlink(outside, link, 'junction');

      const repos = await scanForRepos(link, { maxDepth: 4, exclude: [] });
      expect(repos.map((repo) => repo.relPath)).toEqual(['linked-repo']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('skips an excluded directory that is itself a repository', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-excl-'));
    try {
      await fs.mkdir(path.join(dir, 'vendor', '.git'), { recursive: true });
      await fs.mkdir(path.join(dir, 'vendor', 'inner', '.git'), { recursive: true });
      const repos = await scanForRepos(dir, { maxDepth: 4, exclude: ['vendor'] });
      expect(repos).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('reports only the root itself at maxDepth 0', async () => {
    const repoRoot = path.join(root, 'todo');
    const repos = await scanForRepos(repoRoot, { maxDepth: 0, exclude: [] });
    expect(repos.map((repo) => repo.relPath)).toEqual(['']);
  });

  it('returns repos ordered by path, so an unchanged rescan compares equal', async () => {
    const repos = await scanForRepos(root, { maxDepth: 4, exclude: ['node_modules'] });
    const paths = repos.map((repo) => repo.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });
});
