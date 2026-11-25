import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

import { RepoModel } from '../../src/ext/repoModel';
import { createProvider, sectionRows } from './helpers/sections';
import { withGitRepos, type GitFixture } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

/**
 * One pass over the real scanner and the real git binary. The other model and view suites
 * mock both to stay fast and order-independent; this file is what proves they were mocked
 * faithfully, so it lives apart rather than fighting those files' hoisted `vi.mock` calls.
 */
describe('RepoModel against real repositories', () => {
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
    const model = new RepoModel();
    const { provider } = createProvider(model);

    await model.refresh();

    const paths = model.getRepos().map((repo) => repo.path);
    expect(paths).toHaveLength(3); // beta is listed under both roots
    expect(new Set(paths).size).toBe(2);
    expect(model.getGitStates().get(fixture.repo('alpha'))?.branch).toBe('main');
    // each root keeps the repos nearest to it, so beta sits under the inner folder only
    const [outer, inner] = sectionRows(provider, 'all');
    expect(outer?.children.map((row) => row.label)).toEqual(['alpha']);
    expect(inner?.children.map((row) => row.label)).toEqual(['beta']);
  });
});
