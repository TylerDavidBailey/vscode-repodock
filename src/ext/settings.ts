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
    directories: dedupePaths(
      storedStrings(config.get<unknown>('directories')).filter(isUsablePath).map(expandPath),
    ),
    maxDepth: clampMaxDepth(config.get<unknown>('maxDepth')),
    exclude: readExclude(config.get<unknown>('exclude')),
    hiddenRepos: storedStrings(config.get<unknown>('hiddenRepos'))
      .filter(isUsablePath)
      .map(expandPath),
    showNestedRepos: config.get<boolean>('showNestedRepos', true),
    sortOrder: config.get<SortOrder>('sortOrder', 'recent'),
    groupByFolder: config.get<boolean>('groupByFolder', false),
    openInNewWindow: config.get<boolean>('openInNewWindow', false),
  };
}

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_EXCLUDE = ['node_modules', 'bower_components', '.Trash'];

/**
 * The string entries of a stored list setting. The schema in `package.json` is advisory:
 * a hand-edited settings.json can hold a bare string or a number where a list belongs, and
 * VS Code hands that value over unchanged. Anything that is not a list reads as empty, so
 * one malformed setting cannot stop the extension from activating.
 */
function storedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Falls back to the default list when the stored value is not a list at all. */
function readExclude(value: unknown): string[] {
  return Array.isArray(value) ? storedStrings(value) : DEFAULT_EXCLUDE;
}

/** Holds `maxDepth` to the 1 to 16 range the schema declares, which VS Code does not enforce. */
function clampMaxDepth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_DEPTH;
  return Math.min(16, Math.max(1, Math.trunc(value)));
}

/**
 * Whether a stored entry names a directory on its own. Settings JSON is edited by hand, and
 * an empty string or a relative path would resolve against the extension host's working
 * directory, which is wherever VS Code was launched from (`/` on macOS): scanning that walks
 * the whole disk. Such entries are dropped rather than resolved, as is anything that is not
 * a string, which `expandPath` would throw on.
 */
function isUsablePath(entry: unknown): entry is string {
  if (typeof entry !== 'string' || entry.trim() === '') return false;
  return (
    entry === '~' || entry.startsWith('~/') || entry.startsWith('~\\') || path.isAbsolute(entry)
  );
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
 * The scope whose value `get` currently returns for `key`, so that a write lands where the
 * user will see it. VS Code resolves settings workspace-first, so writing to the global
 * scope while the workspace holds a value changes nothing visible. A Restricted Mode
 * workspace is the exception: its workspace values are ignored, so its global scope is the
 * one in effect. Every setting here is window-scoped, so folder values never apply.
 */
function effectiveTarget(
  config: vscode.WorkspaceConfiguration,
  key: string,
): vscode.ConfigurationTarget {
  const hasWorkspaceValue = config.inspect(key)?.workspaceValue !== undefined;
  return hasWorkspaceValue && vscode.workspace.isTrusted
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

/** The scopes that hold a value for `key`, so a removal can reach each one. */
function scopesHolding(
  config: vscode.WorkspaceConfiguration,
  key: string,
): vscode.ConfigurationTarget[] {
  const info = config.inspect(key);
  const scopes: vscode.ConfigurationTarget[] = [];
  if (info?.workspaceValue !== undefined) scopes.push(vscode.ConfigurationTarget.Workspace);
  if (info?.globalValue !== undefined) scopes.push(vscode.ConfigurationTarget.Global);
  return scopes;
}

let pendingListWrite: Promise<unknown> = Promise.resolve();

/**
 * Runs list writers one at a time. Each reads the stored list, changes it, and writes it
 * back, and `update` resolves only once the new value is readable, so two writers that
 * overlap would both start from the old list and the second would undo the first.
 */
function inWriteOrder<T>(write: () => Promise<T>): Promise<T> {
  const result = pendingListWrite.then(write, write);
  pendingListWrite = result.catch(() => undefined);
  return result;
}

/**
 * Adds scan roots, skipping any already configured. Stores them tildified, in the scope
 * whose list is in effect (see `effectiveTarget`). Like every writer here, the update fires
 * the configuration listener in `extension.ts`, which rescans; callers need not refresh
 * the tree themselves.
 */
export function addDirectories(paths: string[]): Promise<void> {
  return inWriteOrder(async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const existing = storedStrings(config.get<unknown>('directories'));
    const merged = [...existing];
    for (const dir of paths.map(tildify)) {
      const key = canonicalPathKey(expandPath(dir));
      if (!merged.some((entry) => canonicalPathKey(expandPath(entry)) === key)) merged.push(dir);
    }
    await config.update('directories', merged, effectiveTarget(config, 'directories'));
  });
}

/**
 * Removes a scan root from every scope that lists it, so no lower-priority scope can bring
 * it back. Matches by canonical key, so stored `~` entries are found too.
 */
export function removeDirectory(absolutePath: string): Promise<void> {
  return inWriteOrder(async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const key = canonicalPathKey(absolutePath);
    const info = config.inspect<unknown>('directories');
    for (const scope of scopesHolding(config, 'directories')) {
      const stored = storedStrings(
        scope === vscode.ConfigurationTarget.Workspace ? info?.workspaceValue : info?.globalValue,
      );
      const remaining = stored.filter((entry) => canonicalPathKey(expandPath(entry)) !== key);
      if (remaining.length !== stored.length) await config.update('directories', remaining, scope);
    }
  });
}

/**
 * Hides one repository from the tree, which also hides any repos nested inside it. Written
 * to the scope whose list is in effect (see `effectiveTarget`).
 */
export function hideRepo(absolutePath: string): Promise<void> {
  return inWriteOrder(async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const existing = storedStrings(config.get<unknown>('hiddenRepos'));
    const key = canonicalPathKey(absolutePath);
    if (existing.some((entry) => canonicalPathKey(expandPath(entry)) === key)) return;
    await config.update(
      'hiddenRepos',
      [...existing, tildify(absolutePath)],
      effectiveTarget(config, 'hiddenRepos'),
    );
  });
}

/** Clears the hidden list in every scope that has one, so nothing stays hidden. */
export function unhideAllRepos(): Promise<void> {
  return inWriteOrder(async () => {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    for (const scope of scopesHolding(config, 'hiddenRepos')) {
      await config.update('hiddenRepos', undefined, scope);
    }
  });
}

export async function setSortOrder(order: SortOrder): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('sortOrder', order, effectiveTarget(config, 'sortOrder'));
}

export async function setGroupByFolder(enabled: boolean): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await config.update('groupByFolder', enabled, effectiveTarget(config, 'groupByFolder'));
}
