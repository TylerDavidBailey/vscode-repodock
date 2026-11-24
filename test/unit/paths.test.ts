import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPathKey, isMissingDirectory } from '../../src/core/paths';

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

// configurable, so a test can switch platforms more than once
function pretendPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
});

describe('canonicalPathKey', () => {
  it('folds case on Windows, where drive letters and NTFS are case-insensitive', () => {
    pretendPlatform('win32');
    expect(canonicalPathKey('C:\\Repos\\API')).toBe('c:\\repos\\api');
  });

  it('folds case on macOS, where APFS ships case-insensitive', () => {
    // two scan roots differing only in case are one directory on disk; without folding,
    // dedupeRepos sees two distinct paths and every repo under them renders twice
    pretendPlatform('darwin');
    expect(canonicalPathKey('/Users/Me/Repos')).toBe(canonicalPathKey('/users/me/repos'));
  });

  it('leaves case alone on Linux, the one platform case-sensitive by default', () => {
    pretendPlatform('linux');
    expect(canonicalPathKey('/home/User/Repos')).toBe('/home/User/Repos');
    expect(canonicalPathKey('/home/User/Repos')).not.toBe(canonicalPathKey('/home/user/repos'));
  });

  it('gives a path the same key as itself on every platform', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      pretendPlatform(platform);
      expect(canonicalPathKey('/home/user/repos')).toBe(canonicalPathKey('/home/user/repos'));
    }
  });
});

describe('isMissingDirectory', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir !== undefined) await fs.rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is false for a directory that exists', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-'));
    expect(await isMissingDirectory(dir)).toBe(false);
  });

  it('is true once the directory is deleted', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-'));
    const gone = path.join(dir, 'deleted');
    expect(await isMissingDirectory(gone)).toBe(true);
  });

  it('is true when a file took the place of the directory', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'repodock-'));
    const file = path.join(dir, 'repo');
    await fs.writeFile(file, '');
    expect(await isMissingDirectory(file)).toBe(true);
    // ENOTDIR, not ENOENT: the path runs through a file
    expect(await isMissingDirectory(path.join(file, 'nested'))).toBe(true);
  });

  it('is false when the check itself fails, since that says nothing about the directory', async () => {
    // a NUL byte makes stat reject before it reaches the file system
    expect(await isMissingDirectory('bad\0path')).toBe(false);
  });
});
