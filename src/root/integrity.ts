import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { ExpectedEntry } from './build.js';
import { escapingLinks } from './symlinks.js';
import { lstatOrNull, walk } from './walk.js';

export class IntegrityError extends Error {
  constructor(readonly issues: readonly string[]) {
    const shown = issues.slice(0, 25).map((i) => `- ${i}`);
    if (issues.length > 25) shown.push(`- ... and ${issues.length - 25} more`);
    super(`root integrity check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${shown.join('\n')}`);
    this.name = 'IntegrityError';
  }
}

/**
 * The root integrity check (plan 5.3). Zero-byte and partial copies produced false "file does not exist"
 * findings in the private council, so before the hash:
 * - no zero-byte file exists that the git tree (or a copied context path) does not have;
 * - every file the build placed is present with its size, which covers every top-level directory's first file;
 * - every path the brief promises exists (a trailing `/` means a directory);
 * - no symlink is absolute or resolves outside the root.
 * Returns the issues; an empty list means the root passed.
 */
export function checkIntegrity(root: string, expected: ReadonlyMap<string, ExpectedEntry>, promises: readonly string[]): string[] {
  const issues: string[] = [];
  for (const entry of walk(root)) {
    if (entry.kind !== 'file' || entry.stats.size !== 0) continue;
    const want = expected.get(entry.rel);
    if (want === undefined || want.kind !== 'file' || want.size !== 0) {
      issues.push(`zero-byte file that the git tree does not have: ${entry.rel}`);
    }
  }
  for (const [path, want] of [...expected].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const stats = lstatOrNull(join(root, path));
    if (stats === null) {
      issues.push(`missing: ${path} (${want.size} bytes from ${want.origin})`);
      continue;
    }
    if (want.kind === 'symlink') {
      if (!stats.isSymbolicLink()) issues.push(`not a symlink: ${path}`);
      else if (Buffer.byteLength(readlinkSync(join(root, path))) !== want.size) issues.push(`symlink target changed: ${path}`);
      continue;
    }
    if (!stats.isFile()) issues.push(`not a regular file: ${path}`);
    else if (stats.size !== want.size) issues.push(`size mismatch: ${path}: expected ${want.size} bytes, found ${stats.size}`);
  }
  for (const promise of promises) {
    const dir = promise.endsWith('/');
    const stats = lstatOrNull(join(root, dir ? promise.slice(0, -1) : promise));
    if (stats === null) issues.push(`the brief promises ${promise}, which is missing`);
    else if (dir && !stats.isDirectory()) issues.push(`the brief promises the directory ${promise}, which is not a directory`);
    else if (!dir && stats.isDirectory()) issues.push(`the brief promises the file ${promise}, which is a directory`);
  }
  for (const link of escapingLinks(root)) {
    issues.push(`symlink escapes the root (${link.reason}): ${link.path}`);
  }
  return issues;
}

export function assertIntegrity(root: string, expected: ReadonlyMap<string, ExpectedEntry>, promises: readonly string[]): void {
  const issues = checkIntegrity(root, expected, promises);
  if (issues.length > 0) throw new IntegrityError(issues);
}
