import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canonicalPathKey } from '../core/paths';
import type { SortOrder } from '../core/sorting';

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

export function getConfig(): RepoDockConfig {
  const cfg = vscode.workspace.getConfiguration('repodock');
  return {
    directories: dedupePaths(cfg.get<string[]>('directories', []).map(expandPath)),
    maxDepth: cfg.get<number>('maxDepth', 4),
    exclude: cfg.get<string[]>('exclude', ['node_modules', 'bower_components', '.Trash']),
    hiddenRepos: cfg.get<string[]>('hiddenRepos', []).map(expandPath),
    showNestedRepos: cfg.get<boolean>('showNestedRepos', true),
    sortOrder: cfg.get<SortOrder>('sortOrder', 'recent'),
    groupByFolder: cfg.get<boolean>('groupByFolder', false),
    openInNewWindow: cfg.get<boolean>('openInNewWindow', false),
  };
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = canonicalPathKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

export function expandPath(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.resolve(os.homedir(), p.slice(2));
  return path.resolve(p);
}

export function tildify(p: string): string {
  const home = os.homedir();
  // canonical keys fold case on Windows, where drive-letter casing varies (c:\ vs C:\)
  const key = canonicalPathKey(p);
  const homeKey = canonicalPathKey(home);
  return key === homeKey || key.startsWith(homeKey + path.sep) ? '~' + p.slice(home.length) : p;
}

export async function addDirectories(paths: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('repodock');
  const existing = cfg.get<string[]>('directories', []);
  const merged = [...existing];
  for (const p of paths.map(tildify)) {
    const key = canonicalPathKey(expandPath(p));
    if (!merged.some((entry) => canonicalPathKey(expandPath(entry)) === key)) merged.push(p);
  }
  await cfg.update('directories', merged, vscode.ConfigurationTarget.Global);
}

export async function removeDirectory(absolutePath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('repodock');
  const key = canonicalPathKey(absolutePath);
  const remaining = cfg
    .get<string[]>('directories', [])
    .filter((entry) => canonicalPathKey(expandPath(entry)) !== key);
  await cfg.update('directories', remaining, vscode.ConfigurationTarget.Global);
}

export async function hideRepo(absolutePath: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('repodock');
  const existing = cfg.get<string[]>('hiddenRepos', []);
  const key = canonicalPathKey(absolutePath);
  if (existing.some((entry) => canonicalPathKey(expandPath(entry)) === key)) return;
  await cfg.update(
    'hiddenRepos',
    [...existing, tildify(absolutePath)],
    vscode.ConfigurationTarget.Global,
  );
}

export async function unhideAllRepos(): Promise<void> {
  await vscode.workspace
    .getConfiguration('repodock')
    .update('hiddenRepos', undefined, vscode.ConfigurationTarget.Global);
}

export async function setSortOrder(order: SortOrder): Promise<void> {
  await vscode.workspace
    .getConfiguration('repodock')
    .update('sortOrder', order, vscode.ConfigurationTarget.Global);
}

export async function setGroupByFolder(enabled: boolean): Promise<void> {
  await vscode.workspace
    .getConfiguration('repodock')
    .update('groupByFolder', enabled, vscode.ConfigurationTarget.Global);
}
