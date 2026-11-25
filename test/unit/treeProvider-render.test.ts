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
import { REPO_URI_SCHEME, RepoDecorationProvider, type Section } from '../../src/ext/treeProvider';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { required } from './helpers/required';
import { createProvider, sectionRows, type Rendered } from './helpers/sections';
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

const SECTIONS: Section[] = ['pinned', 'recent', 'all'];

/** The rendered TreeItem for a repo path, in All Repositories unless a section is given. */
function itemFor(sections: Rendered, repoPath: string, section: Section = 'all'): vscode.TreeItem {
  // a fresh render first, as VS Code would ask for after a pin or an open
  sections.provider.getChildren();
  const element = required(
    sections.provider.findRepoElement(repoPath, section),
    `a ${section} row for ${repoPath}`,
  );
  return sections.provider.getTreeItem(element);
}

/** The top-level rows of All Repositories, from a fresh render. */
const allRows = (sections: Rendered) => sectionRows(sections.provider, 'all');

const tooltipOf = (item: vscode.TreeItem) => (item.tooltip as vscode.MarkdownString).value;
const iconOf = (item: vscode.TreeItem) => item.iconPath as { id: string; color?: unknown };

/** What the decoration provider draws for a row: undefined when the row is undecorated. */
function decorationOf(item: vscode.TreeItem): vscode.FileDecoration | undefined {
  if (item.resourceUri === undefined) return undefined;
  return new RepoDecorationProvider().provideFileDecoration(item.resourceUri);
}

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

  it('is the same for a repo in every section that lists it', async () => {
    const sections = await render([alpha]);
    await sections.pins.pin(alpha.path);
    await sections.recency.touch(alpha.path);
    for (const section of SECTIONS) {
      expect(itemFor(sections, alpha.path, section).contextValue).toBe('repo-pinned');
    }
  });
});

describe('repo rows', () => {
  it('opens the repo when clicked', async () => {
    const sections = await render([alpha]);
    const item = itemFor(sections, alpha.path);
    expect(item.command).toMatchObject({ command: 'repodock.open' });
    expect(item.id).toBe(`all:${alpha.path}`);
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
    expect(sections.provider.getChildren(row).map((child) => child.label)).toEqual(['vendor']);
  });

  it('uses the git icon, and a pin for a pinned repo in every section', async () => {
    const sections = await render([alpha]);
    expect(iconOf(itemFor(sections, alpha.path)).id).toBe('source-control');

    await sections.pins.pin(alpha.path);
    await sections.recency.touch(alpha.path);
    for (const section of SECTIONS) {
      expect(iconOf(itemFor(sections, alpha.path, section)).id).toBe('pinned');
    }
  });
});

describe('folder rows', () => {
  it('render a count, an expanded state and no contextValue', async () => {
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
    expect(rootItem.description).toBe('1');
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

describe('the row decoration', () => {
  it('is absent for a clean repo that is not open here', async () => {
    const sections = await render([alpha], { [alpha.path]: makeGitState() });
    const item = itemFor(sections, alpha.path);
    expect(item.resourceUri).toBeUndefined();
    expect(iconOf(item).color).toBeUndefined();
  });

  it('counts modified and untracked files together in the badge', async () => {
    const sections = await render([alpha], {
      [alpha.path]: makeGitState({ changes: 3, untracked: 2 }),
    });
    const decoration = decorationOf(itemFor(sections, alpha.path));
    expect(decoration?.badge).toBe('5');
    expect(decoration?.tooltip).toBe('5 uncommitted changes');
    // only the current repo is colored; a count alone leaves the label as it was
    expect(decoration?.color).toBeUndefined();
  });

  it('words a single change in the singular', async () => {
    const sections = await render([alpha], { [alpha.path]: makeGitState({ untracked: 1 }) });
    expect(decorationOf(itemFor(sections, alpha.path))?.tooltip).toBe('1 uncommitted change');
  });

  it('caps the badge at two characters, which is all VS Code accepts', async () => {
    const sections = await render([alpha], {
      [alpha.path]: makeGitState({ changes: 250, untracked: 50 }),
    });
    const decoration = decorationOf(itemFor(sections, alpha.path));
    expect(decoration?.badge).toBe('99');
    // the exact count is still one hover away
    expect(decoration?.tooltip).toBe('300 uncommitted changes');
  });

  it('colors the repo open in this window, icon and label both', async () => {
    const sections = await render([alpha]);
    sections.model.setCurrentRepos([alpha.path]);
    const item = itemFor(sections, alpha.path);
    expect(iconOf(item).color).toBeDefined();
    const decoration = decorationOf(item);
    expect(decoration?.color).toBeDefined();
    expect(decoration?.badge).toBeUndefined();
  });

  it('shows both the color and the count for a current repo with changes', async () => {
    const sections = await render([alpha], { [alpha.path]: makeGitState({ changes: 2 }) });
    sections.model.setCurrentRepos([alpha.path]);
    const decoration = decorationOf(itemFor(sections, alpha.path));
    expect(decoration?.color).toBeDefined();
    expect(decoration?.badge).toBe('2');
  });

  it('gets a different uri when the count changes, which is what makes VS Code redraw it', async () => {
    const before = await render([alpha], { [alpha.path]: makeGitState({ changes: 1 }) });
    const after = await render([alpha], { [alpha.path]: makeGitState({ changes: 2 }) });
    const uriOf = (sections: Rendered) =>
      itemFor(sections, alpha.path).resourceUri as unknown as { scheme: string; query: string };
    expect(uriOf(before).scheme).toBe(REPO_URI_SCHEME);
    expect(uriOf(before).query).not.toBe(uriOf(after).query);
  });

  it('decorates only the scheme it tagged', () => {
    const decorations = new RepoDecorationProvider();
    expect(decorations.provideFileDecoration(vscode.Uri.file(alpha.path))).toBeUndefined();
  });

  it('draws nothing for a tagged uri that carries no state', () => {
    const uri = vscode.Uri.file(alpha.path).with({ scheme: REPO_URI_SCHEME, query: '' });
    const decoration = new RepoDecorationProvider().provideFileDecoration(uri);
    expect(decoration?.badge).toBeUndefined();
    expect(decoration?.color).toBeUndefined();
  });

  it('ignores a count that is not a number', () => {
    const uri = vscode.Uri.file(alpha.path).with({
      scheme: REPO_URI_SCHEME,
      query: 'current=0&changes=lots',
    });
    expect(new RepoDecorationProvider().provideFileDecoration(uri)?.badge).toBeUndefined();
  });
});

describe('the row description', () => {
  it('is empty with no git state', async () => {
    const sections = await render([alpha]);
    expect(itemFor(sections, alpha.path).description).toBe('');
  });

  it('shows the branch and how far it is from its upstream', async () => {
    const sections = await render([alpha], {
      [alpha.path]: makeGitState({ ahead: 2, behind: 1 }),
    });
    expect(itemFor(sections, alpha.path).description).toBe('main ↑2 ↓1');
  });

  it('shows the last-opened time in Recent only, where it explains the order', async () => {
    const sections = await render([alpha], { [alpha.path]: makeGitState() });
    await sections.pins.pin(alpha.path);
    await sections.recency.touch(alpha.path);
    expect(itemFor(sections, alpha.path, 'recent').description).toBe('main · now');
    expect(itemFor(sections, alpha.path, 'all').description).toBe('main');
    expect(itemFor(sections, alpha.path, 'pinned').description).toBe('main');
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

  it('shows the last-opened time in prose, in every section', async () => {
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
