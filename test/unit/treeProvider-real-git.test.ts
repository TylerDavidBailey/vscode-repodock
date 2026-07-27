import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

import { PinStore } from '../../src/ext/pins';
import { RecencyStore } from '../../src/ext/recency';
import { RepoTreeProvider } from '../../src/ext/treeProvider';
import { fakeMemento } from './helpers/memento';
import { withGitRepos, type GitFixture } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

/**
 * One pass over the real scanner and the real git binary. `treeProvider.test.ts` mocks both
 * to stay fast and order-independent; this file is what proves they were mocked faithfully,
 * so it lives apart rather than fighting that file's hoisted `vi.mock` calls.
 */
describe('RepoTreeProvider against real repositories', () => {
  let fixture: GitFixture;

  beforeAll(async () => {
    fixture = await withGitRepos(['alpha', path.join('sub', 'beta')]);
  }, 60_000);

  afterAll(async () => {
    await fixture.cleanup();
  });

  it('scans overlapping roots and loads real git state per unique repo', async () => {
    // overlapping scan roots on purpose: beta is found by both
    state.config.set('directories', [fixture.root, path.join(fixture.root, 'sub')]);
    const provider = new RepoTreeProvider(
      new RecencyStore(fakeMemento()),
      new PinStore(fakeMemento()),
    );

    await provider.refresh();

    const paths = provider.getRepos().map((repo) => repo.path);
    expect(paths).toHaveLength(3); // beta is listed under both roots
    expect(new Set(paths).size).toBe(2);
    expect(provider.getGitStates().get(fixture.repo('alpha'))?.branch).toBe('main');
    expect(provider.getChildren().map((row) => row.label)).toEqual(['alpha', 'beta']);
  });
});
