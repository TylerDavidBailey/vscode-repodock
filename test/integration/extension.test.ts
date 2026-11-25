import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoDockApi } from '../../src/ext/extension';
import { tildify } from '../../src/ext/settings';
import type { Section, TreeNode } from '../../src/ext/treeProvider';

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

/** The rows under one section heading, as an outline. Empty when the section is not shown. */
function section(name: Section): string[] {
  const heading = api.provider
    .getChildren()
    .find((node) => node.kind === 'section' && node.section === name);
  return heading ? outline(api.provider.getChildren(heading)) : [];
}

/** The row for a fixture repo in a section, by its path below the fixture folder. */
function rowFor(name: Section, ...segments: string[]): TreeNode {
  // a fresh render first, as VS Code would ask for after a command or a rescan
  api.provider.getChildren();
  const element = api.provider.findRepoElement(path.join(fixture, ...segments), name);
  assert.ok(element, `expected a ${name} row for ${segments.join('/')}`);
  return element;
}

const itemFor = (name: Section, ...segments: string[]) =>
  api.provider.getTreeItem(rowFor(name, ...segments));

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
    for (const key of ['directories', 'hiddenRepos', 'showNestedRepos', 'recentCount']) {
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

  it('shows one section while nothing is pinned or recent, laid out the way the repos sit on disk', () => {
    // the test window opens no folder, so no repo was recorded as opened. One scan folder,
    // so no row for it; the group/sub chain is one row; vendor hangs under its parent repo.
    assert.deepStrictEqual(outline(), [
      'All Repositories',
      '  group/sub',
      '    beta',
      '  alpha',
      '    vendor',
    ]);
  });

  it('shows the branch in the repo description once git state loads', () => {
    const item = itemFor('all', 'alpha');
    assert.ok(
      typeof item.description === 'string' && item.description.startsWith('main'),
      `expected description to start with "main", got: ${String(item.description)}`,
    );
    assert.strictEqual(item.command?.command, 'repodock.open');
  });

  it('badges a repo that has uncommitted files, through the real decoration API', async () => {
    const alphaPath = path.join(fixture, 'alpha');
    await fs.writeFile(path.join(alphaPath, 'scratch.txt'), 'new\n');
    try {
      await api.refresh();
      await until(
        () => itemFor('all', 'alpha').resourceUri !== undefined,
        'alpha to be tagged for decoration',
      );
      const uri = itemFor('all', 'alpha').resourceUri;
      assert.strictEqual(uri?.scheme, 'repodock-repo');
      // a real Uri round-trips the query the decoration provider reads the count from;
      // vendor/ is untracked too, since alpha does not ignore the repo nested in it
      assert.match(uri.query, /changes=2/);
    } finally {
      await fs.rm(path.join(alphaPath, 'scratch.txt'));
      await api.refresh();
    }
  });

  it('tags rows with the contextValue the row menus match on', () => {
    assert.strictEqual(itemFor('all', 'alpha').contextValue, 'repo');
    assert.strictEqual(itemFor('all', 'group', 'sub', 'beta').contextValue, 'repo');
    // vendor sits inside alpha, so it is the nested one
    assert.strictEqual(itemFor('all', 'alpha', 'vendor').contextValue, 'repoNested');
  });

  it('highlights the repo open in the current window', () => {
    const alphaPath = path.join(fixture, 'alpha');
    api.model.setCurrentRepos([alphaPath]);
    try {
      const item = itemFor('all', 'alpha');
      assert.strictEqual(item.label, 'alpha');
      const icon = item.iconPath as vscode.ThemeIcon;
      assert.strictEqual(icon.id, 'source-control');
      assert.ok(icon.color, 'expected the current repo icon to be tinted');
      assert.strictEqual(item.resourceUri?.scheme, 'repodock-repo');
      assert.match(item.resourceUri.query, /current=1/);
      assert.match((item.tooltip as vscode.MarkdownString).value, /open in this window/);
    } finally {
      api.model.setCurrentRepos([]);
    }
  });

  it('reports the rows above a repo, up to its section heading', () => {
    const chain: string[] = [];
    let node: TreeNode | undefined = rowFor('all', 'alpha', 'vendor');
    while (node) {
      chain.push(labelOf(node));
      node = api.provider.getParent(node);
    }
    assert.deepStrictEqual(chain, ['vendor', 'alpha', 'All Repositories']);
  });

  it('hides a repo through the command, then unhides it', async () => {
    // the whole loop: command writes hiddenRepos, the config listener rescans, the row goes.
    // hideRepo deliberately triggers no refresh of its own.
    const hasBeta = () => section('all').includes('  beta');
    await vscode.commands.executeCommand(
      'repodock.hideRepo',
      rowFor('all', 'group', 'sub', 'beta'),
    );
    await until(() => !hasBeta(), 'beta to disappear');

    await vscode.commands.executeCommand('repodock.unhideAll');
    await until(hasBeta, 'beta to come back');
  });

  it('gives each scan folder a row once two of them hold repos', async () => {
    const inner = path.join(fixture, 'group', 'sub');
    await setSetting('directories', [fixture, inner]);
    try {
      await until(() => section('all').includes(tildify(inner)), 'two scan-folder rows');
      // folder labels are tildified; on Windows the temp dir sits under the home
      // directory, so the fixture path really does shorten to ~\AppData\...
      // beta is found by both folders; after dedupe it belongs to the inner one only
      assert.deepStrictEqual(section('all'), [
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
      await until(() => !section('all').includes('  vendor'), 'the nested repo to be hidden');
    } finally {
      await setSetting('showNestedRepos', undefined);
    }
  });

  it('adds a Pinned section for a pinned repo and marks it everywhere, until it is unpinned', async () => {
    await vscode.commands.executeCommand('repodock.pinRepo', rowFor('all', 'alpha', 'vendor'));
    assert.deepStrictEqual(section('pinned'), ['vendor']);
    assert.strictEqual(outline()[0], 'Pinned');
    for (const name of ['pinned', 'all'] as const) {
      const item = itemFor(name, 'alpha', 'vendor');
      assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'pinned');
      assert.strictEqual(item.contextValue, 'repoNested-pinned');
    }
    // the two rows of one repo need different ids, or VS Code rejects the tree
    assert.notStrictEqual(
      itemFor('pinned', 'alpha', 'vendor').id,
      itemFor('all', 'alpha', 'vendor').id,
    );

    // unpinned from its Pinned row, the way the row button does it
    await vscode.commands.executeCommand('repodock.unpinRepo', rowFor('pinned', 'alpha', 'vendor'));
    assert.deepStrictEqual(section('pinned'), []);
    assert.strictEqual(outline()[0], 'All Repositories');
    const item = itemFor('all', 'alpha', 'vendor');
    assert.strictEqual((item.iconPath as vscode.ThemeIcon).id, 'source-control');
    assert.strictEqual(item.contextValue, 'repoNested');
  });

  it('rescans when directories change', async () => {
    await makeGitRepo(path.join(fixture, 'gamma'));
    await api.refresh();
    assert.ok(api.getRepos().some((repo) => repo.relPath === 'gamma'));
  });
});
