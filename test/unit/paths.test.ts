import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPathKey } from '../../src/core/paths';

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
