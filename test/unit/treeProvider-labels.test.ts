import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());
vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));
vi.mock('../../src/core/git', () => ({ loadGitStates: vi.fn() }));

import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { RepoInfo } from '../../src/core/types';
import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider, type TreeNode } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';
import { absPath, makeRepo } from './helpers/repoFixture';
import { required } from './helpers/required';
import { stubState as state } from './helpers/vscodeStub';

const WORK = absPath('/srv/work');
const PERSONAL = absPath('/srv/personal');
const workApp = makeRepo({ path: '/srv/work/web-app', root: WORK });
const personalApp = makeRepo({ path: '/srv/personal/web-app', root: PERSONAL });
const api = makeRepo({ path: '/srv/work/api', root: WORK });

async function render(repos: RepoInfo[]): Promise<RepoTreeProvider> {
  vi.mocked(scanForRepos).mockImplementation((root) =>
    Promise.resolve(repos.filter((repo) => repo.root === root).map((repo) => ({ ...repo }))),
  );
  vi.mocked(loadGitStates).mockResolvedValue({ gitMissing: false });
  const provider = new RepoTreeProvider(
    new RecencyStore(fakeMemento()),
    new PinStore(fakeMemento()),
  );
  await provider.refresh();
  return provider;
}

const labelsOf = (provider: RepoTreeProvider, nodes: TreeNode[]) =>
  nodes.map((node) => provider.getTreeItem(node).label);

beforeEach(() => {
  state.reset();
  state.config.set('directories', [WORK, PERSONAL]);
  state.config.set('sortOrder', 'alphabetical');
});

describe('same-named repos from different folders', () => {
  it('are told apart by folder in the flat list', async () => {
    const provider = await render([workApp, personalApp, api]);
    expect(labelsOf(provider, provider.getChildren())).toEqual([
      'api',
      'web-app (work)',
      'web-app (personal)',
    ]);
  });

  it('keep the short label under folder sections, which already name the folder', async () => {
    state.config.set('groupByFolder', true);
    const provider = await render([workApp, personalApp, api]);
    const [work, personal] = provider.getChildren();
    expect(labelsOf(provider, provider.getChildren(required(work, 'the work section')))).toEqual([
      'api',
      'web-app',
    ]);
    expect(
      labelsOf(provider, provider.getChildren(required(personal, 'the personal section'))),
    ).toEqual(['web-app']);
  });

  it('get the same label from findRepoElement before the tree has rendered', async () => {
    const provider = await render([workApp, personalApp]);
    // reveal asks for the element first, when nothing has called getChildren yet
    expect(provider.findRepoElement(personalApp.path)?.label).toBe('web-app (personal)');
  });

  it('get the short label from findRepoElement while grouped', async () => {
    state.config.set('groupByFolder', true);
    const provider = await render([workApp, personalApp]);
    expect(provider.findRepoElement(personalApp.path)?.label).toBe('web-app');
  });
});
