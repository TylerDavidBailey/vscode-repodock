/**
 * Key for comparing filesystem paths for equality. Windows filesystems are
 * case-insensitive and VS Code is inconsistent about drive-letter casing
 * (`c:\...` vs `C:\...`), so keys fold case there.
 */
export function canonicalPathKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
