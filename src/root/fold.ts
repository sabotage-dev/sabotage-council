import { commitExists, isAncestor, runGit, type ShadowRepo } from './git.js';
import { decodeName, splitNul } from './names.js';

/** The list text when the baseline cannot be read (plan 3.6). */
export const CHANGED_FILES_UNKNOWN = 'changed files unknown (baseline unavailable)';

export type FallbackKind = 'missing' | 'not-ancestor' | 'empty-fold';

export type FoldPlan =
  | { kind: 'delta'; baseline: string }
  | {
      kind: 'fallback';
      baseline: string;
      fallback: FallbackKind;
      /** One sentence for the brief: why this round reviews the whole change. */
      reason: string;
      /**
       * Files whose content differs between the baseline and this head, or CHANGED_FILES_UNKNOWN. detectFold gives
       * them relative to the repository; buildRoot maps them, after the sanitizer, to the root-relative paths the
       * seats see (`<repo>/...`, `_repo-agent-config/<repo>/...`, `*.council-data`). The names come from the
       * reviewed tree, so the brief quotes them as data.
       */
      changedFiles: readonly string[] | typeof CHANGED_FILES_UNKNOWN;
    };

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** Read as bytes: a name that is not valid UTF-8 throws FileNameError rather than decoding with replacements. */
function changedFiles(shadow: ShadowRepo, baseline: string, head: string, paths: readonly string[]): string[] {
  const out = runGit(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', baseline, head, ...pathspec(paths)], { gitDir: shadow.gitDir });
  const where = `the diff from ${short(baseline)} to ${short(head)}`;
  return splitNul(out.stdout).map((raw) => decodeName(raw, where));
}

/**
 * Decides whether a round 2+ reviews only the delta from `baseline`, or falls back to a full review
 * (plan 3.6, D17). In P1 nothing beyond the local repository is tried for a missing baseline; P6 adds the exact
 * fetch. Checked in order: missing, not an ancestor (force-push or rebase), empty fold.
 */
export interface FoldOptions {
  /** Limit the fold (FOLD.diff, the changed files and the empty-fold check) to these repository paths. */
  paths?: readonly string[] | undefined;
  /**
   * The baseline is a snapshot of uncommitted work whose parent is an ancestor of this head: the work went on, or
   * was committed. Its tree is still the reviewed content, so the fold is a delta, not a rebase.
   */
  snapshotBaseline?: boolean | undefined;
}

/** `-- <paths>` (literal pathspecs), or nothing. */
export function pathspec(paths: readonly string[] | undefined): string[] {
  return paths === undefined || paths.length === 0 ? [] : ['--', ...paths.map((p) => `:(literal)${p}`)];
}

export function detectFold(shadow: ShadowRepo, baseline: string, head: string, options: FoldOptions = {}): FoldPlan {
  const paths = options.paths ?? [];
  if (!commitExists(shadow, baseline)) {
    return {
      kind: 'fallback',
      baseline,
      fallback: 'missing',
      reason: `the baseline head ${short(baseline)} is missing from the repository`,
      changedFiles: CHANGED_FILES_UNKNOWN,
    };
  }
  if (options.snapshotBaseline !== true && !isAncestor(shadow, baseline, head)) {
    return {
      kind: 'fallback',
      baseline,
      fallback: 'not-ancestor',
      reason: `the baseline head ${short(baseline)} is not an ancestor of this head (force-push or rebase)`,
      changedFiles: changedFiles(shadow, baseline, head, paths),
    };
  }
  const empty = runGit(['diff', '--quiet', '--no-ext-diff', baseline, head, ...pathspec(paths)], { gitDir: shadow.gitDir, okStatuses: [0, 1] });
  if (empty.status === 0) {
    return {
      kind: 'fallback',
      baseline,
      fallback: 'empty-fold',
      reason: `the fold from the baseline head ${short(baseline)} is empty: the content equals what was reviewed`,
      changedFiles: [],
    };
  }
  return { kind: 'delta', baseline };
}
