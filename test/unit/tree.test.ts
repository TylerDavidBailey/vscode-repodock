import { describe, expect, it } from 'vitest';
import { buildRepoTree, type RepoTreeNode } from '../../src/core/tree';
import { absPath, makeRepo } from './helpers/repoFixture';

const CODE = absPath('/srv/code');
const WORK = absPath('/srv/work');

const inCode = (relPath: string, parentRelPath?: string) =>
  makeRepo({
    path: `/srv/code/${relPath}`,
    root: CODE,
    parentRepoPath: parentRelPath === undefined ? undefined : absPath(`/srv/code/${parentRelPath}`),
  });
const inWork = (relPath: string) => makeRepo({ path: `/srv/work/${relPath}`, root: WORK });

/**
 * The tree as indented text, one row per line, with folders ending in '/'. Comparing the
 * outline keeps each test readable as the tree a user would see.
 */
function outline(nodes: RepoTreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    '  '.repeat(depth) + (node.kind === 'folder' ? `${node.label}/` : node.label),
    ...outline(node.children, depth + 1),
  ]);
}

describe('buildRepoTree', () => {
  it('returns nothing for an empty list', () => {
    expect(buildRepoTree([], [CODE])).toEqual([]);
  });

  it('lists the repos of a single root at the top level, without a row for the root', () => {
    expect(outline(buildRepoTree([inCode('beta'), inCode('alpha')], [CODE]))).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('files repos under the folders they sit in, folders before repos', () => {
    const repos = [
      inCode('dotfiles'),
      inCode('services/payments-api'),
      inCode('frontend/web'),
      inCode('services/auth'),
    ];
    expect(outline(buildRepoTree(repos, [CODE]))).toEqual([
      'frontend/',
      '  web',
      'services/',
      '  auth',
      '  payments-api',
      'dotfiles',
    ]);
  });

  it('gives each root its own row, in configured order, once two roots hold repos', () => {
    const tree = buildRepoTree([inCode('alpha'), inWork('zeta')], [WORK, CODE]);
    expect(outline(tree)).toEqual([`${WORK}/`, '  zeta', `${CODE}/`, '  alpha']);
    expect(tree.map((node) => node.kind === 'folder' && node.isRoot)).toEqual([true, true]);
  });

  it('leaves out a configured root that holds no repos', () => {
    // one root with repos is the single-root case again, so its row is dropped too
    expect(outline(buildRepoTree([inCode('alpha')], [WORK, CODE]))).toEqual(['alpha']);
  });

  it('merges a chain of folders that each hold only the next into one row', () => {
    const repos = [inCode('tools/experiments/sandbox'), inCode('alpha')];
    const tree = buildRepoTree(repos, [CODE]);
    expect(outline(tree)).toEqual(['tools/experiments/', '  sandbox', 'alpha']);
    // the merged row stands for its deepest folder
    expect(tree[0]?.kind === 'folder' && tree[0].path).toBe(absPath('/srv/code/tools/experiments'));
  });

  it('stops merging at a folder that holds more than one thing', () => {
    const repos = [inCode('tools/experiments/sandbox'), inCode('tools/cli')];
    expect(outline(buildRepoTree(repos, [CODE]))).toEqual([
      'tools/',
      '  experiments/',
      '    sandbox',
      '  cli',
    ]);
  });

  it('never merges a scan root with the folder inside it', () => {
    const tree = buildRepoTree([inCode('only/alpha'), inWork('zeta')], [CODE, WORK]);
    expect(outline(tree)).toEqual([`${CODE}/`, '  only/', '    alpha', `${WORK}/`, '  zeta']);
  });

  it('hangs a nested repo under the repo that contains it, labelled by its path inside', () => {
    const repos = [
      inCode('services/gateway'),
      inCode('services/gateway/vendor/shared-utils', 'services/gateway'),
      inCode('services/gateway/docs', 'services/gateway'),
    ];
    expect(outline(buildRepoTree(repos, [CODE]))).toEqual([
      'services/',
      '  gateway',
      '    docs',
      '    vendor/shared-utils',
    ]);
  });

  it('nests repos inside nested repos', () => {
    const repos = [
      inCode('outer'),
      inCode('outer/middle', 'outer'),
      inCode('outer/middle/inner', 'outer/middle'),
    ];
    expect(outline(buildRepoTree(repos, [CODE]))).toEqual(['outer', '  middle', '    inner']);
  });

  it('places a nested repo by its folders when its parent is not in the list', () => {
    // overlapping scan roots are deduped per repo, so a parent can be kept under another
    // root while the repo nested in it stays here
    const orphan = inCode('services/gateway/vendor/sdk', 'services/gateway');
    expect(outline(buildRepoTree([orphan, inCode('alpha')], [CODE]))).toEqual([
      'services/gateway/vendor/',
      '  sdk',
      'alpha',
    ]);
  });

  it('keeps a repo filed under another repo by folders alone, rather than dropping it', () => {
    // not something the scanner produces: it links every repo to the one containing it
    const repos = [inCode('outer'), inCode('outer/lib/stray')];
    const tree = buildRepoTree(repos, [CODE]);
    expect(outline(tree)).toEqual(['outer', '  lib/stray']);
  });

  it('shows a root that is itself a repository as a repo row holding what is inside it', () => {
    const rootRepo = makeRepo({ path: '/srv/code', root: CODE });
    const repos = [rootRepo, inCode('packages/ui', ''), inCode('packages/api', '')].map((repo) =>
      repo.parentRepoPath === undefined ? repo : { ...repo, parentRepoPath: CODE },
    );
    expect(outline(buildRepoTree(repos, [CODE]))).toEqual([
      'code',
      '  packages/api',
      '  packages/ui',
    ]);
  });

  it('keeps a root that is a repository as a row even when it is the only root', () => {
    const tree = buildRepoTree([makeRepo({ path: '/srv/code', root: CODE })], [CODE]);
    expect(tree.map((node) => node.kind)).toEqual(['repo']);
  });

  it('sorts same-named rows by path so their order is stable', () => {
    const repos = [inWork('web'), inCode('web')];
    const [first, second] = buildRepoTree(repos, [CODE, WORK]);
    expect(first?.kind === 'folder' && first.path).toBe(CODE);
    expect(second?.kind === 'folder' && second.path).toBe(WORK);
  });

  it('gives every row a distinct path, so ids built from them cannot collide', () => {
    const repos = [
      inCode('a/x'),
      inCode('a/y'),
      inCode('b/x'),
      inCode('b/x/n', 'b/x'),
      inWork('a/x'),
    ];
    const paths: string[] = [];
    const collect = (nodes: RepoTreeNode[]): void => {
      for (const node of nodes) {
        paths.push(`${node.kind}:${node.kind === 'repo' ? node.repo.path : node.path}`);
        collect(node.children);
      }
    };
    collect(buildRepoTree(repos, [CODE, WORK]));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('does not change the list it was given', () => {
    const repos = [inCode('beta'), inCode('alpha')];
    buildRepoTree(repos, [CODE]);
    expect(repos.map((repo) => repo.name)).toEqual(['beta', 'alpha']);
  });
});
