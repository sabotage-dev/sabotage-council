import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/*
 * Where a round's roots live, and the only way the engine deletes one (fold row 1). A root is
 * `<roots dir>/<store tag>-<round id>-a<attempt>`, with its git dir `<that>.git` beside it. The store tag (a hash of
 * the store's realpath) keeps two stores that share a roots dir from ever naming the same root. Nothing read from a
 * round dir (round.json, sealed.json) ever names a path to delete.
 */

export interface RootsLayout {
  dbPath: string;
  rootsDir: string;
}

const ROOT_NAME = /^[0-9a-f]{8}-[1-9][0-9]*-a[1-9][0-9]*(?:\.git)?$/;

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The store's tag: the first 8 hex of sha256 of its realpath. */
export function storeTag(dbPath: string): string {
  return createHash('sha256').update(real(dbPath)).digest('hex').slice(0, 8);
}

export function rootName(layout: RootsLayout, roundId: number, attempt: number): string {
  return `${storeTag(layout.dbPath)}-${roundId}-a${attempt}`;
}

/** The root of a round's attempt, from the layout alone. */
export function rootPathOf(layout: RootsLayout, roundId: number, attempt = 1): string {
  return join(resolve(layout.rootsDir), rootName(layout, roundId, attempt));
}

/** Creates a root dir exclusively: it fails when the dir exists, so a build never adopts someone else's dir. */
export function createRootDir(layout: RootsLayout, roundId: number, attempt: number): string {
  mkdirSync(layout.rootsDir, { recursive: true, mode: 0o700 });
  const dir = rootPathOf(layout, roundId, attempt);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

export interface RemoveResult {
  removed: boolean;
  why: string;
}

/**
 * Deletes a root or its `.git` sibling only when the path is a direct child of the layout's roots dir by realpath,
 * its name is a root name, and it is a real directory (never a link). Anything else is refused and left alone.
 */
export function removeOwnedRoot(layout: RootsLayout, path: string): RemoveResult {
  const name = basename(path);
  if (!ROOT_NAME.test(name)) return { removed: false, why: `${name} is not a root name` };
  const parent = real(dirname(resolve(path)));
  if (parent !== real(layout.rootsDir)) return { removed: false, why: `${path} is not directly under the roots dir` };
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { removed: false, why: `${path} does not exist` };
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return { removed: false, why: `${path} is not a directory` };
  if (real(path) !== join(parent, name)) return { removed: false, why: `${path} does not resolve to itself` };
  rmSync(path, { recursive: true, force: true });
  return { removed: true, why: 'removed' };
}

/** Deletes every root (and git dir) of a round, by name, under the layout's roots dir. */
export function removeRoundRoots(layout: RootsLayout, roundId: number): RemoveResult[] {
  const prefix = `${storeTag(layout.dbPath)}-${roundId}-a`;
  let names: string[];
  try {
    names = readdirSync(layout.rootsDir);
  } catch {
    return [];
  }
  return names.filter((n) => n.startsWith(prefix) && ROOT_NAME.test(n)).map((n) => removeOwnedRoot(layout, join(layout.rootsDir, n)));
}
