import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoDockApi } from '../../src/ext/extension';
import { tildify } from '../../src/ext/settings';

const EXTENSION_ID = 'tylerdavidbailey.repodock';

let fixture: string;
let api: RepoDockApi;
/** package.json as VS Code parsed it, so the command list cannot drift from the manifest. */
let manifest: {
  contributes: { commands: { command: string }[] };
};

async function makeGitRepo(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', dir]);
  await fs.writeFile(path.join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', [
    '-C',
    dir,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'init',
  ]);
}

const settings = () => vscode.workspace.getConfiguration('repodock');

/** Writes a global setting and waits for the rescan its configuration listener kicks off. */
async function setSetting(key: string, value: unknown): Promise<void> {
  await settings().update(key, value, vscode.ConfigurationTarget.Global);
  await api.refresh();
}

/** Waits for `predicate`, polling the tree while the background rescan settles. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const rows = () => api.provider.getChildren();
const labels = () => rows().map((row) => row.label);

describe('RepoDock', () => {
  before(async function () {
    this.timeout(120_000);
    fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-it-')));
    await makeGitRepo(path.join(fixture, 'alpha'));
    await makeGitRepo(path.join(fixture, 'group', 'sub', 'beta'));
    // a repo inside another repo, so the repoNested contextValue is exercised
    await makeGitRepo(path.join(fixture, 'alpha', 'vendor'));

    const extension = vscode.extensions.getExtension<RepoDockApi>(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    manifest = extension.packageJSON as typeof manifest;
    api = await extension.activate();

    await settings().update('directories', [fixture], vscode.ConfigurationTarget.Global);
    await api.refresh();
    // the directories update also kicks off a config-listener rescan that can supersede
    // the refresh above (its git results are then discarded), so wait for state to land
    await until(() => api.provider.getGitStates().size >= 3, 'git state for every fixture repo');
  });

  after(async () => {
    // these are global settings in a shared user-data dir; leaving them set leaks the
    // temp fixture into the next run
    for (const key of [
      'directories',
      'sortOrder',
      'groupByFolder',
      'hiddenRepos',
      'showNestedRepos',
    ]) {
      await settings().update(key, undefined, vscode.ConfigurationTarget.Global);
    }
    await fs.rm(fixture, { recursive: true, force: true });
  });

  it('registers every command the manifest contributes', async () => {
    const registered = await vscode.commands.getCommands(true);
    const contributed = manifest.contributes.commands.map((command) => command.command);
    assert.ok(contributed.length > 0, 'expected the manifest to contribute commands');
    for (const command of contributed) {
      assert.ok(registered.includes(command), `missing command ${command}`);
    }
  });

  it('discovers the fixture repositories', () => {
    const rels = api
      .getRepos()
      .map((repo) => repo.relPath)
      .sort();
    assert.deepStrictEqual(rels, ['alpha', 'alpha/vendor', 'group/sub/beta']);
  });

  it('renders one flat row per repo, qualified by its folder in parentheses', () => {
    assert.deepStrictEqual(labels(), ['alpha', 'beta (group/sub)', 'vendor (alpha)']);
    assert.strictEqual(api.provider.getChildren(rows()[0]).length, 0);
  });

  it('shows the branch in the repo description once git state loads', () => {
    const alpha = rows()[0];
    assert.ok(alpha, 'expected a repo element');
    const item = api.provider.getTreeItem(alpha);
    assert.ok(
      typeof item.description === 'string' && item.description.startsWith('main'),
      `expected description to start with "main", got: ${String(item.description)}`,
    );
    assert.strictEqual(item.command?.command, 'repodock.open');
  });

  it('tags rows with the contextValue the row menus match on', () => {
    const contextValues = rows().map((row) => api.provider.getTreeItem(row).contextValue);
    // vendor sits inside alpha, so it is the nested one
    assert.deepStrictEqual(contextValues, ['repo', 'repo', 'repoNested']);
  });

  it('sorts alphabetically when configured', async () => {
    await setSetting('sortOrder', 'alphabetical');
    try {
      assert.deepStrictEqual(labels(), ['alpha', 'beta (group/sub)', 'vendor (alpha)']);
    } finally {
      await setSetting('sortOrder', undefined);
    }
  });

  it('highlights the repo open in the current window', () => {
    const alphaPath = path.join(fixture, 'alpha');
    api.provider.setCurrentRepos([alphaPath]);
    try {
      const element = api.provider.findRepoElement(alphaPath);
      assert.ok(element, 'expected to find an element for alpha');
      const item = api.provider.getTreeItem(element);
      assert.strictEqual(item.label, 'alpha');
      const icon = item.iconPath as vscode.ThemeIcon;
      assert.strictEqual(icon.id, 'source-control');
      assert.ok(icon.color, 'expected the current repo icon to be tinted');
      assert.strictEqual(item.resourceUri?.scheme, 'repodock-current');
      assert.ok(!String(item.description).includes('current'));
      assert.match((item.tooltip as vscode.MarkdownString).value, /open in this window/);
    } finally {
      api.provider.setCurrentRepos([]);
    }
  });

  it('finds elements for reveal at the top level', () => {
    const betaPath = path.join(fixture, 'group', 'sub', 'beta');
    const element = api.provider.findRepoElement(betaPath);
    assert.ok(element, 'expected to find an element for beta');
    assert.strictEqual(element.label, 'beta (group/sub)');
    assert.strictEqual(api.provider.getParent(element), undefined);
  });

  it('hides a repo through the command, then unhides it', async () => {
    // the whole loop: command writes hiddenRepos, the config listener rescans, the row goes.
    // hideRepo deliberately triggers no refresh of its own.
    const element = api.provider.findRepoElement(path.join(fixture, 'group', 'sub', 'beta'));
    assert.ok(element, 'expected an element for beta');

    await vscode.commands.executeCommand('repodock.hideRepo', element);
    await until(() => !labels().includes('beta (group/sub)'), 'beta to disappear');

    await vscode.commands.executeCommand('repodock.unhideAll');
    await until(() => labels().includes('beta (group/sub)'), 'beta to come back');
  });

  it('groups into one section per folder, in configured order', async () => {
    const inner = path.join(fixture, 'group', 'sub');
    await setSetting('directories', [fixture, inner]);
    await setSetting('groupByFolder', true);
    try {
      await until(() => rows().length === 2, 'two folder sections');
      const sections = rows();
      // section labels are tildified; on Windows the temp dir sits under the home
      // directory, so the fixture path really does shorten to ~\AppData\...
      assert.deepStrictEqual(
        sections.map((section) => section.label),
        [tildify(fixture), tildify(inner)],
      );

      // beta is found by both roots; after dedupe it belongs to the inner section only
      const innerRows = api.provider.getChildren(sections[1]);
      assert.deepStrictEqual(
        innerRows.map((row) => row.label),
        ['beta'],
      );
      const child = innerRows[0];
      assert.ok(child, 'expected a row under the inner section');
      assert.strictEqual(api.provider.getParent(child), sections[1]);
    } finally {
      await setSetting('groupByFolder', undefined);
      await setSetting('directories', [fixture]);
    }
  });

  it('honours showNestedRepos', async () => {
    await setSetting('showNestedRepos', false);
    try {
      await until(() => !labels().includes('vendor (alpha)'), 'the nested repo to be hidden');
    } finally {
      await setSetting('showNestedRepos', undefined);
    }
  });

  it('floats a pinned repo and restores it on unpin, updating icon and contextValue', async () => {
    // vendor, not alpha: alpha already sorts first, so pinning it would prove nothing
    const vendorPath = path.join(fixture, 'alpha', 'vendor');
    /** The rendered item for vendor, re-read after each command so the state is current. */
    const vendorItem = (): vscode.TreeItem => {
      const element = api.provider.findRepoElement(vendorPath);
      assert.ok(element, 'expected an element for vendor');
      return api.provider.getTreeItem(element);
    };
    const element = api.provider.findRepoElement(vendorPath);
    assert.ok(element, 'expected an element for vendor');
    assert.strictEqual(labels()[0], 'alpha', 'vendor should start last');

    await vscode.commands.executeCommand('repodock.pinRepo', element);
    assert.strictEqual(labels()[0], 'vendor (alpha)', 'a pinned repo sorts first');
    assert.strictEqual((vendorItem().iconPath as vscode.ThemeIcon).id, 'pinned');
    assert.strictEqual(vendorItem().contextValue, 'repoNested-pinned');

    await vscode.commands.executeCommand('repodock.unpinRepo', element);
    assert.strictEqual(labels()[0], 'alpha', 'unpinning restores the original order');
    assert.strictEqual((vendorItem().iconPath as vscode.ThemeIcon).id, 'source-control');
    assert.strictEqual(vendorItem().contextValue, 'repoNested');
  });

  it('rescans when directories change', async () => {
    await makeGitRepo(path.join(fixture, 'gamma'));
    await api.refresh();
    assert.ok(api.getRepos().some((repo) => repo.relPath === 'gamma'));
  });
});
