import { describe, expect, it } from 'vitest';
import { canonicalPathKey } from '../../src/core/paths';

describe('canonicalPathKey', () => {
  it('folds case on Windows only (drive letters and NTFS are case-insensitive)', () => {
    const key = canonicalPathKey('C:\\Repos\\API');
    if (process.platform === 'win32') {
      expect(key).toBe('c:\\repos\\api');
    } else {
      expect(key).toBe('C:\\Repos\\API');
    }
  });

  it('keys equal for identical paths', () => {
    expect(canonicalPathKey('/home/user/repos')).toBe(canonicalPathKey('/home/user/repos'));
  });
});
