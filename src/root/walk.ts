import { lstatSync, readdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other';

export interface WalkEntry {
  /** Path relative to the walk's base, with `/` separators. */
  rel: string;
  abs: string;
  kind: EntryKind;
  stats: Stats;
}

export function kindOf(stats: Stats): EntryKind {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isDirectory()) return 'dir';
  if (stats.isFile()) return 'file';
  return 'other';
}

/**
 * Pre-order walk by lstat: symlinks are reported, never followed, so a link to a directory is not entered.
 * Names are sorted so every walk of the same tree visits entries in the same order.
 * `descend` may stop the walk from entering a directory (it is still reported).
 */
export function walk(base: string, start = '', descend: (entry: WalkEntry) => boolean = () => true): WalkEntry[] {
  const out: WalkEntry[] = [];
  const visit = (rel: string): void => {
    const names = readdirSync(rel === '' ? base : join(base, rel)).sort();
    for (const name of names) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const abs = join(base, childRel);
      const stats = lstatSync(abs);
      const entry: WalkEntry = { rel: childRel, abs, kind: kindOf(stats), stats };
      out.push(entry);
      if (entry.kind === 'dir' && descend(entry)) visit(childRel);
    }
  };
  visit(start);
  return out;
}

export function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
