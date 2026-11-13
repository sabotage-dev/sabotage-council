import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { posix } from 'node:path';

/*
 * Root containment for ratifiers. Paths in records are judged lexically (normalized, no filesystem access), and
 * by realpath where the path exists, so a link that leaves the root is caught too.
 */

/** macOS keeps /tmp, /var and /etc under /private; records may name either spelling. */
const PRIVATE_LINKS = ['/tmp', '/var', '/etc'];

/** Every spelling of the root a record may use: as given, its realpath, and the /private twin on macOS. */
export function rootAliases(root: string): string[] {
  const out = new Set<string>();
  const add = (p: string): void => {
    const n = posix.normalize(p).replace(/\/+$/, '');
    if (n !== '') out.add(n);
  };
  add(root);
  try {
    add(realpathSync(root));
  } catch {
    // A root that no longer exists is judged by its given spelling only.
  }
  for (const p of [...out]) {
    for (const link of PRIVATE_LINKS) {
      if (p === `/private${link}` || p.startsWith(`/private${link}/`)) add(p.slice('/private'.length));
      else if (p === link || p.startsWith(`${link}/`)) add(`/private${p}`);
    }
  }
  return [...out];
}

/** True when an absolute, normalized path is the root or below it. */
export function underRoot(absPath: string, aliases: readonly string[]): boolean {
  const n = posix.normalize(absPath);
  return aliases.some((root) => n === root || n.startsWith(`${root}/`));
}

/** Resolves a path lexically against a base directory (no filesystem access). */
export function resolveLexical(path: string, base: string): string {
  return posix.normalize(path.startsWith('/') ? path : posix.join(base, path));
}

/** The realpath of a path when it exists, else null. */
export function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Judges one path from a record: inside the root lexically, and (when it exists) by realpath too. `~` spellings
 * are never inside: they name the home directory. A `$` is a shell expansion the record does not resolve, so it is
 * never inside either, except with `literalDollar`: in a tool call's own path argument (ACP) nothing expands it,
 * and `routes/$id.tsx` is a file name. The codex command check keeps the expansion rule.
 */
export function pathInsideRoot(
  path: string,
  cwd: string,
  aliases: readonly string[],
  options: { literalDollar?: boolean } = {},
): { inside: boolean; resolved: string; why: string } {
  if (path.startsWith('~')) return { inside: false, resolved: path, why: 'names the home directory' };
  if (options.literalDollar !== true && path.includes('$')) return { inside: false, resolved: path, why: 'holds a shell expansion' };
  const resolved = resolveLexical(path, cwd);
  if (!underRoot(resolved, aliases)) return { inside: false, resolved, why: 'resolves outside the root' };
  const real = realpathOrNull(resolved) ?? danglingLinkTarget(resolved);
  if (real !== null && !underRoot(real, aliases)) return { inside: false, resolved: real, why: 'its realpath leaves the root' };
  return { inside: true, resolved, why: 'inside the root' };
}

/** Where a link that does not resolve (its target is missing) points, judged lexically. */
function danglingLinkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolveLexical(readlinkSync(path), posix.dirname(path));
  } catch {
    return null;
  }
}
