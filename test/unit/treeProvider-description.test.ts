import { describe, expect, it, vi } from 'vitest';
import { describeRepo } from '../../src/ext/treeProvider';
import { makeGitState } from './helpers/repoFixture';

// treeProvider.ts imports the vscode module at the top level; describeRepo never touches it.
vi.mock('vscode', () => ({}));

describe('describeRepo', () => {
  it('shows just the branch for a clean, in-sync repo', () => {
    expect(describeRepo(makeGitState())).toBe('main');
  });

  it('adds how far the branch is ahead of and behind its upstream', () => {
    expect(describeRepo(makeGitState({ ahead: 2 }))).toBe('main ↑2');
    expect(describeRepo(makeGitState({ behind: 4 }))).toBe('main ↓4');
    expect(describeRepo(makeGitState({ ahead: 2, behind: 1 }))).toBe('main ↑2 ↓1');
  });

  it('leaves the arrows out for a branch with no upstream to compare against', () => {
    // without an upstream the counts are whatever the parser defaulted to, not a distance
    expect(describeRepo(makeGitState({ hasUpstream: false, ahead: 3, behind: 3 }))).toBe('main');
  });

  it('keeps uncommitted counts out of the text, leaving them to the tooltip', () => {
    expect(describeRepo(makeGitState({ changes: 2, untracked: 1 }))).toBe('main');
  });

  it('marks detached heads', () => {
    expect(describeRepo(makeGitState({ branch: 'abc1234', detached: true }))).toBe(
      'abc1234 (detached)',
    );
  });

  it('appends the last-opened time after the git summary', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    expect(describeRepo(makeGitState({ ahead: 1 }), fiveMinutesAgo)).toBe('main ↑1 · 5m');
  });

  it('falls back to the timestamp alone when git state is missing', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    expect(describeRepo(undefined, fiveMinutesAgo)).toBe('5m');
  });

  it('returns an empty description with no state and no timestamp', () => {
    expect(describeRepo(undefined)).toBe('');
  });
});
