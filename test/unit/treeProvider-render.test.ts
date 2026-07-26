import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import * as vscode from 'vscode';
import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { GitState, RepoInfo } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import {
  CURRENT_REPO_SCHEME,
  CurrentRepoDecorationProvider,
  RepoTreeProvider,
} from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { required } from './helpers/required';
import { stubState as state } from './helpers/vscodeStub';

const alpha = makeRepo({ path: '/root/alpha' });
const nested = makeRepo({ path: '/root/alpha/vendor', parentRepoPath: alpha.path });

interface Rendered {
  provider: RepoTreeProvider;
  pins: PinStore;
  recency: RecencyStore;
}

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
  const recency = new RecencyStore(fakeMemento());
  const pins = new PinStore(fakeMemento());
  const provider = new RepoTreeProvider(recency, pins);
  await provider.refresh();
  return { provider, pins, recency };
}

/** The rendered TreeItem for a repo path. */
function itemFor(provider: RepoTreeProvider, repoPath: string): vscode.TreeItem {
  const element = required(provider.findRepoElement(repoPath), `an element for ${repoPath}`);
  return provider.getTreeItem(element);
}

const tooltipOf = (item: vscode.TreeItem) => (item.tooltip as vscode.MarkdownString).value;

beforeEach(() => {
  state.reset();
  state.config.set('directories', [absPath('/root')]);
});

describe('contextValue', () => {
  // the sole contract driving the view/item/context menus in package.json
  it('marks a plain repo', async () => {
    const { provider } = await render([alpha]);
    expect(itemFor(provider, alpha.path).contextValue).toBe('repo');
  });

  it('marks a nested repo', async () => {
    const { provider } = await render([alpha, nested]);
    expect(itemFor(provider, nested.path).contextValue).toBe('repoNested');
  });

  it('suffixes a pinned repo', async () => {
    const { provider, pins } = await render([alpha]);
    await pins.toggle(alpha.path);
    expect(itemFor(provider, alpha.path).contextValue).toBe('repo-pinned');
  });

  it('suffixes a pinned nested repo', async () => {
    const { provider, pins } = await render([alpha, nested]);
    await pins.toggle(nested.path);
    expect(itemFor(provider, nested.path).contextValue).toBe('repoNested-pinned');
  });
});

describe('repo rows', () => {
  it('opens the repo when clicked', async () => {
    const { provider } = await render([alpha]);
    const item = itemFor(provider, alpha.path);
    expect(item.command).toMatchObject({ command: 'repodock.open' });
    expect(item.id).toBe(`repo:${alpha.path}`);
    expect(item.collapsibleState).toBe(0); // None: repos never expand
  });

  it('has no children', async () => {
    const { provider } = await render([alpha]);
    const [row] = provider.getChildren();
    expect(provider.getChildren(required(row, 'a row'))).toEqual([]);
  });

  it('reports no parent when the list is flat', async () => {
    const { provider } = await render([alpha]);
    const [row] = provider.getChildren();
    expect(provider.getParent(required(row, 'a row'))).toBeUndefined();
  });
});

describe('nested repositories', () => {
  it('lists them by default', async () => {
    const { provider } = await render([alpha, nested]);
    expect(provider.getChildren().map((row) => row.label)).toEqual(['alpha', 'vendor (alpha)']);
  });

  it('hides them when showNestedRepos is off', async () => {
    state.config.set('showNestedRepos', false);
    const { provider } = await render([alpha, nested]);
    expect(provider.getChildren().map((row) => row.label)).toEqual(['alpha']);
  });
});

describe('the current-repo highlight', () => {
  it('tints the icon and tags the row for the decoration provider', async () => {
    const { provider } = await render([alpha]);
    provider.setCurrentRepos([alpha.path]);

    const item = itemFor(provider, alpha.path);
    expect((item.iconPath as { id: string; color?: unknown }).color).toBeDefined();
    expect((item.resourceUri as { scheme: string }).scheme).toBe(CURRENT_REPO_SCHEME);
  });

  it('leaves other rows untinted and untagged', async () => {
    const { provider } = await render([alpha]);
    const item = itemFor(provider, alpha.path);
    expect((item.iconPath as { color?: unknown }).color).toBeUndefined();
    expect(item.resourceUri).toBeUndefined();
  });

  it('colors only the scheme it tagged', () => {
    const decorations = new CurrentRepoDecorationProvider();
    const uri = (scheme: string) => ({ scheme }) as vscode.Uri;
    expect(decorations.provideFileDecoration(uri(CURRENT_REPO_SCHEME))?.color).toBeDefined();
    expect(decorations.provideFileDecoration(uri('file'))).toBeUndefined();
  });
});

describe('folder sections', () => {
  it('renders a count, an expanded state and no contextValue', async () => {
    const sub = absPath('/other');
    state.config.set('directories', [absPath('/root'), sub]);
    state.config.set('groupByFolder', true);
    const { provider } = await render([alpha, makeRepo({ path: '/other/beta', root: sub })]);

    const section = required(provider.getChildren()[0], 'a folder section');
    const item = provider.getTreeItem(section);
    expect(item.id).toBe(`folder:${absPath('/root')}`);
    expect(item.description).toBe('1');
    expect(item.collapsibleState).toBe(2); // Expanded
    // folder rows deliberately carry no contextValue, so the /^repo/ menus skip them
    expect(item.contextValue).toBeUndefined();
  });
});

describe('findRepoElement', () => {
  it('returns the same instance the tree handed out, which reveal requires', async () => {
    const { provider } = await render([alpha]);
    const [row] = provider.getChildren();
    expect(provider.findRepoElement(alpha.path)).toBe(row);
  });

  it('returns undefined for a path that was never scanned', async () => {
    const { provider } = await render([alpha]);
    expect(provider.findRepoElement('/root/ghost')).toBeUndefined();
  });
});

describe('the row description', () => {
  it('is empty with neither git state nor an open time', async () => {
    const { provider } = await render([alpha]);
    expect(itemFor(provider, alpha.path).description).toBe('');
  });

  it('shows the branch alone before the repo has been opened', async () => {
    const { provider } = await render([alpha], { [alpha.path]: makeGitState() });
    expect(itemFor(provider, alpha.path).description).toBe('main');
  });

  it('appends the open time after the branch', async () => {
    const { provider, recency } = await render([alpha], { [alpha.path]: makeGitState() });
    await recency.touch(alpha.path);
    expect(itemFor(provider, alpha.path).description).toBe('main · now');
  });
});

describe('the tooltip', () => {
  it('reports a clean working tree', async () => {
    const { provider } = await render([alpha], { [alpha.path]: makeGitState() });
    const tooltip = tooltipOf(itemFor(provider, alpha.path));
    expect(tooltip).toContain('Working tree clean');
    expect(tooltip).toContain('Branch: main');
  });

  it('counts modified and untracked files separately', async () => {
    const { provider } = await render([alpha], {
      [alpha.path]: makeGitState({ changes: 3, untracked: 2 }),
    });
    expect(tooltipOf(itemFor(provider, alpha.path))).toContain('Changes: 3 modified, 2 untracked');
  });

  it('reports ahead and behind counts only when a branch is tracked', async () => {
    const tracked = await render([alpha], {
      [alpha.path]: makeGitState({ ahead: 2, behind: 1 }),
    });
    expect(tooltipOf(itemFor(tracked.provider, alpha.path))).toContain(
      'Upstream: 2 ahead, 1 behind',
    );

    const untracked = await render([alpha], {
      [alpha.path]: makeGitState({ hasUpstream: false }),
    });
    expect(tooltipOf(itemFor(untracked.provider, alpha.path))).not.toContain('Upstream');
  });

  it('marks a detached head', async () => {
    const { provider } = await render([alpha], {
      [alpha.path]: makeGitState({ branch: 'a1b2c3d', detached: true }),
    });
    expect(tooltipOf(itemFor(provider, alpha.path))).toContain('a1b2c3d (detached)');
  });

  it('flags the pinned and current-window states', async () => {
    const { provider, pins } = await render([alpha]);
    await pins.toggle(alpha.path);
    provider.setCurrentRepos([alpha.path]);
    expect(tooltipOf(itemFor(provider, alpha.path))).toContain('open in this window, pinned');
  });

  it('omits the flag line entirely when neither applies', async () => {
    const { provider } = await render([alpha]);
    const tooltip = tooltipOf(itemFor(provider, alpha.path));
    expect(tooltip).not.toContain('pinned');
    expect(tooltip).not.toContain('open in this window');
  });

  it('shows the last-opened time in prose', async () => {
    const { provider, recency } = await render([alpha]);
    await recency.touch(alpha.path);
    expect(tooltipOf(itemFor(provider, alpha.path))).toContain('Last opened: just now');
  });

  it('escapes markdown in filesystem-derived text rather than rendering it', async () => {
    // repo names, paths and branch names come off disk; a crafted one must not inject a link.
    // No '//' in the directory name: path.resolve would collapse it and the assertion below
    // would be checking a string the code never saw.
    const evil = makeRepo({ path: '/root/[click](evil.test)' });
    const { provider } = await render([evil], {
      [evil.path]: makeGitState({ branch: '[branch](evil.test)' }),
    });

    const { value } = itemFor(provider, evil.path).tooltip as vscode.MarkdownString;
    // the stub escapes exactly as appendText does, so an unescaped bracket here would
    // mean the tooltip built that segment with appendMarkdown
    expect(value).toContain('\\[click\\]\\(evil\\.test\\)');
    expect(value).toContain('\\[branch\\]\\(evil\\.test\\)');
    expect(value).not.toContain('[click](evil.test)');
    expect(value).not.toContain('[branch](evil.test)');
  });
});
