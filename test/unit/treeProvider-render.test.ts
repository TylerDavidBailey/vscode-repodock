import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import * as vscode from 'vscode';
import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { GitState, RepoInfo } from '../../src/core/types';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { required } from './helpers/required';
import { createProvider, type Rendered } from './helpers/provider';
import { stubState as state } from './helpers/vscodeStub';

const alpha = makeRepo({ path: '/srv/repos/alpha' });
const nested = makeRepo({ path: '/srv/repos/alpha/vendor', parentRepoPath: alpha.path });

/** Scans `repos`, reports `gitStates`, and returns the provider after a refresh. */
async function render(
  repos: RepoInfo[],
  gitStates: Record<string, GitState> = {},
): Promise<Rendered> {
  vi.mocked(scanForRepos).mockImplementation((root) =>
    Promise.resolve(repos.filter((repo) => repo.root === root).map((repo) => ({ ...repo }))),
  );
  vi.mocked(loadGitStates).mockImplementation((paths, onResult) => {
    for (const repoPath of paths) onResult(repoPath, gitStates[repoPath], false);
    return Promise.resolve({ gitMissing: false });
  });
  const rendered = createProvider();
  await rendered.model.refresh();
  return rendered;
}

/** The rendered TreeItem for a repo path. */
function itemFor(sections: Rendered, repoPath: string): vscode.TreeItem {
  // a fresh render first, as VS Code would ask for after a pin or an open
  sections.provider.getChildren();
  const element = required(sections.provider.findRepoElement(repoPath), `a row for ${repoPath}`);
  return sections.provider.getTreeItem(element);
}

/** The top-level rows, from a fresh render. */
const allRows = (sections: Rendered) => sections.provider.getChildren();

const tooltipOf = (item: vscode.TreeItem) => (item.tooltip as vscode.MarkdownString).value;

beforeEach(() => {
  state.reset();
  state.config.set('directories', [absPath('/srv/repos')]);
});

describe('contextValue', () => {
  // the sole contract driving the view/item/context menus in package.json
  it('marks a plain repo', async () => {
    const sections = await render([alpha]);
    expect(itemFor(sections, alpha.path).contextValue).toBe('repo');
  });

  it('marks a nested repo', async () => {
    const sections = await render([alpha, nested]);
    expect(itemFor(sections, nested.path).contextValue).toBe('repoNested');
  });

  it('suffixes a pinned repo', async () => {
    const sections = await render([alpha]);
    await sections.pins.pin(alpha.path);
    expect(itemFor(sections, alpha.path).contextValue).toBe('repo-pinned');
  });

  it('suffixes a pinned nested repo', async () => {
    const sections = await render([alpha, nested]);
    await sections.pins.pin(nested.path);
    expect(itemFor(sections, nested.path).contextValue).toBe('repoNested-pinned');
  });

  it('is the same in the recent layout', async () => {
    state.config.set('layout', 'recent');
    const sections = await render([alpha, nested]);
    await sections.pins.pin(alpha.path);
    expect(itemFor(sections, alpha.path).contextValue).toBe('repo-pinned');
    expect(itemFor(sections, nested.path).contextValue).toBe('repoNested');
  });
});

describe('repo rows', () => {
  it('opens the repo when clicked', async () => {
    const sections = await render([alpha]);
    const item = itemFor(sections, alpha.path);
    expect(item.command).toMatchObject({ command: 'repodock.open' });
    expect(item.id).toBe(`repo:${alpha.path}`);
    expect(item.collapsibleState).toBe(0); // None: nothing nested inside
  });

  it('hands the click its own row, so the command can read the repo off it', async () => {
    const sections = await render([alpha]);
    const [row] = allRows(sections);
    const command = sections.provider.getTreeItem(required(row, 'a row')).command;
    expect(command?.arguments).toEqual([row]);
  });

  it('starts collapsed when it holds nested repos, keeping vendored code a click away', async () => {
    const sections = await render([alpha, nested]);
    expect(itemFor(sections, alpha.path).collapsibleState).toBe(1); // Collapsed
    const row = required(sections.provider.findRepoElement(alpha.path), 'a row for alpha');
    const [child] = sections.provider.getChildren(row);
    expect(child?.kind === 'repo' && child.label).toBe('vendor');
  });
});

describe('folder rows', () => {
  it('render no icon, no count, an expanded state and no contextValue', async () => {
    const other = absPath('/other');
    state.config.set('directories', [absPath('/srv/repos'), other]);
    const sections = await render([
      makeRepo({ path: '/srv/repos/group/alpha' }),
      makeRepo({ path: '/other/beta', root: other }),
    ]);

    const [root] = allRows(sections);
    const rootItem = sections.provider.getTreeItem(required(root, 'a scan-folder row'));
    expect(rootItem.id).toBe(`root:${absPath('/srv/repos')}`);
    expect(rootItem.label).toBe(absPath('/srv/repos'));
    expect(rootItem.description).toBeUndefined();
    expect(rootItem.iconPath).toBeUndefined();
    expect(rootItem.collapsibleState).toBe(2); // Expanded
    // folder rows deliberately carry no contextValue, so the /^repo/ menus skip them
    expect(rootItem.contextValue).toBeUndefined();
    expect(rootItem.command).toBeUndefined();

    const [folder] = sections.provider.getChildren(required(root, 'a scan-folder row'));
    const folderItem = sections.provider.getTreeItem(required(folder, 'a folder row'));
    expect(folderItem.id).toBe(`folder:${absPath('/srv/repos/group')}`);
    expect(folderItem.label).toBe('group');
    expect(folderItem.contextValue).toBeUndefined();
  });

  it('shorten a scan folder under the home directory to a tilde path', async () => {
    const home = path.join(os.homedir(), 'code');
    state.config.set('directories', [home, absPath('/srv/repos')]);
    const sections = await render([
      makeRepo({ path: path.join(home, 'alpha'), root: home }),
      alpha,
    ]);
    const [root] = allRows(sections);
    const item = sections.provider.getTreeItem(required(root, 'a scan-folder row'));
    expect(item.label).toBe('~' + path.sep + 'code');
    expect(item.tooltip).toBe('~' + path.sep + 'code');
  });

  it('give a scan folder and a folder at the same path different ids', async () => {
    // one configured folder inside another: VS Code rejects a tree with a duplicate id
    const inner = absPath('/srv/repos/group');
    state.config.set('directories', [absPath('/srv/repos'), inner]);
    const sections = await render([
      // listed under the outer root only, as a repo whose inner-root finding was lost
      makeRepo({ path: '/srv/repos/group/outer-only' }),
      makeRepo({ path: '/srv/repos/group/inner', root: inner }),
    ]);
    const ids: string[] = [];
    const collect = (nodes = sections.provider.getChildren()): void => {
      for (const node of nodes) {
        ids.push(String(sections.provider.getTreeItem(node).id));
        collect(sections.provider.getChildren(node));
      }
    };
    collect();
    expect(ids).toContain(`folder:${inner}`);
    expect(ids).toContain(`root:${inner}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the repo row', () => {
  const iconOf = (item: vscode.TreeItem) =>
    item.iconPath as { id: string; color?: { id: string } } | undefined;

  it('shows the name alone, whatever git reports', async () => {
    const sections = await render([alpha], {
      [alpha.path]: makeGitState({ ahead: 2, behind: 1, changes: 3, untracked: 2 }),
    });
    await sections.recency.touch(alpha.path);
    expect(itemFor(sections, alpha.path).description).toBeUndefined();
    state.config.set('layout', 'recent');
    expect(itemFor(sections, alpha.path).description).toBeUndefined();
  });

  it('carries a dim dot, pinned or not', async () => {
    const sections = await render([alpha]);
    expect(iconOf(itemFor(sections, alpha.path))).toMatchObject({
      id: 'circle-small-filled',
      color: { id: 'descriptionForeground' },
    });
    await sections.pins.pin(alpha.path);
    expect(iconOf(itemFor(sections, alpha.path))?.color?.id).toBe('descriptionForeground');
  });

  it('turns the dot blue for the repo open in this window, and sets no resourceUri', async () => {
    // a resourceUri would make VS Code draw the file-icon theme's icon on the row
    const sections = await render([alpha]);
    sections.model.setCurrentRepos([alpha.path]);
    const item = itemFor(sections, alpha.path);
    expect(item.label).toBe('alpha');
    expect(iconOf(item)?.color?.id).toBe('charts.blue');
    expect(item.resourceUri).toBeUndefined();
    expect(tooltipOf(item)).toContain('open in this window');
  });
});

describe('the tooltip', () => {
  it('reports a clean working tree', async () => {
    const sections = await render([alpha], { [alpha.path]: makeGitState() });
    const tooltip = tooltipOf(itemFor(sections, alpha.path));
    expect(tooltip).toContain('Working tree clean');
    expect(tooltip).toContain('Branch: main');
  });

  it('counts modified and untracked files separately', async () => {
    const sections = await render([alpha], {
      [alpha.path]: makeGitState({ changes: 3, untracked: 2 }),
    });
    expect(tooltipOf(itemFor(sections, alpha.path))).toContain('Changes: 3 modified, 2 untracked');
  });

  it('reports ahead and behind counts only when a branch is tracked', async () => {
    const tracked = await render([alpha], {
      [alpha.path]: makeGitState({ ahead: 2, behind: 1 }),
    });
    expect(tooltipOf(itemFor(tracked, alpha.path))).toContain('Upstream: 2 ahead, 1 behind');

    const untracked = await render([alpha], {
      [alpha.path]: makeGitState({ hasUpstream: false }),
    });
    expect(tooltipOf(itemFor(untracked, alpha.path))).not.toContain('Upstream');
  });

  it('marks a detached head', async () => {
    const sections = await render([alpha], {
      [alpha.path]: makeGitState({ branch: 'a1b2c3d', detached: true }),
    });
    expect(tooltipOf(itemFor(sections, alpha.path))).toContain('a1b2c3d (detached)');
  });

  it('flags the pinned and current-window states', async () => {
    const sections = await render([alpha]);
    await sections.pins.pin(alpha.path);
    sections.model.setCurrentRepos([alpha.path]);
    expect(tooltipOf(itemFor(sections, alpha.path))).toContain('open in this window, pinned');
  });

  it('omits the flag line entirely when neither applies', async () => {
    const sections = await render([alpha]);
    const tooltip = tooltipOf(itemFor(sections, alpha.path));
    expect(tooltip).not.toContain('pinned');
    expect(tooltip).not.toContain('open in this window');
  });

  it('shows the last-opened time in prose, in either layout', async () => {
    const sections = await render([alpha]);
    await sections.recency.touch(alpha.path);
    expect(tooltipOf(itemFor(sections, alpha.path))).toContain('Last opened: just now');
  });

  it('names a nested repo in full, though its row shows a path inside the parent', async () => {
    const sections = await render([alpha, nested]);
    const item = itemFor(sections, nested.path);
    expect(item.label).toBe('vendor');
    expect(tooltipOf(item)).toContain('**vendor**');
  });

  it('escapes markdown in filesystem-derived text rather than rendering it', async () => {
    // repo names, paths and branch names come off disk; a crafted one must not inject a link.
    // No '//' in the directory name: path.resolve would collapse it and the assertion below
    // would be checking a string the code never saw.
    const evil = makeRepo({ path: '/srv/repos/[click](evil.test)' });
    const sections = await render([evil], {
      [evil.path]: makeGitState({ branch: '[branch](evil.test)' }),
    });

    const { value } = itemFor(sections, evil.path).tooltip as vscode.MarkdownString;
    // the stub escapes exactly as appendText does, so an unescaped bracket here would
    // mean the tooltip built that segment with appendMarkdown. '.' is deliberately not
    // escaped — VS Code does not escape it either.
    expect(value).toContain('\\[click\\]\\(evil.test\\)');
    expect(value).toContain('\\[branch\\]\\(evil.test\\)');
    expect(value).not.toContain('[click](evil.test)');
    expect(value).not.toContain('[branch](evil.test)');
  });

  it('escapes the tilde tildify puts at the front of a home-relative path', async () => {
    const home = makeRepo({ path: path.join(os.homedir(), 'code', 'alpha') });
    const sections = await render([home]);

    const { value } = itemFor(sections, home.path).tooltip as vscode.MarkdownString;
    // '~' opens strikethrough in GitHub-flavored markdown, so appendText escapes it
    expect(value).toContain('\\~');
    expect(value).not.toMatch(/(^|[^\\])~/);
  });
});
