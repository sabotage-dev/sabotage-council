import { readlinkSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, sep } from 'node:path';
import { lstatOrNull, walk } from './walk.js';

export type LinkProblem = 'absolute' | 'outside' | 'dangling';

export interface NeutralizedLink {
  /** Root-relative path of the link, now a text file. */
  path: string;
  target: string;
  reason: LinkProblem;
}

/** Control characters in a link target are escaped, so the replacement stays one line. */
function printable(target: string): string {
  return target.replace(/[\0-\x1f\x7f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** The text that replaces a neutralized link (plan 5.3). */
export function symlinkText(target: string): string {
  return `SYMLINK -> ${printable(target)} (not followed)\n`;
}

function inside(realRoot: string, path: string): boolean {
  return path === realRoot || path.startsWith(realRoot + sep);
}

/**
 * Why a link must not be kept, or null when it may stay. A link stays only when its target is relative, never
 * climbs above the root on the way (so it still points inside the root when the root is copied elsewhere), and
 * resolves by realpath, through any chain of links, to an existing path inside the root.
 */
export function linkProblem(root: string, realRoot: string, rel: string, target: string): LinkProblem | null {
  if (isAbsolute(target)) return 'absolute';
  let depth = rel.split('/').length - 1;
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    depth += seg === '..' ? -1 : 1;
    if (depth < 0) return 'outside';
  }
  let real: string;
  try {
    real = realpathSync(join(root, rel));
  } catch {
    return 'dangling';
  }
  return inside(realRoot, real) ? null : 'outside';
}

/**
 * Symlink neutralization (plan 5.3), run right after extraction over `<repo>/`, `_base/` and `context/`, before
 * anything reads the tree. Every link that is absolute, dangling, or resolves outside the root is replaced by a
 * text file `SYMLINK -> <target> (not followed)`. Links that stay inside the root are kept. All links are judged
 * first and replaced after, so the outcome does not depend on the order links are visited in a chain.
 */
export function neutralizeSymlinks(root: string, dirs: readonly string[]): NeutralizedLink[] {
  const realRoot = realpathSync(root);
  const links: { rel: string; target: string }[] = [];
  for (const dir of dirs) {
    const stats = lstatOrNull(join(root, dir));
    if (stats === null) continue;
    if (stats.isSymbolicLink()) links.push({ rel: dir, target: readlinkSync(join(root, dir)) });
    if (!stats.isDirectory()) continue;
    for (const entry of walk(root, dir)) {
      if (entry.kind === 'symlink') links.push({ rel: entry.rel, target: readlinkSync(entry.abs) });
    }
  }
  const out: NeutralizedLink[] = [];
  for (const link of links) {
    const reason = linkProblem(root, realRoot, link.rel, link.target);
    if (reason !== null) out.push({ path: link.rel, target: link.target, reason });
  }
  for (const link of out) {
    const abs = join(root, link.path);
    unlinkSync(abs);
    writeFileSync(abs, symlinkText(link.target), { flag: 'wx' });
  }
  return out;
}

/** Root-relative links that escape the root (absolute or outside), for the integrity check after sanitizing. */
export function escapingLinks(root: string): { path: string; target: string; reason: LinkProblem }[] {
  const realRoot = realpathSync(root);
  const out: { path: string; target: string; reason: LinkProblem }[] = [];
  for (const entry of walk(root)) {
    if (entry.kind !== 'symlink') continue;
    const target = readlinkSync(entry.abs);
    const reason = linkProblem(root, realRoot, entry.rel, target);
    if (reason === 'absolute' || reason === 'outside') out.push({ path: entry.rel, target, reason });
  }
  return out;
}
