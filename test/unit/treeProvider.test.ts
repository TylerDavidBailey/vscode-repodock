import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { GitState, RepoInfo } from '../../src/core/types';
import type { RepoTreeProvider, TreeNode } from '../../src/ext/treeProvider';
import { absPath, makeGitState, makeRepo } from './helpers/repoFixture';
import { required } from './helpers/required';
import { createProvider, labelOf, outline, type Rendered } from './helpers/provider';
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

/** The top-level rows' labels, from a fresh render. The gap row reads as ''. */
const topLabels = (provider: RepoTreeProvider) =>
  provider.getChildren().map((node) => labelOf(provider, node));

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

describe('the folder layout', () => {
  it('lists nothing while there is nothing to list, which leaves the welcome text showing', async () => {
    const { provider } = await render([]);
    expect(provider.getChildren()).toEqual([]);
  });

  it('mirrors the disk: scan folder, folders, repos, with nested repos under their parent', async () => {
    const { provider } = await render();
    expect(outline(provider)).toEqual([
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
    expect(outline(provider)).toEqual(['frontend', '  web', 'dotfiles']);
  });

  it('lists a repo once when overlapping folders both find it, under the nearer one', async () => {
    const services = absPath('/srv/code/services');
    state.config.set('directories', [CODE, services]);
    const apiViaServices = makeRepo({ path: api.path, root: services });
    const { provider } = await render([web, api, apiViaServices]);
    expect(outline(provider)).toEqual([CODE, '  frontend', '    web', services, '  api']);
  });

  it('hides nested repos, and the twistie that led to them, when showNestedRepos is off', async () => {
    state.config.set('showNestedRepos', false);
    const { provider } = await render();
    expect(outline(provider)).not.toContain('      vendor/sdk');
    const row = required(provider.findRepoElement(gateway.path), 'a row for gateway');
    expect(provider.getTreeItem(row).collapsibleState).toBe(0);
  });

  it('reports each row parent, up to the top', async () => {
    const { provider } = await render();
    const chain: string[] = [];
    let node: TreeNode | undefined = provider.findRepoElement(sdk.path);
    while (node) {
      chain.push(labelOf(provider, node));
      node = provider.getParent(node);
    }
    expect(chain).toEqual(['vendor/sdk', 'gateway', 'services', CODE]);
  });

  it('keeps the bare name of same-named repos, since the folders above them already tell', async () => {
    const workWeb = makeRepo({ path: '/srv/work/web', root: WORK });
    const { provider } = await render([web, workWeb]);
    expect(outline(provider)).toEqual([CODE, '  frontend', '    web', WORK, '  web']);
  });
});

describe('the recent layout', () => {
  beforeEach(() => {
    state.config.set('layout', 'recent');
  });

  it('lists every repo flat, newest-opened first, then the rest by name', async () => {
    const { provider, recency } = await render();
    await openInOrder(recency, [dotfiles, web, portal]);
    expect(outline(provider)).toEqual(['portal', 'web', 'dotfiles', 'api', 'gateway', 'sdk']);
  });

  it('lists everything by name before anything has been opened', async () => {
    const { provider } = await render();
    expect(topLabels(provider)).toEqual(['api', 'dotfiles', 'gateway', 'portal', 'sdk', 'web']);
  });

  it('follows the setting back to folders without a rescan', async () => {
    const { provider } = await render([web, dotfiles]);
    expect(topLabels(provider)).toEqual(['dotfiles', 'web']);
    state.config.set('layout', 'folders');
    expect(outline(provider)).toEqual(['frontend', '  web', 'dotfiles']);
  });

  it('tells same-named repos apart by folder', async () => {
    const workWeb = makeRepo({ path: '/srv/work/web', root: WORK });
    const { provider } = await render([web, workWeb, api]);
    expect(topLabels(provider)).toEqual(['api', 'web (frontend)', 'web (work)']);
  });

  it('drops a repo that is no longer scanned, and brings it back in place when it returns', async () => {
    const { provider, recency, model } = await render([web, api]);
    await recency.touch(api.path);
    vi.mocked(scanForRepos).mockResolvedValue([]);
    await model.refresh();
    expect(topLabels(provider)).toEqual([]);

    // the folder comes back (a drive remounts): the row returns without being reopened
    vi.mocked(scanForRepos).mockImplementation((root) =>
      Promise.resolve(root === CODE ? [{ ...web }, { ...api }] : []),
    );
    await model.refresh();
    expect(topLabels(provider)).toEqual(['api', 'web']);
  });
});

describe('pinned repos', () => {
  it('lead the list by name, wherever they live, with a gap before the rest', async () => {
    const { provider, pins } = await render([web, api, portal]);
    await pins.pin(portal.path);
    await pins.pin(api.path);
    expect(outline(provider)).toEqual(['api', 'portal', '', 'frontend', '  web']);
  });

  it('lead the recent layout too, ahead of a repo opened more recently', async () => {
    state.config.set('layout', 'recent');
    const { provider, pins, recency } = await render([web, api, portal]);
    await pins.pin(api.path);
    await openInOrder(recency, [api, web]);
    expect(topLabels(provider)).toEqual(['api', '', 'web', 'portal']);
  });

  it('move rather than copy: a pinned repo has one row', async () => {
    const { provider, pins } = await render();
    await pins.pin(api.path);
    expect(outline(provider).filter((label) => label.trim() === 'api')).toEqual(['api']);
  });

  it('take no gap when nothing else is left to list', async () => {
    const { provider, pins } = await render([web]);
    await pins.pin(web.path);
    expect(outline(provider)).toEqual(['web']);
  });

  it('show no nested repos under them; those stay below, placed by their folders', async () => {
    const { provider, pins } = await render([gateway, sdk]);
    await pins.pin(gateway.path);
    const [row] = provider.getChildren();
    expect(provider.getChildren(required(row, 'a pinned row'))).toEqual([]);
    expect(provider.getTreeItem(required(row, 'a pinned row')).collapsibleState).toBe(0);
    expect(outline(provider)).toEqual(['gateway', '', 'services/gateway/vendor', '  sdk']);
  });

  it('are told apart by folder when two share a name', async () => {
    const workWeb = makeRepo({ path: '/srv/work/web', root: WORK });
    const { provider, pins } = await render([web, workWeb, api]);
    for (const repo of [web, workWeb, api]) await pins.pin(repo.path);
    expect(topLabels(provider)).toEqual(['api', 'web (frontend)', 'web (work)']);
  });

  it('drop a pin whose repo has been hidden, and bring it back when unhidden', async () => {
    const { provider, pins, model } = await render([web, api]);
    await pins.pin(api.path);
    state.config.set('hiddenRepos', [api.path]);
    await model.refresh();
    expect(outline(provider)).toEqual(['frontend', '  web']);

    state.config.set('hiddenRepos', []);
    await model.refresh();
    expect(outline(provider)).toEqual(['api', '', 'frontend', '  web']);
  });

  it('drop a pinned nested repo while nested repos are turned off', async () => {
    const { provider, pins } = await render([gateway, sdk]);
    await pins.pin(sdk.path);
    expect(topLabels(provider)[0]).toBe('sdk');
    state.config.set('showNestedRepos', false);
    expect(outline(provider)).toEqual(['services', '  gateway']);
  });
});

describe('the gap row', () => {
  it('is blank, unclickable, out of the repo menus, and named for screen readers', async () => {
    const { provider, pins } = await render([web, api]);
    await pins.pin(api.path);
    const gap = required(provider.getChildren()[1], 'the gap row');
    expect(gap.kind).toBe('gap');
    const item = provider.getTreeItem(gap);
    expect(item.label).toBe('');
    expect(item.id).toBe('gap');
    expect(item.collapsibleState).toBe(0);
    expect(item.command).toBeUndefined();
    expect(item.contextValue).toBeUndefined();
    expect(item.accessibilityInformation?.label).toBe('End of pinned repositories');
    expect(provider.getChildren(gap)).toEqual([]);
  });
});

describe('row ids', () => {
  it('differ between a pinned row and the row the repo has otherwise', async () => {
    const { provider, pins } = await render();
    const before = provider.getTreeItem(required(provider.findRepoElement(api.path), 'api')).id;
    await pins.pin(api.path);
    provider.getChildren(); // the redraw VS Code asks for after a pin
    const after = provider.getTreeItem(required(provider.findRepoElement(api.path), 'api')).id;
    expect(before).toBe(`repo:${api.path}`);
    expect(after).toBe(`pinned:${api.path}`);
  });

  it('are distinct across the whole tree, in either layout', async () => {
    for (const layout of ['folders', 'recent']) {
      state.config.set('layout', layout);
      const { provider, pins } = await render();
      await pins.pin(api.path);
      await pins.pin(sdk.path);
      const ids: string[] = [];
      const collect = (nodes: TreeNode[]): void => {
        for (const node of nodes) {
          ids.push(String(provider.getTreeItem(node).id));
          collect(provider.getChildren(node));
        }
      };
      collect(provider.getChildren());
      expect(new Set(ids).size, layout).toBe(ids.length);
    }
  });
});

describe('findRepoElement', () => {
  it('returns the same instance the tree handed out', async () => {
    const { provider } = await render([dotfiles]);
    const [row] = provider.getChildren();
    expect(provider.findRepoElement(dotfiles.path)).toBe(row);
  });

  it('finds a row before the view has ever rendered', async () => {
    const { provider } = await render();
    expect(provider.findRepoElement(sdk.path)?.label).toBe('vendor/sdk');
  });

  it('finds a pinned repo at the top', async () => {
    const { provider, pins } = await render();
    await pins.pin(web.path);
    const [top] = provider.getChildren();
    expect(provider.findRepoElement(web.path)).toBe(top);
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

  it('redraws the row of each repo whose git state was reloaded', async () => {
    const { provider, model, pins } = await render([web, api], { [web.path]: makeGitState() });
    await pins.pin(web.path);
    // VS Code asks the view for its rows after a full redraw; a row that was never
    // handed out has nothing on screen to update
    provider.getChildren();
    const events = watch(provider);

    await model.refresh(); // same repos, so git state is all that moves

    expect(events.sort()).toEqual([`pinned:${web.path}`, `repo:${api.path}`].sort());
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

  it('renders a folder and a repo the way the user last left each', async () => {
    const { provider, expansion } = await render();
    const [root] = provider.getChildren();
    const repo = provider.findRepoElement(gateway.path);
    // the defaults: folders open, a repo holding nested repos closed
    expect(stateOf(provider, root)).toBe(EXPANDED);
    expect(stateOf(provider, repo)).toBe(COLLAPSED);

    await expansion.set(provider.idOf(required(root, 'a scan-folder row')), false);
    await expansion.set(provider.idOf(required(repo, 'a row for gateway')), true);

    expect(stateOf(provider, root)).toBe(COLLAPSED);
    expect(stateOf(provider, repo)).toBe(EXPANDED);
  });

  it('never makes a repo with nothing nested in it expandable', async () => {
    const { provider, expansion } = await render();
    const row = required(provider.findRepoElement(web.path), 'a row for web');
    await expansion.set(provider.idOf(row), true);
    expect(stateOf(provider, row)).toBe(0); // None
  });

  it('gives every row the id its tree item carries', async () => {
    const { provider, pins } = await render();
    await pins.pin(api.path);
    const check = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        expect(provider.idOf(node)).toBe(provider.getTreeItem(node).id);
        check(provider.getChildren(node));
      }
    };
    check(provider.getChildren());
  });
});
