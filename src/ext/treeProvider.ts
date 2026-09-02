import * as vscode from 'vscode';
import { loadGitStates } from '../core/git';
import { canonicalPathKey } from '../core/paths';
import { scanForRepos } from '../core/scanner';
import {
  dedupeRepos,
  filterHiddenRepos,
  filterNestedRepos,
  formatCompactRelativeTime,
  formatRelativeTime,
  groupReposByRoot,
  repoLabel,
  sameRepoList,
  sortRepos,
} from '../core/sorting';
import type { GitState, RepoInfo } from '../core/types';
import type { PinStore } from './pins';
import type { RecencyStore } from './recency';
import { getConfig, tildify } from './settings';

/** Marks a tree row's resourceUri as the current repo, which is all the decoration matches on. */
export const CURRENT_REPO_SCHEME = 'repodock-current';

/** Focus/visibility events can fire in bursts; don't re-run git more often than this. */
const GIT_REFRESH_MIN_INTERVAL_MS = 5_000;

/** Rescanning on focus keeps fresh clones visible, but don't hit the disk on every alt-tab. */
const SCAN_REFRESH_MIN_INTERVAL_MS = 30_000;

/** Colors the label of the repo open in this window (tree rows opt in via resourceUri). */
export class CurrentRepoDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CURRENT_REPO_SCHEME) return undefined;
    return { color: new vscode.ThemeColor('charts.blue') };
  }
}

/**
 * A repository row. Identity matters: TreeView.reveal only accepts an element the provider
 * handed out, so every rendered row is recorded in `repoElements` and `findRepoElement`
 * returns that same instance.
 */
export interface TreeElement {
  repo: RepoInfo;
  label: string;
}

/** Section header for one configured scan folder, shown when grouping is enabled. */
export interface FolderElement {
  /** Absolute path of the scan root this section represents. */
  root: string;
  label: string;
  repos: RepoInfo[];
}

/** Either row type the tree can hold; narrow with `isRepoElement`. */
export type TreeNode = TreeElement | FolderElement;

function isRepoElement(node: TreeNode): node is TreeElement {
  return 'repo' in node;
}

/**
 * Backs the RepoDock view: holds the scanned repo list and its git state, and renders both
 * as either a flat list or one section per scan folder.
 *
 * Refreshes are numbered by `refreshGeneration` so a slow scan or git load that has been
 * superseded discards its results instead of overwriting newer ones.
 */
export class RepoTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private repos: RepoInfo[] = [];
  private readonly gitStates = new Map<string, GitState>();
  /** One element per repo path; repos are deduped across overlapping scan roots. */
  private readonly repoElements = new Map<string, TreeElement>();
  /** One element per scan root, keyed by canonical path; empty while the list is flat. */
  private readonly folderElements = new Map<string, FolderElement>();
  private refreshGeneration = 0;
  private currentRepos = new Set<string>();
  private warnedGitMissing = false;
  private lastGitLoad = 0;
  private lastScan = 0;

  constructor(
    private readonly recency: RecencyStore,
    private readonly pins: PinStore,
  ) {}

  getRepos(): RepoInfo[] {
    return this.repos;
  }

  getGitStates(): ReadonlyMap<string, GitState> {
    return this.gitStates;
  }

  /** Marks the repos open in this window so the tree can highlight them. */
  setCurrentRepos(paths: string[]): void {
    this.currentRepos = new Set(paths.map(canonicalPathKey));
  }

  /** Rescans every configured directory, then reloads git state incrementally. */
  async refresh(): Promise<void> {
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
    // an unchanged list (the usual outcome of a focus-triggered rescan) keeps the
    // existing tree untouched; only git state updates flow through, per element
    if (!sameRepoList(repos, this.repos)) {
      this.repos = repos;
      const alive = new Set(repos.map((repo) => repo.path));
      for (const repoPath of [...this.gitStates.keys()]) {
        if (!alive.has(repoPath)) this.gitStates.delete(repoPath);
      }
      this.rebuild();
    }
    await this.loadGit(generation);
  }

  /**
   * Focus/visibility refresh: rescans the file system when the last scan is old
   * enough (so fresh clones appear), otherwise just reloads git state. Both paths
   * are throttled, so bursty events can call this freely.
   */
  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastScan >= SCAN_REFRESH_MIN_INTERVAL_MS) {
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
        const element = this.repoElements.get(repoPath);
        if (element) this.changeEmitter.fire(element);
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

  /** Re-renders from the already-scanned repo list (e.g. after a sort-order change). */
  rebuild(): void {
    this.repoElements.clear();
    this.folderElements.clear();
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    return isRepoElement(node) ? this.repoItem(node) : this.folderItem(node);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) {
      return isRepoElement(node) ? [] : this.sortedRepoElements(node.repos);
    }
    // a root request is a full re-render, so drop the elements handed out last time
    this.repoElements.clear();
    this.folderElements.clear();
    return this.folderGrouping() ?? this.sortedRepoElements(this.visibleRepos());
  }

  /**
   * Enables TreeView.reveal (used to select the current repo when the view opens);
   * with grouping on, repo rows report their folder section so reveal can expand it.
   */
  getParent(node: TreeNode): TreeNode | undefined {
    if (!isRepoElement(node)) return undefined;
    // match by path, not by root: overlapping roots list the same repo under two
    // RepoInfo instances whose roots differ, and only one of them is rendered
    return this.folderGrouping()?.find((folder) =>
      folder.repos.some((repo) => repo.path === node.repo.path),
    );
  }

  /** What the view shows: repos left after nested-repo filtering and cross-root dedupe. */
  private visibleRepos(): RepoInfo[] {
    return dedupeRepos(filterNestedRepos(this.repos, getConfig().showNestedRepos));
  }

  private sortedRepoElements(repos: RepoInfo[]): TreeElement[] {
    const config = getConfig();
    return sortRepos(repos, config.sortOrder, this.recency.all(), this.pins.all()).map((repo) =>
      this.repoElement(repo),
    );
  }

  /**
   * Folder sections in configured-folder order when grouping is enabled and there is
   * more than one folder to tell apart; undefined means the flat list.
   */
  private folderGrouping(): FolderElement[] | undefined {
    const config = getConfig();
    if (!config.groupByFolder) return undefined;
    const groups = groupReposByRoot(this.visibleRepos(), config.directories);
    if (groups.length < 2) return undefined;
    return groups.map((group) => {
      const key = canonicalPathKey(group.root);
      let element = this.folderElements.get(key);
      if (!element) {
        element = { root: group.root, label: tildify(group.root), repos: group.repos };
        this.folderElements.set(key, element);
      }
      return element;
    });
  }

  /** The element for a repo path, or undefined when it is not listed. */
  findRepoElement(repoPath: string): TreeElement | undefined {
    const cached = this.repoElements.get(repoPath);
    if (cached) return cached;
    const repo = this.repos.find((candidate) => candidate.path === repoPath);
    return repo && this.repoElement(repo);
  }

  private repoElement(repo: RepoInfo): TreeElement {
    const element: TreeElement = { repo, label: repoLabel(repo) };
    this.repoElements.set(repo.path, element);
    return element;
  }

  private folderItem(element: FolderElement): vscode.TreeItem {
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
    item.id = `folder:${element.root}`;
    item.iconPath = new vscode.ThemeIcon('folder');
    item.description = `${element.repos.length}`;
    item.tooltip = element.root;
    return item;
  }

  private repoItem(element: TreeElement): vscode.TreeItem {
    const { repo } = element;
    const state = this.gitStates.get(repo.path);
    const openedAt = this.recency.all().get(canonicalPathKey(repo.path));

    const isCurrent = this.currentRepos.has(canonicalPathKey(repo.path));
    const isPinned = this.pins.isPinned(repo.path);
    const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
    item.id = `repo:${repo.path}`;
    // a pin icon explains why pinned repos sit at the top
    const iconId = isPinned ? 'pinned' : 'source-control';
    if (isCurrent) {
      item.iconPath = new vscode.ThemeIcon(iconId, new vscode.ThemeColor('charts.blue'));
      // label color comes from CurrentRepoDecorationProvider via this resourceUri
      item.resourceUri = vscode.Uri.file(repo.path).with({ scheme: CURRENT_REPO_SCHEME });
    } else {
      item.iconPath = new vscode.ThemeIcon(iconId);
    }
    item.description = describeRepo(state, openedAt);
    item.tooltip = repoTooltip(repo, state, openedAt, isCurrent, isPinned);
    // the -pinned suffix drives the pin/unpin context-menu items; /^repo/ matchers still apply
    item.contextValue =
      (repo.parentRepoPath === undefined ? 'repo' : 'repoNested') + (isPinned ? '-pinned' : '');
    item.command = {
      command: 'repodock.open',
      title: 'Open Repository',
      arguments: [element],
    };
    return item;
  }
}

/** The dim text after the repo name: branch and last-opened time; details live in the tooltip. */
export function describeRepo(state: GitState | undefined, openedAt?: number): string {
  const parts: string[] = [];
  if (state) parts.push(state.detached ? `${state.branch} (detached)` : state.branch);
  if (openedAt !== undefined) parts.push(formatCompactRelativeTime(openedAt));
  return parts.join(' · ');
}

function repoTooltip(
  repo: RepoInfo,
  state: GitState | undefined,
  openedAt: number | undefined,
  isCurrent: boolean,
  isPinned: boolean,
): vscode.MarkdownString {
  // repo names, paths, and branch names come from the filesystem; append them as
  // text so markdown in them can't inject formatting or links into the tooltip
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown('**');
  tooltip.appendText(repo.name);
  const flags = [isCurrent ? 'open in this window' : '', isPinned ? 'pinned' : '']
    .filter(Boolean)
    .join(', ');
  tooltip.appendMarkdown(`**${flags ? ` — ${flags}` : ''}\n\n`);
  tooltip.appendText(tildify(repo.path));
  if (state) {
    tooltip.appendMarkdown('\n\nBranch: ');
    tooltip.appendText(state.branch);
    tooltip.appendMarkdown(`${state.detached ? ' (detached)' : ''}  \n`);
    const dirty = state.changes + state.untracked;
    tooltip.appendMarkdown(
      dirty > 0
        ? `Changes: ${state.changes} modified, ${state.untracked} untracked`
        : 'Working tree clean',
    );
    if (state.hasUpstream) {
      tooltip.appendMarkdown(`  \nUpstream: ${state.ahead} ahead, ${state.behind} behind`);
    }
  }
  if (openedAt !== undefined) {
    tooltip.appendMarkdown(`\n\nLast opened: ${formatRelativeTime(openedAt)}`);
  }
  return tooltip;
}
