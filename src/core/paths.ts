/**
 * Key for comparing filesystem paths for equality. Linux is the only platform whose
 * filesystem is case-sensitive by default, so keys fold case everywhere else: NTFS is
 * case-insensitive and VS Code is inconsistent about drive-letter casing (`c:\...` vs
 * `C:\...`), and macOS ships case-insensitive APFS. Without folding on macOS, two scan
 * roots differing only in case are the same directory but different keys, and every
 * repo under them is listed twice.
 *
 * A case-sensitive APFS volume is the known exception and is not detected: two repos
 * there whose paths differ only in case collapse to one entry.
 */
export function canonicalPathKey(p: string): string {
  return process.platform === 'linux' ? p : p.toLowerCase();
}
