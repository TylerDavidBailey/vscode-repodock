import * as vscode from 'vscode';
import { loadGitStates } from '../core/git';
import { canonicalPathKey } from '../core/paths';
import { scanForRepos } from '../core/scanner';
import { dedupeRepos, filterHiddenRepos, filterNestedRepos, sameRepoList } from '../core/sorting';
import type { GitState, RepoInfo } from '../core/types';
import { getConfig } from './settings';

/** Focus/visibility events can fire in bursts; don't re-run git more often than this. */
const GIT_REFRESH_MIN_INTERVAL_MS = 5_000;

/** Rescanning on focus keeps fresh clones visible, but don't hit the disk on every alt-tab. */
const SCAN_REFRESH_MIN_INTERVAL_MS = 30_000;

/**
 * The scanned repositories and their git state, shared by every RepoDock view. It owns the
 * scanning and the git loading; the views only render what it holds and listen for changes.
 *
 * Refreshes are numbered by `refreshGeneration` so a slow scan or git load that has been
 * superseded discards its results instead of overwriting newer ones.
 */
export class RepoModel implements vscode.Disposable {
  private readonly reposEmitter = new vscode.EventEmitter<void>();
  /** Fires when a scan found a different set of repositories than the one before it. */
  readonly onDidChangeRepos = this.reposEmitter.event;

  private readonly gitStateEmitter = new vscode.EventEmitter<string>();
  /** Fires with a repository path each time its git state was loaded, changed or not. */
  readonly onDidChangeGitState = this.gitStateEmitter.event;

  private repos: RepoInfo[] = [];
  private readonly gitStates = new Map<string, GitState>();
  private refreshGeneration = 0;
  /** The newest scan still running, so callers can wait for it instead of starting another. */
  private inFlight?: Promise<void>;
  private currentRepos = new Set<string>();
  private warnedGitMissing = false;
  private lastGitLoad = 0;
  private lastScan = 0;

  dispose(): void {
    this.reposEmitter.dispose();
    this.gitStateEmitter.dispose();
  }

  /** Every repo the last scan found. Overlapping scan roots list a shared repo once each. */
  getRepos(): RepoInfo[] {
    return this.repos;
  }

  /** What the views show: repos left after nested-repo filtering and cross-root dedupe. */
  visibleRepos(): RepoInfo[] {
    return dedupeRepos(filterNestedRepos(this.repos, getConfig().showNestedRepos));
  }

  getGitStates(): ReadonlyMap<string, GitState> {
    return this.gitStates;
  }

  /** Marks the repos open in this window so the views can highlight them. */
  setCurrentRepos(paths: string[]): void {
    this.currentRepos = new Set(paths.map(canonicalPathKey));
  }

  /** Whether a repo is open as a folder of this window. */
  isCurrent(repoPath: string): boolean {
    return this.currentRepos.has(canonicalPathKey(repoPath));
  }

  /**
   * Rescans every configured directory, then reloads git state incrementally. Resolves
   * once the repo list is current: a refresh superseded by a newer one waits for that
   * newer one instead of resolving early against the list it was asked to replace.
   */
  async refresh(): Promise<void> {
    const run = this.runRefresh();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
    await this.settle();
  }

  /** Waits until no refresh is running, following each one superseded by a newer one. */
  private async settle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  private async runRefresh(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const config = getConfig();
    const results = await Promise.all(
      config.directories.map((dir) =>
        scanForRepos(dir, { maxDepth: config.maxDepth, exclude: config.exclude }),
      ),
    );
    if (generation !== this.refreshGeneration) {
      return; // a newer refresh superseded this one
    }
    this.lastScan = Date.now();
    const repos = filterHiddenRepos(results.flat(), config.hiddenRepos);
    // an unchanged list (the usual outcome of a focus-triggered rescan) leaves the views
    // untouched; only git state updates flow through, per repo
    if (!sameRepoList(repos, this.repos)) {
      this.repos = repos;
      const alive = new Set(repos.map((repo) => repo.path));
      for (const repoPath of [...this.gitStates.keys()]) {
        if (!alive.has(repoPath)) this.gitStates.delete(repoPath);
      }
      this.reposEmitter.fire();
    }
    await this.loadGit(generation);
  }

  /**
   * Focus/visibility refresh: rescans the file system when the last scan is old
   * enough (so fresh clones appear), otherwise just reloads git state. Both paths
   * are throttled, so bursty events can call this freely. A scan already running
   * (the initial one, typically) is joined rather than restarted: restarting would
   * discard its results, and the window opening is exactly when these events fire.
   */
  async refreshIfStale(): Promise<void> {
    if (this.inFlight) {
      await this.settle();
    } else if (Date.now() - this.lastScan >= SCAN_REFRESH_MIN_INTERVAL_MS) {
      await this.refresh();
    } else {
      await this.refreshGitStates();
    }
  }

  /**
   * Reloads git state for the already-scanned repos without rescanning the file system.
   * Throttled so window-focus and view-visibility events can call it freely.
   */
  async refreshGitStates(): Promise<void> {
    if (Date.now() - this.lastGitLoad < GIT_REFRESH_MIN_INTERVAL_MS) return;
    await this.loadGit(this.refreshGeneration);
  }

  private async loadGit(generation: number): Promise<void> {
    // stamped before the await, not after, so the window runs from when a load starts:
    // a burst of focus events then collapses into one load. It is a time window, not an
    // in-flight guard — a load slower than GIT_REFRESH_MIN_INTERVAL_MS can still overlap
    // the next one, which is harmless because results are keyed by repo path.
    this.lastGitLoad = Date.now();
    const { gitMissing } = await loadGitStates(
      [...new Set(this.repos.map((repo) => repo.path))],
      (repoPath, state, timedOut) => {
        if (generation !== this.refreshGeneration) return;
        if (state) {
          this.gitStates.set(repoPath, state);
        } else if (!timedOut) {
          // timeouts are transient (busy disk, cold mount), so keep the last known state
          this.gitStates.delete(repoPath);
        }
        this.gitStateEmitter.fire(repoPath);
      },
    );
    if (generation === this.refreshGeneration) {
      if (gitMissing && !this.warnedGitMissing) {
        this.warnedGitMissing = true;
        void vscode.window.showWarningMessage(
          'RepoDock could not run git, so repository status is unavailable. ' +
            'Install git or make sure it is on your PATH.',
        );
      }
    }
  }
}
