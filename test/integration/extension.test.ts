import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoDockApi } from '../../src/ext/extension';
import { tildify } from '../../src/ext/settings';
import type { TreeNode } from '../../src/ext/treeProvider';

const EXTENSION_ID = 'tylerdavidbailey.repodock';

let fixture: string;
let api: RepoDockApi;
/** package.json as VS Code parsed it, so the command list cannot drift from the manifest. */
let manifest: {
  contributes: {
    commands: { command: string }[];
    views: { repodock: { id: string }[] };
  };
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

/** The text of a rendered row. */
function labelOf(node: TreeNode): string {
  const { label } = api.provider.getTreeItem(node);
  return typeof label === 'string' ? label : (label?.label ?? '');
}

/** Rows as indented labels, the way the view draws them; the whole tree by default. */
function outline(nodes = api.provider.getChildren(), depth = 0): string[] {
  return nodes.flatMap((node) => [
    '  '.repeat(depth) + labelOf(node),
    ...outline(api.provider.getChildren(node), depth + 1),
  ]);
}

/** The row for a fixture repo, by its path below the fixture folder. */
function rowFor(...segments: string[]): TreeNode {
  // a fresh render first, as VS Code would ask for after a command or a rescan
  api.provider.getChildren();
  const element = api.provider.findRepoElement(path.join(fixture, ...segments));
  assert.ok(element, `expected a row for ${segments.join('/')}`);
  return element;
}

const itemFor = (...segments: string[]) => api.provider.getTreeItem(rowFor(...segments));

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
    await until(() => api.model.getGitStates().size >= 3, 'git state for every fixture repo');
  });

  after(async () => {
    // these are global settings in a shared user-data dir; leaving them set leaks the
    // temp fixture into the next run
    for (const key of ['directories', 'hiddenRepos', 'showNestedRepos', 'layout']) {
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

  it('gets its view from VS Code', async () => {
    // VS Code registers a `<view id>.focus` command per contributed view; one that is
    // missing means the manifest entry was rejected
    const registered = await vscode.commands.getCommands(true);
    const views = manifest.contributes.views.repodock.map((view) => view.id);
    assert.deepStrictEqual(views, ['repodock.repos']);
    assert.ok(registered.includes('repodock.repos.focus'));
  });

  it('discovers the fixture repositories', () => {
    const rels = api
      .getRepos()
      .map((repo) => repo.relPath)
      .sort();
    assert.deepStrictEqual(rels, ['alpha', 'alpha/vendor', 'group/sub/beta']);
  });

  it('lays the repos out the way they sit on disk while nothing is pinned', () => {
    // One scan folder, so no row for it; the group/sub chain is one row; vendor hangs
    // under its parent repo.
    assert.deepStrictEqual(outline(), ['group/sub', '  beta', 'alpha', '  vendor']);
  });

  it('shows the name alone on the row, and the branch in the tooltip once git state loads', () => {
    const item = itemFor('alpha');
    assert.strictEqual(item.description, undefined);
    assert.match((item.tooltip as vscode.MarkdownString).value, /Branch: main/);
    assert.strictEqual(item.command?.command, 'repodock.open');
  });

  it('reports uncommitted files in the tooltip, and leaves the row itself undecorated', async () => {
    const alphaPath = path.join(fixture, 'alpha');
    await fs.writeFile(path.join(alphaPath, 'scratch.txt'), 'new\n');
    try {
      await api.refresh();
      // vendor/ is untracked too, since alpha does not ignore the repo nested in it
      await until(
        () => (itemFor('alpha').tooltip as vscode.MarkdownString).value.includes('2 untracked'),
        'alpha to report its untracked files',
      );
      assert.strictEqual(itemFor('alpha').resourceUri, undefined);
    } finally {
      await fs.rm(path.join(alphaPath, 'scratch.txt'));
      await api.refresh();
    }
  });

  it('tags rows with the contextValue the row menus match on', () => {
    assert.strictEqual(itemFor('alpha').contextValue, 'repo');
    assert.strictEqual(itemFor('group', 'sub', 'beta').contextValue, 'repo');
    // vendor sits inside alpha, so it is the nested one
    assert.strictEqual(itemFor('alpha', 'vendor').contextValue, 'repoNested');
  });

  it('marks the repo open in the current window with a blue dot', () => {
    const alphaPath = path.join(fixture, 'alpha');
    api.model.setCurrentRepos([alphaPath]);
    try {
      const item = itemFor('alpha');
      // no resourceUri, which would bring the file-icon theme's icon with it
      assert.strictEqual(item.label, 'alpha');
      const icon = item.iconPath as vscode.ThemeIcon;
      assert.strictEqual(icon.id, 'circle-small-filled');
      assert.strictEqual(icon.color?.id, 'charts.blue');
      assert.strictEqual(item.resourceUri, undefined);
      assert.match((item.tooltip as vscode.MarkdownString).value, /open in this window/);
    } finally {
      api.model.setCurrentRepos([]);
    }
  });

  it('reports the rows above a repo, up to the top', () => {
    const chain: string[] = [];
    let node: TreeNode | undefined = rowFor('alpha', 'vendor');
    while (node) {
      chain.push(labelOf(node));
      node = api.provider.getParent(node);
    }
    assert.deepStrictEqual(chain, ['vendor', 'alpha']);
  });

  it('hides a repo through the command, then unhides it', async () => {
    // the whole loop: command writes hiddenRepos, the config listener rescans, the row goes.
    // hideRepo deliberately triggers no refresh of its own.
    const hasBeta = () => outline().includes('  beta');
    await vscode.commands.executeCommand('repodock.hideRepo', rowFor('group', 'sub', 'beta'));
    await until(() => !hasBeta(), 'beta to disappear');

    await vscode.commands.executeCommand('repodock.unhideAll');
    await until(hasBeta, 'beta to come back');
  });

  it('gives each scan folder a row once two of them hold repos', async () => {
    const inner = path.join(fixture, 'group', 'sub');
    await setSetting('directories', [fixture, inner]);
    try {
      await until(() => outline().includes(tildify(inner)), 'two scan-folder rows');
      // folder labels are tildified; on Windows the temp dir sits under the home
      // directory, so the fixture path really does shorten to ~\AppData\...
      // beta is found by both folders; after dedupe it belongs to the inner one only
      assert.deepStrictEqual(outline(), [
        tildify(fixture),
        '  alpha',
        '    vendor',
        tildify(inner),
        '  beta',
      ]);
    } finally {
      await setSetting('directories', [fixture]);
    }
  });

  it('honours showNestedRepos', async () => {
    await setSetting('showNestedRepos', false);
    try {
      await until(() => !outline().includes('  vendor'), 'the nested repo to be hidden');
    } finally {
      await setSetting('showNestedRepos', undefined);
    }
  });

  it('moves a pinned repo to the top, past a gap, until it is unpinned', async () => {
    await vscode.commands.executeCommand('repodock.pinRepo', rowFor('alpha', 'vendor'));
    assert.deepStrictEqual(outline(), ['vendor', '', 'group/sub', '  beta', 'alpha']);
    assert.strictEqual(itemFor('alpha', 'vendor').contextValue, 'repoNested-pinned');

    // unpinned from its own row, the way the row button does it
    await vscode.commands.executeCommand('repodock.unpinRepo', rowFor('alpha', 'vendor'));
    assert.deepStrictEqual(outline(), ['group/sub', '  beta', 'alpha', '  vendor']);
    assert.strictEqual(itemFor('alpha', 'vendor').contextValue, 'repoNested');
  });

  it('switches layout through the title-bar commands, via the real settings loop', async () => {
    // the command only writes repodock.layout; the config listener does the redraw
    await vscode.commands.executeCommand('repodock.showRecent');
    try {
      await until(() => outline().join() === 'alpha,beta,vendor', 'the flat recent layout');
    } finally {
      await vscode.commands.executeCommand('repodock.showFolders');
    }
    await until(() => outline()[0] === 'group/sub', 'the folder layout');
  });

  it('rescans when directories change', async () => {
    await makeGitRepo(path.join(fixture, 'gamma'));
    await api.refresh();
    assert.ok(api.getRepos().some((repo) => repo.relPath === 'gamma'));
  });
});
