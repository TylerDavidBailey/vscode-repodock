import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { RepoDockApi } from '../../src/ext/extension';

const EXTENSION_ID = 'tylerdavidbailey.repodock';

let fixture: string;
let api: RepoDockApi;

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

describe('RepoDock', () => {
  before(async function () {
    this.timeout(120_000);
    fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-it-'));
    await makeGitRepo(path.join(fixture, 'alpha'));
    await makeGitRepo(path.join(fixture, 'group', 'sub', 'beta'));

    const extension = vscode.extensions.getExtension<RepoDockApi>(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    api = await extension.activate();

    await vscode.workspace
      .getConfiguration('repodock')
      .update('directories', [fixture], vscode.ConfigurationTarget.Global);
    await api.refresh();
    // the directories update also kicks off a config-listener rescan that can supersede
    // the refresh above (its git results are then discarded), so wait for state to land
    for (let i = 0; i < 100 && api.provider.getGitStates().size < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  });

  after(async () => {
    await fs.rm(fixture, { recursive: true, force: true });
  });

  it('registers all RepoDock commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'repodock.manageFolders',
      'repodock.addFolder',
      'repodock.removeFolder',
      'repodock.refresh',
      'repodock.sortAlphabetically',
      'repodock.sortByRecent',
      'repodock.pinRepo',
      'repodock.unpinRepo',
      'repodock.hideRepo',
      'repodock.unhideAll',
      'repodock.openInTerminal',
      'repodock.addToWorkspace',
      'repodock.open',
      'repodock.openInNewWindow',
      'repodock.copyPath',
    ]) {
      assert.ok(commands.includes(command), `missing command ${command}`);
    }
  });

  it('discovers the fixture repositories', () => {
    const rels = api
      .getRepos()
      .map((r) => r.relPath)
      .sort();
    assert.deepStrictEqual(rels, ['alpha', 'group/sub/beta']);
  });

  it('renders one flat row per repo, qualified by its folder in parentheses', () => {
    const rows = api.provider.getChildren();
    assert.deepStrictEqual(
      rows.map((row) => row.label),
      ['alpha', 'beta (group/sub)'],
    );
    assert.strictEqual(api.provider.getChildren(rows[0]).length, 0);
  });

  it('shows the branch in the repo description once git state loads', () => {
    const alpha = api.provider.getChildren()[0];
    assert.ok(alpha, 'expected a repo element');
    const item = api.provider.getTreeItem(alpha);
    assert.ok(
      typeof item.description === 'string' && item.description.startsWith('main'),
      `expected description to start with "main", got: ${String(item.description)}`,
    );
    assert.strictEqual(item.command?.command, 'repodock.open');
  });

  it('sorts alphabetically when configured', async () => {
    await vscode.workspace
      .getConfiguration('repodock')
      .update('sortOrder', 'alphabetical', vscode.ConfigurationTarget.Global);
    try {
      const rows = api.provider.getChildren();
      assert.deepStrictEqual(
        rows.map((row) => row.label),
        ['alpha', 'beta (group/sub)'],
      );
    } finally {
      await vscode.workspace
        .getConfiguration('repodock')
        .update('sortOrder', undefined, vscode.ConfigurationTarget.Global);
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

  it('rescans when directories change', async () => {
    await makeGitRepo(path.join(fixture, 'gamma'));
    await api.refresh();
    assert.ok(api.getRepos().some((r) => r.relPath === 'gamma'));
  });
});
