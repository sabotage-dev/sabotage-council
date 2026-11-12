import { createHash } from 'node:crypto';
import { closeSync, openSync, readlinkSync, readSync } from 'node:fs';
import { walk, type EntryKind } from './walk.js';

export interface ManifestEntry {
  /** Root-relative, `/` separated. */
  path: string;
  kind: EntryKind;
  /** Owner execute bit (files only). */
  exec: boolean;
  size: number;
  /** sha256 of a file's bytes or a link's target; empty for directories and other kinds. */
  digest: string;
}

function digestFile(path: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      hash.update(buffer.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

/** Every entry under the root, by lstat, with content digests. */
export function manifestOf(root: string): ManifestEntry[] {
  return walk(root).map((entry) => {
    const exec = entry.kind === 'file' && (entry.stats.mode & 0o100) !== 0;
    let digest = '';
    if (entry.kind === 'file') digest = digestFile(entry.abs);
    else if (entry.kind === 'symlink') digest = createHash('sha256').update(readlinkSync(entry.abs)).digest('hex');
    return { path: entry.rel, kind: entry.kind, exec, size: entry.kind === 'dir' ? 0 : entry.stats.size, digest };
  });
}

function canonicalLine(e: ManifestEntry): string {
  return `${e.kind}\t${e.exec ? 'x' : '-'}\t${e.size}\t${e.digest}\t${JSON.stringify(e.path)}\n`;
}

/**
 * The root's tree hash (plan 5.3): sha256 over every entry's kind, execute bit, size, content digest and path,
 * sorted by path. It covers files, links, empty directories and the brief, and nothing outside the root.
 */
export function hashManifest(entries: readonly ManifestEntry[]): string {
  const hash = createHash('sha256');
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) hash.update(canonicalLine(e));
  return `sha256:${hash.digest('hex')}`;
}

export function treeHash(root: string): string {
  return hashManifest(manifestOf(root));
}

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface ManifestChange {
  path: string;
  change: ChangeKind;
}

/** What differs between two manifests of the same root, sorted by path. */
export function diffManifests(before: readonly ManifestEntry[], after: readonly ManifestEntry[]): ManifestChange[] {
  const old = new Map(before.map((e) => [e.path, canonicalLine(e)]));
  const now = new Map(after.map((e) => [e.path, canonicalLine(e)]));
  const out: ManifestChange[] = [];
  for (const [path, line] of now) {
    const prev = old.get(path);
    if (prev === undefined) out.push({ path, change: 'added' });
    else if (prev !== line) out.push({ path, change: 'modified' });
  }
  for (const path of old.keys()) if (!now.has(path)) out.push({ path, change: 'removed' });
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
