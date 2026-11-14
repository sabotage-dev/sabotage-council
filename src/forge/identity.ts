import { latestStanding } from './count.js';
import { ForgeError, restPath, type GitHubApi } from './github.js';
import { normalizeReview, sameLogin, type PrRef, type PrSnapshot, type Review } from './pr.js';

/*
 * Identity approval (plan 3.10): a PR whose base is the default branch, and whose head tree is byte-identical to a
 * commit `github.login` approved on another PR of the same repository, is approved by identity with no seats. The
 * candidates are the PRs GitHub's search lists as reviewed by the login (newest first, at most 30); a candidate counts
 * only while its approval still stands, that is while it is the login's newest standing review on that PR (an
 * approval later replaced by a change request, or dismissed, no longer stands), and its commit's tree equals this
 * head's. Before anything posts, those facts and the base being the default branch are re-read live (P6 round 1
 * row 1: a PR retargeted after its round started never takes the identity approval).
 */

export interface IdentityMatch {
  /** The other PR. */
  number: number;
  reviewId: number;
  /** The approved commit, whose tree equals this head's. */
  commitId: string;
  tree: string;
}

export const IDENTITY_SEARCH_LIMIT = 30;

type Obj = Record<string, unknown>;

/** The tree of a commit, by the API (the commit may be in no local mirror). */
export function apiTreeOf(api: GitHubApi, ref: Pick<PrRef, 'owner' | 'repo'>, sha: string): string {
  const c = api.get(`${restPath('repos', ref.owner, ref.repo, 'git', 'commits', sha)}`) as Obj;
  const tree = (c['tree'] as Obj | undefined)?.['sha'];
  if (typeof tree !== 'string' || !/^[0-9a-f]{40}$/.test(tree)) throw new ForgeError(`commit ${sha.slice(0, 7)} has no tree in the API's answer`);
  return tree;
}

/**
 * The newest standing approval by `login` on another PR of the repository whose commit's tree equals `headTree`, or
 * null with why. A read that fails throws: the round then takes the council path, never a guessed identity.
 */
export function findIdentity(api: GitHubApi, pr: Pick<PrSnapshot, 'ref' | 'baseRef' | 'defaultBranch'>, login: string, headTree: string): { match: IdentityMatch | null; why: string } {
  if (pr.baseRef !== pr.defaultBranch) return { match: null, why: `the base ${pr.baseRef} is not the default branch ${pr.defaultBranch}` };
  const { ref } = pr;
  const q = new URLSearchParams({ q: `repo:${ref.owner}/${ref.repo} is:pr reviewed-by:${login}`, sort: 'updated', order: 'desc', per_page: String(IDENTITY_SEARCH_LIMIT) });
  const found = api.get(`search/issues?${q.toString()}`) as Obj;
  const items = Array.isArray(found['items']) ? (found['items'] as Obj[]) : [];
  for (const item of items) {
    const num = item['number'];
    if (typeof num !== 'number' || num === ref.number) continue;
    const a = standingReviewOf(api, ref, num, login);
    if (a?.state !== 'APPROVED') continue;
    const tree = apiTreeOf(api, ref, a.commitId);
    if (tree === headTree) return { match: { number: num, reviewId: a.id, commitId: a.commitId, tree }, why: `the head tree equals ${a.commitId.slice(0, 7)}, approved on #${num}` };
  }
  return { match: null, why: `no standing approval by ${login} on another PR of this repository has this head's tree` };
}

/** The login's standing review on a PR of the repository: its newest APPROVED, CHANGES_REQUESTED or DISMISSED one. */
function standingReviewOf(api: GitHubApi, ref: Pick<PrRef, 'owner' | 'repo'>, num: number, login: string): Review | null {
  const reviews = api.list(`${restPath('repos', ref.owner, ref.repo, 'pulls', num)}/reviews`).map(normalizeReview);
  return latestStanding(reviews.filter((r) => sameLogin(r.login, login)));
}

/**
 * The live re-check before posting (plan 3.10): the live PR's base is still the default branch, the matched approval
 * is still the login's standing review on the other PR, and the trees still match.
 */
export function recheckIdentity(
  api: GitHubApi,
  pr: Pick<PrSnapshot, 'ref' | 'baseRef' | 'defaultBranch'>,
  login: string,
  match: IdentityMatch,
  headTree: string,
): { ok: boolean; why: string } {
  const { ref } = pr;
  if (pr.baseRef !== pr.defaultBranch) return { ok: false, why: `the base is now ${pr.baseRef}, not the default branch ${pr.defaultBranch}` };
  const standing = standingReviewOf(api, ref, match.number, login);
  if (standing === null) return { ok: false, why: `${login} has no standing review on #${match.number}` };
  if (standing.id !== match.reviewId) return { ok: false, why: `the standing review by ${login} on #${match.number} is now review ${standing.id} (${standing.state}), not approval ${match.reviewId}` };
  if (standing.state !== 'APPROVED') return { ok: false, why: `the approval on #${match.number} is now ${standing.state}` };
  const tree = apiTreeOf(api, ref, match.commitId);
  if (tree !== headTree) return { ok: false, why: `the approved commit's tree no longer equals this head's` };
  return { ok: true, why: `approval ${match.reviewId} on #${match.number} stands, and the trees match` };
}
