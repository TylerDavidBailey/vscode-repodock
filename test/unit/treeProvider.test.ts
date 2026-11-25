import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { GitState, RepoInfo } from '../../src/core/types';
import type { RepoTreeProvider, Section, TreeNode } from '../../src/ext/treeProvider';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { required } from './helpers/required';
import { createProvider, labelOf, outline, sectionRows, type Rendered } from './helpers/sections';
import { stubState as state } from './helpers/vscodeStub';

const CODE = absPath('/srv/code');
const WORK = absPath('/srv/work');
const web = makeRepo({ path: '/srv/code/frontend/web', root: CODE });
const api = makeRepo({ path: '/srv/code/services/api', root: CODE });
const gateway = makeRepo({ path: '/srv/code/services/gateway', root: CODE });
const sdk = makeRepo({
  path: '/srv/code/services/gateway/vendor/sdk',
  root: CODE,
  parentRepoPath: gateway.path,
});
const dotfiles = makeRepo({ path: '/srv/code/dotfiles', root: CODE });
const portal = makeRepo({ path: '/srv/work/portal', root: WORK });
const EVERYTHING = [web, api, gateway, sdk, dotfiles, portal];

/** Scans `repos`, reports `gitStates`, and returns the provider after a refresh. */
async function render(
  repos: RepoInfo[] = EVERYTHING,
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

/** The labels of the rows directly under a section heading. */
const labels = (provider: RepoTreeProvider, section: Section) =>
  sectionRows(provider, section).map((row) => row.label);

/** The top-level rows as "label count", which is how each section heading reads. */
const headings = (provider: RepoTreeProvider) =>
  provider.getChildren().map((node) => {
    const item = provider.getTreeItem(node);
    return `${labelOf(provider, node)} ${String(item.description)}`;
  });

/** Opens `repos` one second apart, so the last one is the most recent. */
async function openInOrder(recency: Rendered['recency'], repos: RepoInfo[]): Promise<void> {
  vi.useFakeTimers();
  try {
    for (const repo of repos) {
      vi.advanceTimersByTime(1000);
      await recency.touch(repo.path);
    }
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  state.reset();
  state.config.set('directories', [CODE, WORK]);
});

describe('the section headings', () => {
  it('are absent while there is nothing to list, which leaves the welcome text showing', async () => {
    const { provider } = await render([]);
    expect(provider.getChildren()).toEqual([]);
  });

  it('show only All Repositories until something is pinned or opened', async () => {
    const { provider } = await render();
    expect(headings(provider)).toEqual(['All Repositories 6']);
  });

  it('appear in the order Pinned, Recent, All Repositories, each with its count', async () => {
    const { provider, pins, recency } = await render();
    await pins.pin(api.path);
    await openInOrder(recency, [web, portal]);
    expect(headings(provider)).toEqual(['Pinned 1', 'Recent 2', 'All Repositories 6']);
  });

  it('start expanded, carry a stable id, and stay out of the repo menus', async () => {
    const { provider, pins } = await render();
    await pins.pin(api.path);
    const [pinned, all] = provider.getChildren();
    const item = provider.getTreeItem(required(pinned, 'the Pinned heading'));
    expect(item.id).toBe('section:pinned');
    expect(item.collapsibleState).toBe(2); // Expanded
    // headings deliberately carry no contextValue, so the /^repo/ menus skip them
    expect(item.contextValue).toBeUndefined();
    expect(item.command).toBeUndefined();
    expect(provider.getTreeItem(required(all, 'the All heading')).id).toBe('section:all');
  });

  it('come and go as the last repo leaves a section or the first one enters it', async () => {
    const { provider, pins } = await render();
    await pins.pin(api.path);
    expect(headings(provider)).toContain('Pinned 1');
    await pins.unpin(api.path);
    expect(headings(provider)).toEqual(['All Repositories 6']);
  });
});

describe('the Pinned section', () => {
  it('lists pinned repos by name, wherever they live', async () => {
    const { provider, pins } = await render();
    await pins.pin(portal.path);
    await pins.pin(api.path);
    expect(labels(provider, 'pinned')).toEqual(['api', 'portal']);
  });

  it('is a flat list: a pinned repo shows no nested repos under it', async () => {
    const { provider, pins } = await render();
    await pins.pin(gateway.path);
    const [row] = sectionRows(provider, 'pinned');
    expect(provider.getChildren(required(row, 'a pinned row'))).toEqual([]);
    expect(provider.getTreeItem(required(row, 'a pinned row')).collapsibleState).toBe(0);
  });

  it('drops a pin whose repo has been hidden, and brings it back when unhidden', async () => {
    const { provider, pins, model } = await render();
    await pins.pin(api.path);
    state.config.set('hiddenRepos', [api.path]);
    await model.refresh();
    expect(labels(provider, 'pinned')).toEqual([]);

    state.config.set('hiddenRepos', []);
    await model.refresh();
    expect(labels(provider, 'pinned')).toEqual(['api']);
  });

  it('drops a pinned nested repo while nested repos are turned off', async () => {
    const { provider, pins } = await render();
    await pins.pin(sdk.path);
    expect(labels(provider, 'pinned')).toEqual(['sdk']);
    state.config.set('showNestedRepos', false);
    expect(labels(provider, 'pinned')).toEqual([]);
  });
});

describe('the Recent section', () => {
  it('lists opened repos newest first, and nothing that was never opened', async () => {
    const { provider, recency } = await render();
    await openInOrder(recency, [dotfiles, web, portal]);
    expect(labels(provider, 'recent')).toEqual(['portal', 'web', 'dotfiles']);
  });

  it('stops at recentCount, and follows the setting', async () => {
    const { provider, recency } = await render();
    await openInOrder(recency, [dotfiles, web, portal, api]);
    state.config.set('recentCount', 2);
    expect(labels(provider, 'recent')).toEqual(['api', 'portal']);
    expect(headings(provider)).toContain('Recent 2');
    state.config.set('recentCount', 3);
    expect(labels(provider, 'recent')).toEqual(['api', 'portal', 'web']);
  });

  it('lists a pinned repo too, since it reports what was opened', async () => {
    const { provider, recency, pins } = await render();
    await pins.pin(api.path);
    await recency.touch(api.path);
    expect(labels(provider, 'recent')).toEqual(['api']);
  });

  it('forgets a repo that is no longer scanned, without losing its place in history', async () => {
    const { provider, recency, model } = await render();
    await recency.touch(web.path);
    vi.mocked(scanForRepos).mockResolvedValue([]);
    await model.refresh();
    expect(labels(provider, 'recent')).toEqual([]);

    // the folder comes back (a drive remounts): the row returns without being reopened
    vi.mocked(scanForRepos).mockImplementation((root) =>
      Promise.resolve(root === CODE ? [{ ...web }] : []),
    );
    await model.refresh();
    expect(labels(provider, 'recent')).toEqual(['web']);
  });
});

describe('the All Repositories section', () => {
  const tree = (provider: RepoTreeProvider) => outline(provider, sectionRows(provider, 'all'));

  it('mirrors the disk: scan folder, folders, repos, with nested repos under their parent', async () => {
    const { provider } = await render();
    expect(tree(provider)).toEqual([
      CODE,
      '  frontend',
      '    web',
      '  services',
      '    api',
      '    gateway',
      '      vendor/sdk',
      '  dotfiles',
      WORK,
      '  portal',
    ]);
  });

  it('drops the scan-folder row when only one folder holds repos', async () => {
    const { provider } = await render([web, dotfiles]);
    expect(tree(provider)).toEqual(['frontend', '  web', 'dotfiles']);
  });

  it('lists a repo once when overlapping folders both find it, under the nearer one', async () => {
    const services = absPath('/srv/code/services');
    state.config.set('directories', [CODE, services]);
    const apiViaServices = makeRepo({ path: api.path, root: services });
    const { provider } = await render([web, api, apiViaServices]);
    expect(tree(provider)).toEqual([CODE, '  frontend', '    web', services, '  api']);
    expect(headings(provider)).toEqual(['All Repositories 2']);
  });

  it('hides nested repos, and the twistie that led to them, when showNestedRepos is off', async () => {
    state.config.set('showNestedRepos', false);
    const { provider } = await render();
    expect(tree(provider)).not.toContain('      vendor/sdk');
    const row = required(provider.findRepoElement(gateway.path), 'a row for gateway');
    expect(provider.getTreeItem(row).collapsibleState).toBe(0);
  });

  it('reports each row parent, up to the section heading', async () => {
    const { provider } = await render();
    const chain: string[] = [];
    let node: TreeNode | undefined = provider.findRepoElement(sdk.path);
    while (node) {
      chain.push(labelOf(provider, node));
      node = provider.getParent(node);
    }
    expect(chain).toEqual(['vendor/sdk', 'gateway', 'services', CODE, 'All Repositories']);
  });

  it('reports no parent for a section heading', async () => {
    const { provider } = await render();
    const [heading] = provider.getChildren();
    expect(provider.getParent(required(heading, 'a heading'))).toBeUndefined();
  });
});

describe('a repo listed in more than one section', () => {
  it('gets a row in each, with ids that cannot collide in the one tree', async () => {
    const { provider, pins, recency } = await render();
    await pins.pin(api.path);
    await recency.touch(api.path);

    const ids = (['pinned', 'recent', 'all'] as const).map((section) => {
      const row = required(provider.findRepoElement(api.path, section), `a ${section} row`);
      return provider.getTreeItem(row).id;
    });
    expect(ids).toEqual([`pinned:${api.path}`, `recent:${api.path}`, `all:${api.path}`]);
  });

  it('gives every row in the tree a distinct id', async () => {
    const { provider, pins, recency } = await render();
    for (const repo of EVERYTHING) {
      await pins.pin(repo.path);
      await recency.touch(repo.path);
    }
    const ids: string[] = [];
    const collect = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        ids.push(String(provider.getTreeItem(node).id));
        collect(provider.getChildren(node));
      }
    };
    collect(provider.getChildren());
    expect(ids.length).toBeGreaterThan(EVERYTHING.length * 3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hands each row its own element, so a command knows which row it came from', async () => {
    const { provider, pins } = await render();
    await pins.pin(api.path);
    const pinned = provider.findRepoElement(api.path, 'pinned');
    const all = provider.findRepoElement(api.path, 'all');
    expect(pinned).toBeDefined();
    expect(pinned).not.toBe(all);
    expect(pinned?.repo.path).toBe(all?.repo.path);
  });
});

describe('same-named repos', () => {
  const workWeb = makeRepo({ path: '/srv/work/web', root: WORK });

  it('are told apart by folder in the flat sections', async () => {
    const { provider, pins } = await render([web, workWeb, api]);
    for (const repo of [web, workWeb, api]) await pins.pin(repo.path);
    expect(labels(provider, 'pinned')).toEqual(['api', 'web (frontend)', 'web (work)']);
  });

  it('keep the bare name when only one of them is in the section', async () => {
    const { provider, pins } = await render([web, workWeb]);
    await pins.pin(web.path);
    expect(labels(provider, 'pinned')).toEqual(['web']);
  });

  it('keep the bare name in All Repositories, where the folders above already tell', async () => {
    const { provider } = await render([web, workWeb]);
    expect(outline(provider, sectionRows(provider, 'all'))).toEqual([
      CODE,
      '  frontend',
      '    web',
      WORK,
      '  web',
    ]);
  });
});

describe('findRepoElement', () => {
  it('returns the same instance the tree handed out', async () => {
    const { provider } = await render([dotfiles]);
    const [row] = sectionRows(provider, 'all');
    expect(provider.findRepoElement(dotfiles.path)).toBe(row);
  });

  it('finds a row before the view has ever rendered', async () => {
    const { provider } = await render();
    expect(provider.findRepoElement(sdk.path)?.label).toBe('vendor/sdk');
  });

  it('looks in All Repositories unless told otherwise, and answers per section', async () => {
    const { provider } = await render();
    expect(provider.findRepoElement(web.path)).toBeDefined();
    expect(provider.findRepoElement(web.path, 'pinned')).toBeUndefined();
    expect(provider.findRepoElement(web.path, 'recent')).toBeUndefined();
  });

  it('returns undefined for a path that was never scanned', async () => {
    const { provider } = await render();
    expect(provider.findRepoElement(absPath('/srv/code/ghost'))).toBeUndefined();
  });
});

describe('re-rendering', () => {
  /** Records what the view asks VS Code to redraw: 'all' for a full render, else the row id. */
  function watch(provider: RepoTreeProvider): string[] {
    const events: string[] = [];
    provider.onDidChangeTreeData((node) =>
      events.push(node === undefined ? 'all' : String(provider.getTreeItem(node).id)),
    );
    return events;
  }

  it('redraws everything when a scan finds a different repo list', async () => {
    const { provider, model } = await render([web]);
    const events = watch(provider);
    vi.mocked(scanForRepos).mockImplementation((root) =>
      Promise.resolve(root === CODE ? [{ ...web }, { ...api }] : []),
    );
    await model.refresh();
    expect(events).toContain('all');
  });

  it('redraws each row of a repo whose git state was reloaded, in every section listing it', async () => {
    const { provider, model, pins } = await render([web, api], { [web.path]: makeGitState() });
    await pins.pin(web.path);
    // VS Code asks the view for its rows after a full redraw; a row that was never
    // handed out has nothing on screen to update
    provider.getChildren();
    const events = watch(provider);

    await model.refresh(); // same repos, so git state is all that moves

    expect(events.sort()).toEqual(
      [`all:${api.path}`, `all:${web.path}`, `pinned:${web.path}`].sort(),
    );
  });

  it('stops listening to the model once disposed', async () => {
    const { provider, model } = await render([web]);
    const events = watch(provider);
    provider.dispose();
    vi.mocked(scanForRepos).mockResolvedValue([]);
    await model.refresh();
    expect(events).toEqual([]);
  });
});

describe('remembered fold state', () => {
  const stateOf = (provider: RepoTreeProvider, node: TreeNode | undefined) =>
    provider.getTreeItem(required(node, 'a row')).collapsibleState;
  const COLLAPSED = 1;
  const EXPANDED = 2;

  it('renders a section, a folder, and a repo the way the user last left each', async () => {
    const { provider, expansion } = await render();
    const [heading] = provider.getChildren();
    const [root] = sectionRows(provider, 'all');
    const repo = provider.findRepoElement(gateway.path);
    // the defaults: sections and folders open, a repo holding nested repos closed
    expect(stateOf(provider, heading)).toBe(EXPANDED);
    expect(stateOf(provider, root)).toBe(EXPANDED);
    expect(stateOf(provider, repo)).toBe(COLLAPSED);

    await expansion.set(provider.idOf(required(heading, 'the heading')), false);
    await expansion.set(provider.idOf(required(root, 'a scan-folder row')), false);
    await expansion.set(provider.idOf(required(repo, 'a row for gateway')), true);

    expect(stateOf(provider, heading)).toBe(COLLAPSED);
    expect(stateOf(provider, root)).toBe(COLLAPSED);
    expect(stateOf(provider, repo)).toBe(EXPANDED);
  });

  it('never makes a repo with nothing nested in it expandable', async () => {
    const { provider, expansion } = await render();
    const row = required(provider.findRepoElement(web.path), 'a row for web');
    await expansion.set(provider.idOf(row), true);
    expect(stateOf(provider, row)).toBe(0); // None
  });

  it('remembers each section of a repo apart, since each row folds on its own', async () => {
    const { provider, pins } = await render();
    await pins.pin(gateway.path);
    provider.getChildren();
    const pinned = required(provider.findRepoElement(gateway.path, 'pinned'), 'a pinned row');
    const all = required(provider.findRepoElement(gateway.path, 'all'), 'an All row');
    expect(provider.idOf(pinned)).not.toBe(provider.idOf(all));
  });

  it('gives every row the id its tree item carries', async () => {
    const { provider, pins, recency } = await render();
    await pins.pin(api.path);
    await recency.touch(web.path);
    const check = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        expect(provider.idOf(node)).toBe(provider.getTreeItem(node).id);
        check(provider.getChildren(node));
      }
    };
    check(provider.getChildren());
  });
});
