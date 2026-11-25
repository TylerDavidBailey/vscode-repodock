import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { executableNames, readGitState, resolveExecutable } from '../../src/core/git';

/**
 * Every test here builds a repository whose own config tells git to run a program, the
 * way an unpacked archive or a folder on a shared drive could, and checks that reading
 * its status does not run it. The program only creates a marker file, so "did it run" is
 * "does the marker exist". Real git throughout: the point is what git itself does.
 *
 * POSIX only. The commands are shell one-liners, and the behavior under test is git's
 * handling of config, which does not differ by platform.
 */
const describePosix = process.platform === 'win32' ? describe.skip : describe;

let sandbox: string;
let marker: string;

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], {
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });

/** A repository with one committed file, under the sandbox. */
async function makeRepo(name: string): Promise<string> {
  const repo = path.join(sandbox, name);
  await fs.mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'content\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

/**
 * Routes every file through the filter driver `driver` and backdates the tracked file, so
 * git cannot trust its cached state and has to run the driver to compare content.
 */
async function forceFilter(repo: string, driver: string): Promise<void> {
  await fs.writeFile(path.join(repo, '.gitattributes'), `* filter=${driver}\n`);
  const longAgo = new Date('2001-01-01T00:00:00Z');
  await fs.utimes(path.join(repo, 'tracked.txt'), longAgo, longAgo);
}

/** Removes the tree HEAD points at, so reading the repository needs an object it lacks. */
async function dropHeadTree(repo: string): Promise<void> {
  const tree = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD^{tree}']).toString().trim();
  await fs.rm(path.join(repo, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));
}

const didRun = () =>
  fs.access(marker).then(
    () => true,
    () => false,
  );

/** A shell command that creates the marker, then does `rest`. */
const trap = (rest: string) => `touch '${marker}'; ${rest}`;

describePosix('reading the status of a repository that carries its own config', () => {
  beforeAll(async () => {
    sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-hostile-')));
    marker = path.join(sandbox, 'RAN');
  }, 60_000);

  afterEach(async () => {
    await fs.rm(marker, { force: true });
  });

  afterAll(async () => {
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  it('runs the trap when asked the way git is normally asked, or these tests prove nothing', async () => {
    const repo = await makeRepo('control');
    git(repo, 'config', 'core.fsmonitor', trap('false'));
    try {
      execFileSync('git', ['-C', repo, 'status', '--porcelain=v2'], { stdio: 'ignore' });
    } catch {
      // git's own verdict is beside the point; only the marker matters
    }
    expect(await didRun()).toBe(true);
  });

  it('does not run core.fsmonitor', async () => {
    const repo = await makeRepo('fsmonitor');
    git(repo, 'config', 'core.fsmonitor', trap('false'));
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('does not run a clean filter the repository defines', async () => {
    const repo = await makeRepo('clean-filter');
    git(repo, 'config', 'filter.evil.clean', trap('cat'));
    await forceFilter(repo, 'evil');
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('does not run a long-running filter process the repository defines', async () => {
    const repo = await makeRepo('process-filter');
    git(repo, 'config', 'filter.evil.process', trap('false'));
    await forceFilter(repo, 'evil');
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('still reads the status when that filter is marked required', async () => {
    const repo = await makeRepo('required-filter');
    git(repo, 'config', 'filter.evil.clean', trap('cat'));
    git(repo, 'config', 'filter.evil.required', 'true');
    await forceFilter(repo, 'evil');
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('does not run a filter defined in the per-worktree config', async () => {
    const repo = await makeRepo('worktree-config');
    git(repo, 'config', 'extensions.worktreeConfig', 'true');
    git(repo, 'config', '--worktree', 'filter.evil.clean', trap('cat'));
    await forceFilter(repo, 'evil');
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('does not run a filter pulled in from a file the config includes', async () => {
    const repo = await makeRepo('included-config');
    await fs.writeFile(
      path.join(repo, 'extra.gitconfig'),
      `[filter "evil"]\n\tclean = "${trap('cat').replaceAll('"', '\\"')}"\n`,
    );
    git(repo, 'config', 'include.path', '../extra.gitconfig');
    await forceFilter(repo, 'evil');
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('does not run a filter whose name has dots in it', async () => {
    // the name sits between the first and the last dot of the config key
    const repo = await makeRepo('dotted-name');
    git(repo, 'config', 'filter.a.b.c.clean', trap('cat'));
    await forceFilter(repo, 'a.b.c');
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('refuses the repository outright when a filter name cannot be overridden', async () => {
    // `-c key=value` splits at the first '=', so this driver cannot be blanked by name
    const repo = await makeRepo('equals-name');
    git(repo, 'config', 'filter.a=b.clean', trap('cat'));
    await forceFilter(repo, 'a=b');
    expect(await readGitState(repo)).toBeUndefined();
    expect(await didRun()).toBe(false);
  });

  it('does not fetch a missing object through core.sshCommand', async () => {
    const repo = await makeRepo('lazy-ssh');
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.url', 'ssh://example.invalid/repo');
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'core.sshCommand', trap('false'));
    await dropHeadTree(repo);
    // the repository is unreadable without that object, so there is no status to report
    expect(await readGitState(repo)).toBeUndefined();
    expect(await didRun()).toBe(false);
  });

  it('does not fetch a missing object through remote.uploadpack', async () => {
    const source = await makeRepo('lazy-source');
    const repo = await makeRepo('lazy-local');
    git(repo, 'config', 'extensions.partialClone', 'origin');
    git(repo, 'config', 'remote.origin.url', source);
    git(repo, 'config', 'remote.origin.promisor', 'true');
    git(repo, 'config', 'remote.origin.uploadpack', trap('false'));
    await dropHeadTree(repo);
    expect(await readGitState(repo)).toBeUndefined();
    expect(await didRun()).toBe(false);
  });

  it('does not run a hook, even with one installed for the index', async () => {
    const repo = await makeRepo('hook');
    const hook = path.join(repo, '.git', 'hooks', 'post-index-change');
    await fs.writeFile(hook, `#!/bin/sh\n${trap('true')}\n`, { mode: 0o755 });
    // a changed timestamp is what would have git rewrite the index, and so fire the hook
    const longAgo = new Date('2001-01-01T00:00:00Z');
    await fs.utimes(path.join(repo, 'tracked.txt'), longAgo, longAgo);
    expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    expect(await didRun()).toBe(false);
  });

  it('does not look inside a submodule, where another config would apply', async () => {
    const inner = await makeRepo('submodule-source');
    const repo = await makeRepo('superproject');
    execFileSync(
      'git',
      ['-C', repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub'],
      { stdio: 'ignore' },
    );
    git(repo, 'commit', '-q', '-m', 'add submodule');
    git(path.join(repo, 'sub'), 'config', 'core.fsmonitor', trap('false'));
    await fs.writeFile(path.join(repo, 'sub', 'untracked.txt'), 'new\n');

    const state = await readGitState(repo);
    expect(state).toMatchObject({ branch: 'main', changes: 0 });
    expect(await didRun()).toBe(false);
  });

  it("leaves a filter from the user's own global config working, since that one is trusted", async () => {
    // Git LFS is set up this way: blanking it would report every LFS file as modified
    const globalConfig = path.join(sandbox, 'global.gitconfig');
    await fs.writeFile(globalConfig, `[filter "mine"]\n\tclean = "${trap('cat')}"\n`);
    const repo = await makeRepo('global-filter');
    await forceFilter(repo, 'mine');
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      expect(await readGitState(repo)).toMatchObject({ branch: 'main' });
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    }
    expect(await didRun()).toBe(true);
  });

  it('still counts real changes in a repository whose filter was switched off', async () => {
    const repo = await makeRepo('counts');
    git(repo, 'config', 'filter.evil.clean', trap('cat'));
    await forceFilter(repo, 'evil');
    await fs.writeFile(path.join(repo, 'tracked.txt'), 'edited\n');
    const state = await readGitState(repo);
    // tracked.txt is modified; .gitattributes is the one untracked file
    expect(state).toMatchObject({ branch: 'main', changes: 1, untracked: 1 });
    expect(await didRun()).toBe(false);
  });
});

describe('resolveExecutable', () => {
  let bin: string;

  beforeAll(async () => {
    bin = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-bin-')));
    await fs.writeFile(path.join(bin, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await fs.writeFile(path.join(bin, 'not-executable'), 'data', { mode: 0o644 });
    await fs.mkdir(path.join(bin, 'a-directory'));
  });

  afterAll(async () => {
    await fs.rm(bin, { recursive: true, force: true });
  });

  const describeNative = process.platform === 'win32' ? describe.skip : describe;

  describeNative('on this platform', () => {
    it('finds git on the real PATH, as an absolute path', async () => {
      const found = await resolveExecutable('git');
      expect(found && path.isAbsolute(found)).toBe(true);
    });

    it('returns the first match in PATH order', async () => {
      const other = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-bin2-'));
      try {
        await fs.writeFile(path.join(other, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
        expect(await resolveExecutable('tool', `${other}:${bin}`)).toBe(path.join(other, 'tool'));
        expect(await resolveExecutable('tool', `${bin}:${other}`)).toBe(path.join(bin, 'tool'));
      } finally {
        await fs.rm(other, { recursive: true, force: true });
      }
    });

    it('never resolves through an empty or relative PATH entry, which means the current directory', async () => {
      const previous = process.cwd();
      process.chdir(bin);
      try {
        // each of these would find ./tool if the entry were honored
        for (const searchPath of ['', ':', '.', `:${path.sep}nonexistent`, 'relative/dir:.']) {
          expect(await resolveExecutable('tool', searchPath), searchPath).toBeUndefined();
        }
        // and a later absolute entry is still used
        expect(await resolveExecutable('tool', `.::${bin}`)).toBe(path.join(bin, 'tool'));
      } finally {
        process.chdir(previous);
      }
    });

    it('skips a file that is not executable and a directory of the same name', async () => {
      expect(await resolveExecutable('not-executable', bin)).toBeUndefined();
      expect(await resolveExecutable('a-directory', bin)).toBeUndefined();
    });

    it('returns undefined when nothing on PATH matches, or PATH is unset', async () => {
      expect(await resolveExecutable('no-such-tool', bin)).toBeUndefined();
      expect(await resolveExecutable('tool', undefined)).toBeUndefined();
    });
  });

  it('looks for .exe and .com on Windows, and never a script that would need a shell', () => {
    expect(executableNames('git', 'win32')).toEqual(['git.exe', 'git.com']);
    expect(executableNames('git', 'linux')).toEqual(['git']);
    expect(executableNames('git', 'darwin')).toEqual(['git']);
  });

  it('reads a Windows PATH by its own rules: semicolons, quotes, and no relative entries', async () => {
    // nothing exists at these paths here, so this checks they are parsed without
    // throwing and that the relative entries are not tried against this directory
    const previous = process.cwd();
    process.chdir(bin);
    try {
      await fs.writeFile(path.join(bin, 'git.exe'), '', { mode: 0o755 });
      const searchPath = '.;;"C:\\Program Files\\Git\\cmd";relative\\dir';
      expect(await resolveExecutable('git', searchPath, 'win32')).toBeUndefined();
    } finally {
      process.chdir(previous);
      await fs.rm(path.join(bin, 'git.exe'), { force: true });
    }
  });
});
