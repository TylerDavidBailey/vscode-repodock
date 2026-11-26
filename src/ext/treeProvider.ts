import * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';
import { formatRelativeTime, pinnedRepos, repoLabels, sortByRecency } from '../core/sorting';
import { buildRepoTree, type FolderNode, type RepoNode, type RepoTreeNode } from '../core/tree';
import type { GitState, RepoInfo } from '../core/types';
import type { ExpansionStore } from './expansion';
import type { PinStore } from './pins';
import type { RecencyStore } from './recency';
import type { RepoModel } from './repoModel';
import { getConfig, tildify } from './settings';

/** The blank row between the pinned repos and the rest, which is all that marks where pins end. */
export interface GapNode {
  kind: 'gap';
  children: [];
}

/** A row in the RepoDock view; narrow on `kind`. */
export type TreeNode = GapNode | RepoTreeNode;

/**
 * Backs the RepoDock view: pinned repos first, by name, then a blank row, then every other
 * repo, laid out as `repodock.layout` says. The folder layout mirrors the disk, and the
 * recent layout is one list with the most recently opened first.
 *
 * Identity matters: commands receive the element of the row they were invoked on, so the
 * rows of the latest render are kept and `findRepoElement` returns those instances.
 */
export class RepoTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private roots?: TreeNode[];
  /** The row of each listed repo, by canonical path key. */
  private readonly repoNodes = new Map<string, RepoNode>();
  /** The rows of pinned repos, which take their own id prefix. A repo has one row only. */
  private readonly pinnedRows = new Set<RepoNode>();
  private readonly parents = new Map<TreeNode, TreeNode>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly model: RepoModel,
    private readonly recency: RecencyStore,
    private readonly pins: PinStore,
    private readonly expansion: ExpansionStore,
  ) {
    this.subscriptions = [
      model.onDidChangeRepos(() => {
        this.rebuild();
      }),
      model.onDidChangeGitState((repoPath) => {
        const node = this.repoNodes.get(canonicalPathKey(repoPath));
        if (node) this.changeEmitter.fire(node);
      }),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changeEmitter.dispose();
  }

  /**
   * Re-renders from the repos the model already holds. Call after anything that changes
   * which rows the view lists or how a row looks: a pin, an open, a settings change.
   */
  rebuild(): void {
    this.roots = undefined;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'gap') return this.gapItem(node);
    return node.kind === 'repo' ? this.repoItem(node) : this.folderItem(node);
  }

  /**
   * The tree item id of a row, which is also the key its fold state is remembered under.
   * Ids are unique across the whole tree, which VS Code requires. A scan root and a folder
   * can share a path when one configured folder sits inside another, so the kind of row is
   * part of the id. A pinned row gets its own prefix so pinning reads to VS Code as one row
   * leaving and another arriving, rather than one row jumping to a new parent.
   */
  idOf(node: TreeNode): string {
    if (node.kind === 'gap') return 'gap';
    if (node.kind === 'folder') return `${node.isRoot ? 'root' : 'folder'}:${node.path}`;
    return `${this.pinnedRows.has(node) ? 'pinned' : 'repo'}:${node.repo.path}`;
  }

  /** Expanded or Collapsed: the user's last choice for this row, else `isExpandedByDefault`. */
  private foldState(node: TreeNode, isExpandedByDefault: boolean): vscode.TreeItemCollapsibleState {
    return this.expansion.isExpanded(this.idOf(node), isExpandedByDefault)
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return node.children;
    // a root request is a full re-render, so the rows handed out last time are dropped
    this.roots = undefined;
    return this.render();
  }

  /** Lets `TreeView.reveal` reach a nested row, which it does by walking up from it. */
  getParent(node: TreeNode): TreeNode | undefined {
    this.render();
    return this.parents.get(node);
  }

  /** The row for a repo path, or undefined when the view does not list it. */
  findRepoElement(repoPath: string): RepoNode | undefined {
    this.render();
    return this.repoNodes.get(canonicalPathKey(repoPath));
  }

  /** Builds the rows unless the last render still stands. */
  private render(): TreeNode[] {
    if (this.roots) return this.roots;
    this.repoNodes.clear();
    this.pinnedRows.clear();
    this.parents.clear();

    const config = getConfig();
    const repos = this.model.visibleRepos();
    const pinnedKeys = this.pins.all();
    const pinned = flatList(pinnedRepos(repos, pinnedKeys));
    // a nested repo whose parent is pinned stays down here, placed by its folders
    const others = repos.filter((repo) => !pinnedKeys.has(canonicalPathKey(repo.path)));
    const rest =
      config.layout === 'recent'
        ? flatList(sortByRecency(others, this.recency.all()))
        : buildRepoTree(others, config.directories);

    for (const node of pinned) {
      this.pinnedRows.add(node);
      this.index(node);
    }
    for (const node of rest) this.index(node);
    // With no repos at all there are no rows, which is what brings up the welcome text in
    // package.json. The gap only separates two groups, so it goes when either is empty.
    const gap: GapNode[] =
      pinned.length > 0 && rest.length > 0 ? [{ kind: 'gap', children: [] }] : [];
    this.roots = [...pinned, ...gap, ...rest];
    return this.roots;
  }

  private index(node: RepoTreeNode, parent?: TreeNode): void {
    if (parent) this.parents.set(node, parent);
    if (node.kind === 'repo') {
      this.repoNodes.set(canonicalPathKey(node.repo.path), node);
    }
    for (const child of node.children) this.index(child, node);
  }

  private gapItem(node: GapNode): vscode.TreeItem {
    const item = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
    item.id = this.idOf(node);
    // a screen reader would otherwise announce an empty row
    item.accessibilityInformation = { label: 'End of pinned repositories' };
    // deliberately no contextValue: the /^repo/ menus in package.json must skip it
    return item;
  }

  private folderItem(node: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.isRoot ? tildify(node.path) : node.label,
      this.foldState(node, true),
    );
    item.id = this.idOf(node);
    item.tooltip = tildify(node.path);
    // deliberately no contextValue: the /^repo/ menus in package.json must skip folders
    return item;
  }

  private repoItem(node: RepoNode): vscode.TreeItem {
    const { repo } = node;
    const state = this.model.getGitStates().get(repo.path);
    const openedAt = this.recency.all().get(canonicalPathKey(repo.path));
    const isCurrent = this.model.isCurrent(repo.path);
    const isPinned = this.pins.isPinned(repo.path);

    const item = new vscode.TreeItem(
      node.label,
      // a repo that holds nested repos starts collapsed: they are vendored code more
      // often than something to switch to, so they stay one click away
      node.children.length > 0 ? this.foldState(node, false) : vscode.TreeItemCollapsibleState.None,
    );
    item.id = this.idOf(node);
    // A dot on every repo tells repos from folders, and a blue one marks the repo open in
    // this window. Coloring the label instead would need a resourceUri, and VS Code draws
    // the file-icon theme's icon on a row with a resourceUri and no icon of its own; a
    // label highlight draws as a find-match box. The row shows the name alone: branch,
    // upstream distance, changes, and last-opened time are all in the tooltip.
    item.iconPath = new vscode.ThemeIcon(
      'circle-small-filled',
      new vscode.ThemeColor(isCurrent ? 'charts.blue' : 'descriptionForeground'),
    );
    item.tooltip = repoTooltip(repo, state, openedAt, isCurrent, isPinned);
    // the -pinned suffix drives the pin/unpin menu items; /^repo/ matchers still apply
    item.contextValue =
      (repo.parentRepoPath === undefined ? 'repo' : 'repoNested') + (isPinned ? '-pinned' : '');
    item.command = {
      command: 'repodock.open',
      title: 'Open Repository',
      arguments: [node],
    };
    return item;
  }
}

/**
 * Rows for repos that sit side by side with no folders above them, so same-named repos
 * are told apart in the label itself.
 */
function flatList(repos: readonly RepoInfo[]): RepoNode[] {
  const labels = repoLabels(repos);
  return repos.map((repo) => ({
    kind: 'repo',
    repo,
    label: labels.get(repo.path) ?? repo.name,
    children: [],
  }));
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
