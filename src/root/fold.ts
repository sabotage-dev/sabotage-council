import { commitExists, isAncestor, runGit, type ShadowRepo } from './git.js';

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
      /** Files whose content differs between the baseline and this head, or CHANGED_FILES_UNKNOWN. */
      changedFiles: readonly string[] | typeof CHANGED_FILES_UNKNOWN;
    };

function short(sha: string): string {
  return sha.slice(0, 7);
}

function changedFiles(shadow: ShadowRepo, baseline: string, head: string): string[] {
  const out = runGit(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', baseline, head], { gitDir: shadow.gitDir });
  return out.stdout
    .toString('utf8')
    .split('\0')
    .filter((p) => p !== '');
}

/**
 * Decides whether a round 2+ reviews only the delta from `baseline`, or falls back to a full review
 * (plan 3.6, D17). In P1 nothing beyond the local repository is tried for a missing baseline; P6 adds the exact
 * fetch. Checked in order: missing, not an ancestor (force-push or rebase), empty fold.
 */
export function detectFold(shadow: ShadowRepo, baseline: string, head: string): FoldPlan {
  if (!commitExists(shadow, baseline)) {
    return {
      kind: 'fallback',
      baseline,
      fallback: 'missing',
      reason: `the baseline head ${short(baseline)} is missing from the repository`,
      changedFiles: CHANGED_FILES_UNKNOWN,
    };
  }
  if (!isAncestor(shadow, baseline, head)) {
    return {
      kind: 'fallback',
      baseline,
      fallback: 'not-ancestor',
      reason: `the baseline head ${short(baseline)} is not an ancestor of this head (force-push or rebase)`,
      changedFiles: changedFiles(shadow, baseline, head),
    };
  }
  const empty = runGit(['diff', '--quiet', '--no-ext-diff', baseline, head], { gitDir: shadow.gitDir, okStatuses: [0, 1] });
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
