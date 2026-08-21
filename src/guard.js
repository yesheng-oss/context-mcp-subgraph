import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

// Follow symlinks to get the true path; fall back to resolve() if path doesn't exist yet.
function safeStat(p) {
  try { return realpathSync(p); } catch { return resolve(p); }
}

/**
 * Resolves `inputPath` (following symlinks) and asserts it falls within `allowedRoot`.
 * Throws if no root is configured or if the path escapes the root.
 * Returns the resolved absolute path on success.
 */
export function guardPath(inputPath, allowedRoot) {
  if (!allowedRoot) {
    throw new Error(
      'Project root not configured. Call context with action:"resume" and include rootPath to enable file/git access.'
    );
  }
  const resolved = safeStat(inputPath);
  const root = safeStat(allowedRoot);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`Access denied: "${resolved}" is outside the project root "${root}"`);
  }
  return resolved;
}
