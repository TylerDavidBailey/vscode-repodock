import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';
import type { SortOrder } from '../core/sorting';

const CONFIG_SECTION = 'repodock';

/**
 * Read once: `tildify` runs for every rendered row and `homedir()` reads the password
 * database on POSIX. The home directory cannot change while the extension host lives.
 */
const HOME = os.homedir();

/**
 * A snapshot of the `repodock.*` settings with paths already expanded and deduplicated,
 * so callers work in absolute paths and never see a stored `~`.
 */
export interface RepoDockConfig {
  /** Absolute, deduplicated scan roots. */
  directories: string[];
  maxDepth: number;
  exclude: string[];
  /** Absolute paths of repositories hidden via the context menu. */
  hiddenRepos: string[];
  showNestedRepos: boolean;
  sortOrder: SortOrder;
  groupByFolder: boolean;
  openInNewWindow: boolean;
}

/**
 * Reads the current settings. Cheap and always live, so call it at the point of use
 * rather than caching a snapshot that a configuration change would leave stale.
 */
export function getConfig(): RepoDockConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    directories: dedupePaths(config.get<string[]>('directories', []).map(expandPath)),
    maxDepth: config.get<number>('maxDepth', 4),
    exclude: config.get<string[]>('exclude', ['node_modules', 'bower_components', '.Trash']),
    hiddenRepos: config.get<string[]>('hiddenRepos', []).map(expandPath),
    showNestedRepos: config.get<boolean>('showNestedRepos', true),
    sortOrder: config.get<SortOrder>('sortOrder', 'recent'),
    groupByFolder: config.get<boolean>('groupByFolder', false),
    openInNewWindow: config.get<boolean>('openInNewWindow', false),
  };
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const dir of paths) {
    const key = canonicalPathKey(dir);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(dir);
    }
  }
  return unique;
}

/**
 * Resolves a stored or user-supplied path to an absolute one, expanding a leading `~`.
 * Use before touching the filesystem; use `tildify` for the reverse, and `canonicalPathKey`
 * to compare two paths for equality.
 */
export function expandPath(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.resolve(HOME, p.slice(2));
  return path.resolve(p);
}

/**
 * Shortens the home directory back to `~`. Use for anything shown to the user or written
 * back to settings, so the stored value stays portable across machines.
 */
export function tildify(p: string): string {
  const key = canonicalPathKey(p);
  const homeKey = canonicalPathKey(HOME);
  return key === homeKey || key.startsWith(homeKey + path.sep) ? '~' + p.slice(HOME.length) : p;
}

/**
 * Adds scan roots, skipping any already configured. Stores them tildified, and — like
 * every writer here — updates global settings, which fires the configuration listener
 * in `extension.ts` and rescans; callers need not refresh the tree themselves.
 */
export async function addDirectories(paths: string[]): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const existing = config.get<string[]>('directories', []);
  const merged = [...existing];
  for (const dir of paths.map(tildify)) {
    const key = canonicalPathKey(expandPath(dir));
    if (!merged.some((entry) => canonicalPathKey(expandPath(entry)) === key)) merged.push(dir);
  }
  await config.update('directories', merged, vscode.ConfigurationTarget.Global);
}

/** Removes a scan root. Matches by canonical key, so stored `~` entries are found too. */
export async function removeDirectory(absolutePath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const key = canonicalPathKey(absolutePath);
  const remaining = config
    .get<string[]>('directories', [])
    .filter((entry) => canonicalPathKey(expandPath(entry)) !== key);
  await config.update('directories', remaining, vscode.ConfigurationTarget.Global);
}

/** Hides one repository from the tree, which also hides any repos nested inside it. */
export async function hideRepo(absolutePath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const existing = config.get<string[]>('hiddenRepos', []);
  const key = canonicalPathKey(absolutePath);
  if (existing.some((entry) => canonicalPathKey(expandPath(entry)) === key)) return;
  await config.update(
    'hiddenRepos',
    [...existing, tildify(absolutePath)],
    vscode.ConfigurationTarget.Global,
  );
}

export async function unhideAllRepos(): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('hiddenRepos', undefined, vscode.ConfigurationTarget.Global);
}

export async function setSortOrder(order: SortOrder): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('sortOrder', order, vscode.ConfigurationTarget.Global);
}

export async function setGroupByFolder(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update('groupByFolder', enabled, vscode.ConfigurationTarget.Global);
}
