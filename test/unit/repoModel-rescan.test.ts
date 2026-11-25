import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./helpers/vscodeStub.js')).createVscodeStub());

vi.mock('../../src/core/scanner', () => ({ scanForRepos: vi.fn() }));

vi.mock('../../src/core/git', () => ({
  loadGitStates: vi.fn(() => Promise.resolve({ gitMissing: false })),
}));

import { loadGitStates } from '../../src/core/git';
import { scanForRepos } from '../../src/core/scanner';
import type { RepoInfo } from '../../src/core/types';
import { RepoModel } from '../../src/ext/repoModel';
import { absPath, makeRepo } from './helpers/repoFixture';
import { stubState as state } from './helpers/vscodeStub';

const repo = (name: string): RepoInfo => makeRepo({ path: `/srv/repos/${name}` });

// what the next scan finds; copied per call so equality can't come from identity
let scanResult: RepoInfo[] = [];
vi.mocked(scanForRepos).mockImplementation(() =>
  Promise.resolve(scanResult.map((repo) => ({ ...repo }))),
);

describe('RepoModel background rescans', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    state.config.set('directories', [absPath('/srv/repos')]);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it('announces a new repo list only when a rescan changes it', async () => {
    const model = new RepoModel();
    let fullRenders = 0;
    model.onDidChangeRepos(() => fullRenders++);

    scanResult = [repo('alpha')];
    await model.refresh();
    expect(fullRenders).toBe(1);

    await model.refresh(); // identical result: the views must stay untouched
    expect(fullRenders).toBe(1);

    scanResult = [repo('alpha'), repo('beta')];
    await model.refresh();
    expect(fullRenders).toBe(2);
  });

  it('rescans via refreshIfStale only after the throttle interval', async () => {
    const model = new RepoModel();
    scanResult = [repo('alpha')];
    await model.refresh();
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    await model.refreshIfStale(); // right after a scan: no disk hit
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans);

    vi.advanceTimersByTime(30_000);
    await model.refreshIfStale();
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans + 1);
  });

  it('reloads git state without rescanning between the two throttle intervals', async () => {
    const model = new RepoModel();
    scanResult = [repo('alpha')];
    await model.refresh();
    const scans = vi.mocked(scanForRepos).mock.calls.length;
    const loads = vi.mocked(loadGitStates).mock.calls.length;

    // inside the 5s git window: neither the disk nor git is touched
    vi.advanceTimersByTime(4_000);
    await model.refreshIfStale();
    expect(vi.mocked(loadGitStates).mock.calls.length).toBe(loads);

    // past 5s but short of the 30s rescan window: git reloads, the disk is left alone
    vi.advanceTimersByTime(2_000);
    await model.refreshIfStale();
    expect(vi.mocked(loadGitStates).mock.calls.length).toBe(loads + 1);
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans);
  });

  it('joins a scan already in flight instead of starting a second one', async () => {
    const model = new RepoModel();
    let finishScan: (repos: RepoInfo[]) => void = () => undefined;
    vi.mocked(scanForRepos).mockImplementationOnce(
      () => new Promise((resolve) => (finishScan = resolve)),
    );
    const scans = vi.mocked(scanForRepos).mock.calls.length;

    const initial = model.refresh();
    // the view opening or the window gaining focus fires while the first scan runs
    const stale = model.refreshIfStale();
    expect(vi.mocked(scanForRepos).mock.calls.length).toBe(scans + 1);

    finishScan([repo('alpha')]);
    await Promise.all([initial, stale]);
    expect(model.getRepos().map((r) => r.path)).toEqual([repo('alpha').path]);
  });

  it('resolves a superseded refresh only once the newer one has landed', async () => {
    const model = new RepoModel();
    const finish: ((repos: RepoInfo[]) => void)[] = [];
    const pendingScan = () => new Promise<RepoInfo[]>((resolve) => finish.push(resolve));
    vi.mocked(scanForRepos).mockImplementationOnce(pendingScan).mockImplementationOnce(pendingScan);

    const first = model.refresh();
    const second = model.refresh();
    let firstSettled = false;
    void first.then(() => (firstSettled = true));

    // the first scan comes back, but the second (which supersedes it) is still running
    finish[0]?.([repo('alpha')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(firstSettled).toBe(false);

    finish[1]?.([repo('alpha'), repo('beta')]);
    await Promise.all([first, second]);
    // whoever awaited the first refresh sees the list the second one produced
    expect(model.getRepos().map((r) => r.name)).toEqual(['alpha', 'beta']);
  });

  it('collapses a burst of git reloads into one per throttle window', async () => {
    const model = new RepoModel();
    scanResult = [repo('alpha')];
    await model.refresh();
    const loads = vi.mocked(loadGitStates).mock.calls.length;

    // window focus fires in bursts; the window opens when a load starts, not when it
    // finishes, so calls arriving inside it collapse into a single load
    vi.advanceTimersByTime(6_000);
    await Promise.all([
      model.refreshGitStates(),
      model.refreshGitStates(),
      model.refreshGitStates(),
    ]);
    expect(vi.mocked(loadGitStates).mock.calls.length).toBe(loads + 1);
  });
});
