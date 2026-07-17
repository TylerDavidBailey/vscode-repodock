import { describe, expect, it, vi } from 'vitest';
import type { GitState } from '../../src/core/types';
import { describeRepo } from '../../src/ext/treeProvider';

// treeProvider.ts imports the vscode module at the top level; describeRepo never touches it.
vi.mock('vscode', () => ({}));

function state(overrides: Partial<GitState> = {}): GitState {
  return {
    branch: 'main',
    detached: false,
    changes: 0,
    untracked: 0,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    ...overrides,
  };
}

describe('describeRepo', () => {
  it('shows just the branch for a clean, in-sync repo', () => {
    expect(describeRepo(state())).toBe('main');
  });

  it('keeps dirty and ahead/behind counts out of the row (they live in the tooltip)', () => {
    expect(describeRepo(state({ changes: 2, untracked: 1, ahead: 2, behind: 1 }))).toBe('main');
  });

  it('marks detached heads', () => {
    expect(describeRepo(state({ branch: 'abc1234', detached: true }))).toBe('abc1234 (detached)');
  });

  it('appends the last-opened time after the git summary', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    expect(describeRepo(state(), fiveMinutesAgo)).toBe('main · 5m');
  });

  it('falls back to the timestamp alone when git state is missing', () => {
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    expect(describeRepo(undefined, fiveMinutesAgo)).toBe('5m');
  });

  it('returns an empty description with no state and no timestamp', () => {
    expect(describeRepo(undefined)).toBe('');
  });
});
