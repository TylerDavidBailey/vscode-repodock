import * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';
import {
  formatCompactRelativeTime,
  formatRelativeTime,
  pinnedRepos,
  recentRepos,
  repoLabels,
} from '../core/sorting';
import { buildRepoTree, type FolderNode, type RepoNode, type RepoTreeNode } from '../core/tree';
import type { GitState, RepoInfo } from '../core/types';
import type { ExpansionStore } from './expansion';
import type { PinStore } from './pins';
import type { RecencyStore } from './recency';
import type { RepoModel } from './repoModel';
import { getConfig, tildify } from './settings';

/**
 * Marks a repo row's resourceUri as one `RepoDecorationProvider` should decorate. What to
 * draw travels in the URI's query, so a row whose state changes gets a different URI and
 * VS Code asks for its decoration again without any change event.
 */
export const REPO_URI_SCHEME = 'repodock-repo';

/** VS Code rejects a decoration badge longer than two characters. */
const MAX_BADGE_COUNT = 99;

/**
 * Draws what a row's label and description have no room for: the count of uncommitted
 * files at the right edge of the row, and the color of the repo open in this window.
 */
export class RepoDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== REPO_URI_SCHEME) return undefined;
    const query = new URLSearchParams(uri.query);
    const changes = Number(query.get('changes') ?? 0);
    return new vscode.FileDecoration(
      changes > 0 ? String(Math.min(changes, MAX_BADGE_COUNT)) : undefined,
      changes > 0 ? `${changes} uncommitted ${changes === 1 ? 'change' : 'changes'}` : undefined,
      query.get('current') === '1' ? new vscode.ThemeColor('charts.blue') : undefined,
    );
  }
}

/** The three lists the view shows, top to bottom. */
export type Section = 'pinned' | 'recent' | 'all';

const SECTION_LABELS: Readonly<Record<Section, string>> = {
  pinned: 'Pinned',
  recent: 'Recent',
  all: 'All Repositories',
};

/** The collapsible row heading one section. */
export interface SectionNode {
  kind: 'section';
  section: Section;
  label: string;
  children: RepoTreeNode[];
  /** Repositories the section lists, each counted once. */
  repoCount: number;
}

/** A row in the RepoDock view; narrow on `kind`. */
export type TreeNode = SectionNode | RepoTreeNode;

function countRepos(nodes: readonly RepoTreeNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.kind === 'repo' ? 1 : 0) + countRepos(node.children),
    0,
  );
}

/**
 * Backs the RepoDock view: one tree holding three sections. Pinned and Recent are flat
 * lists of repos, and All Repositories is the folder hierarchy. A repo can therefore have
 * up to three rows, one per section, each its own element.
 *
 * The sections are rows of one tree rather than three views because VS Code gives every
 * view in a container a minimum height and splits the sidebar between them: two pinned
 * repos would sit above a block of empty space. Rows of one tree take the height they need.
 *
 * Identity matters: commands receive the element of the row they were invoked on, so the
 * rows of the latest render are kept and `findRepoElement` returns those instances.
 */
export class RepoTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private roots?: SectionNode[];
  private readonly repoNodes: Readonly<Record<Section, Map<string, RepoNode>>> = {
    pinned: new Map(),
    recent: new Map(),
    all: new Map(),
  };
  /** The section each rendered row belongs to, which decides its id and what it shows. */
  private readonly sectionOf = new Map<TreeNode, Section>();
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
        const key = canonicalPathKey(repoPath);
        for (const nodes of Object.values(this.repoNodes)) {
          const node = nodes.get(key);
          if (node) this.changeEmitter.fire(node);
        }
      }),
    ];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.changeEmitter.dispose();
  }

  /**
   * Re-renders from the repos the model already holds. Call after anything that changes
   * which repos a section lists or how a row looks: a pin, an open, a settings change.
   */
  rebuild(): void {
    this.roots = undefined;
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'section') return this.sectionItem(node);
    return node.kind === 'repo' ? this.repoItem(node) : this.folderItem(node);
  }

  /**
   * The tree item id of a row, which is also the key its fold state is remembered under.
   * Ids are unique across the whole tree, which VS Code requires. A scan root and a folder
   * can share a path when one configured folder sits inside another, and one repo can have
   * a row in each section, so the kind of row and the section are part of the id.
   */
  idOf(node: TreeNode): string {
    if (node.kind === 'section') return `section:${node.section}`;
    if (node.kind === 'folder') return `${node.isRoot ? 'root' : 'folder'}:${node.path}`;
    return `${this.sectionOf.get(node) ?? 'all'}:${node.repo.path}`;
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

  /**
   * The row for a repo path in one section, or undefined when that section does not list
   * it. A repo has a separate row in each section it appears in.
   */
  findRepoElement(repoPath: string, section: Section = 'all'): RepoNode | undefined {
    this.render();
    return this.repoNodes[section].get(canonicalPathKey(repoPath));
  }

  /** Builds the rows unless the last render still stands. */
  private render(): SectionNode[] {
    if (this.roots) return this.roots;
    for (const nodes of Object.values(this.repoNodes)) nodes.clear();
    this.sectionOf.clear();
    this.parents.clear();

    const config = getConfig();
    const repos = this.model.visibleRepos();
    const roots = [
      this.buildSection('pinned', flatList(pinnedRepos(repos, this.pins.all()))),
      this.buildSection(
        'recent',
        flatList(recentRepos(repos, this.recency.all(), config.recentCount)),
      ),
      this.buildSection('all', buildRepoTree(repos, config.directories)),
      // A section with nothing in it is left out rather than shown empty. With no repos at
      // all that leaves no rows, which is what brings up the welcome text in package.json.
    ].filter((section) => section.repoCount > 0);
    this.roots = roots;
    return roots;
  }

  private buildSection(section: Section, children: RepoTreeNode[]): SectionNode {
    const node: SectionNode = {
      kind: 'section',
      section,
      label: SECTION_LABELS[section],
      children,
      repoCount: countRepos(children),
    };
    const index = (child: RepoTreeNode, parent: TreeNode): void => {
      this.parents.set(child, parent);
      this.sectionOf.set(child, section);
      if (child.kind === 'repo') {
        this.repoNodes[section].set(canonicalPathKey(child.repo.path), child);
      }
      for (const grandchild of child.children) index(grandchild, child);
    };
    for (const child of children) index(child, node);
    return node;
  }

  private sectionItem(node: SectionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, this.foldState(node, true));
    item.id = this.idOf(node);
    item.description = String(node.repoCount);
    // deliberately no contextValue: the /^repo/ menus in package.json must skip headings
    return item;
  }

  private folderItem(node: FolderNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.isRoot ? tildify(node.path) : node.label,
      this.foldState(node, true),
    );
    item.id = this.idOf(node);
    item.iconPath = new vscode.ThemeIcon('folder');
    item.description = String(node.repoCount);
    item.tooltip = tildify(node.path);
    // deliberately no contextValue: the /^repo/ menus in package.json must skip folders
    return item;
  }

  private repoItem(node: RepoNode): vscode.TreeItem {
    const { repo } = node;
    const section = this.sectionOf.get(node) ?? 'all';
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
    // one git icon for every repo; a pin replaces it so a pinned repo is recognizable
    // in the sections that are not the Pinned one
    const iconId = isPinned ? 'pinned' : 'source-control';
    item.iconPath = isCurrent
      ? new vscode.ThemeIcon(iconId, new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon(iconId);
    item.resourceUri = decorationUri(repo.path, isCurrent, uncommittedCount(state));
    // only Recent shows when a repo was last opened: there the time explains the order
    item.description = describeRepo(state, section === 'recent' ? openedAt : undefined);
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

function uncommittedCount(state: GitState | undefined): number {
  return state ? state.changes + state.untracked : 0;
}

/** The URI `RepoDecorationProvider` reads, or undefined for a row with nothing to decorate. */
function decorationUri(
  repoPath: string,
  isCurrent: boolean,
  changes: number,
): vscode.Uri | undefined {
  if (!isCurrent && changes === 0) return undefined;
  return vscode.Uri.file(repoPath).with({
    scheme: REPO_URI_SCHEME,
    query: `current=${isCurrent ? '1' : '0'}&changes=${changes}`,
  });
}

/**
 * The dim text after the repo name: the branch, how far it is ahead of (↑) and behind (↓)
 * its upstream, and optionally when the repo was last opened. Uncommitted files are not
 * here; they are the badge at the right edge of the row.
 */
export function describeRepo(state: GitState | undefined, openedAt?: number): string {
  const parts: string[] = [];
  if (state) {
    const git = [state.detached ? `${state.branch} (detached)` : state.branch];
    if (state.hasUpstream && state.ahead > 0) git.push(`↑${state.ahead}`);
    if (state.hasUpstream && state.behind > 0) git.push(`↓${state.behind}`);
    parts.push(git.join(' '));
  }
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
