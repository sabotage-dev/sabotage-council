import { onList } from '../engine/post.js';
import { ForgeError, restPath, type GitHubApi } from '../forge/github.js';
import { namesPr, parseMarker } from '../forge/markers.js';
import { normalizeReview, readPull, repoKeyOf, sameLogin, type PrRef, type Review } from '../forge/pr.js';

/*
 * The auto daemon's queue (plan 9.4): the open pull requests where the user is requested as a reviewer, found through
 * GitHub's search, plus the ones still in scope by continuation, filtered by the allow and skip lists before anything
 * else about a PR is read.
 *
 * The search (Q10, Q11):
 *   is:pr is:open draft:false review-requested:@me      team requests included (`auto.include_team_requests`, default)
 *   is:pr is:open draft:false user-review-requested:@me  direct requests only (include_team_requests = false)
 *   is:pr is:open draft:false assignee:@me               when `auto.include_assigned` (Q10, off by default)
 * each narrowed to the owners `auto.repos_allow` names (`user:<owner>`, one search per owner), so a repository outside
 * the allow list is not even listed whenever every pattern names its owner. Whatever the search returns, a result
 * outside `repos_allow` (or on `repos_skip`) is dropped before any read of it: the daemon never reads, queues or
 * records a pull request outside the allow list, and the pass reports only how many it dropped.
 */

export interface QueueConfig {
  login: string;
  repos_allow: readonly string[];
  repos_skip: readonly string[];
  include_assigned: boolean;
  include_team_requests: boolean;
}

/** In scope by the lists: on `repos_allow` and not on `repos_skip`. An empty allow list allows nothing. */
export function inScope(cfg: Pick<QueueConfig, 'repos_allow' | 'repos_skip'>, fullName: string): boolean {
  return onList(cfg.repos_allow, fullName) && !onList(cfg.repos_skip, fullName);
}

/**
 * The owners the search is narrowed to, one search each, or null when some pattern's owner has a wildcard (then the
 * search is not narrowed and the client-side filter alone keeps the allow list).
 */
export function narrowOwners(allow: readonly string[]): string[] | null {
  const owners = new Set<string>();
  for (const p of allow) {
    const owner = p.split('/')[0] ?? '';
    if (owner === '' || owner.includes('*')) return null;
    owners.add(owner.toLowerCase());
  }
  return [...owners].sort();
}

export type QueueSource = 'requested' | 'assigned' | 'continuation';

/** The searches one pass runs, with the source each one's results count as. */
export function searchQueries(cfg: QueueConfig): Array<{ q: string; source: QueueSource }> {
  if (cfg.repos_allow.length === 0) return [];
  const owners = narrowOwners(cfg.repos_allow);
  const scopes = owners === null ? [''] : owners.map((o) => ` user:${o}`);
  const base = 'is:pr is:open draft:false';
  const requested = cfg.include_team_requests ? 'review-requested:@me' : 'user-review-requested:@me';
  const out: Array<{ q: string; source: QueueSource }> = [];
  for (const s of scopes) out.push({ q: `${base} ${requested}${s}`, source: 'requested' });
  if (cfg.include_assigned) for (const s of scopes) out.push({ q: `${base} assignee:@me${s}`, source: 'assigned' });
  return out;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export interface SearchHit {
  ref: PrRef;
  fullName: string;
  draft: boolean;
  author: string;
  source: QueueSource;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Results outside `repos_allow` or on `repos_skip`: dropped unread. Only the count is kept. */
  dropped: number;
  queries: string[];
}

function hitOf(item: unknown, source: QueueSource): SearchHit | null {
  if (item === null || typeof item !== 'object') return null;
  const o = item as Record<string, unknown>;
  if (o['pull_request'] === undefined || o['pull_request'] === null) return null;
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/.exec(typeof o['repository_url'] === 'string' ? o['repository_url'] : '');
  const number = o['number'];
  if (!m?.[1] || !m[2] || !NAME.test(m[1]) || !NAME.test(m[2]) || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null;
  const user = o['user'] as { login?: unknown } | null | undefined;
  return {
    ref: { owner: m[1], repo: m[2], number },
    fullName: `${m[1]}/${m[2]}`,
    draft: o['draft'] === true,
    author: typeof user?.login === 'string' ? user.login : 'ghost',
    source,
  };
}

/**
 * Runs the pass's searches and keeps the in-scope results, one per PR (a PR both requested and assigned is
 * `requested`). A failed search fails the pass's queue (fail closed: a partial queue is not reported as the queue).
 */
export function searchQueue(api: GitHubApi, cfg: QueueConfig): SearchResult {
  const seen = new Map<string, SearchHit>();
  let dropped = 0;
  const queries = searchQueries(cfg);
  for (const { q, source } of queries) {
    const pages = api.list(`search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc`, 'items');
    for (const item of pages) {
      const hit = hitOf(item, source);
      if (hit === null) continue;
      if (!inScope(cfg, hit.fullName)) {
        dropped++;
        continue;
      }
      const k = `${hit.fullName.toLowerCase()}#${hit.ref.number}`;
      if (!seen.has(k)) seen.set(k, hit);
    }
  }
  return { hits: [...seen.values()], dropped, queries: queries.map((x) => x.q) };
}

/** Our own marker review (plan 3.6, 3.10) of this PR by `github.login`, submitted. */
export function ourMarkerReview(r: Review, login: string, ref: PrRef): boolean {
  if (r.state === 'PENDING' || !sameLogin(r.login, login)) return false;
  const m = parseMarker(r.body);
  return m !== null && (m.kind === 'round' || m.kind === 'identity') && namesPr(m.target, ref);
}

/** The states of our latest review that keep a PR in scope after its review request cleared (plan 9.4). */
export const CONTINUING = new Set(['CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']);

/** Our latest marker review of the PR (by time, then id), or null. */
export function latestOurs(reviews: readonly Review[], login: string, ref: PrRef): Review | null {
  const ours = reviews.filter((r) => ourMarkerReview(r, login, ref)).sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : a.id - b.id));
  return ours.at(-1) ?? null;
}

/** Whether we already reviewed this head: a marker review of ours bound to it. */
export function reviewedAt(reviews: readonly Review[], login: string, ref: PrRef, head: string): Review | null {
  return reviews.find((r) => ourMarkerReview(r, login, ref) && r.commitId.toLowerCase() === head.toLowerCase()) ?? null;
}

export function readReviews(api: GitHubApi, ref: PrRef): Review[] {
  return api.list(`${restPath('repos', ref.owner, ref.repo, 'pulls', ref.number)}/reviews`).map(normalizeReview);
}

/** A PR the pass will look at: what one read of the pull request says. */
export interface Candidate {
  ref: PrRef;
  repoKey: string;
  fullName: string;
  source: QueueSource;
  head: string;
  state: 'open' | 'closed';
  draft: boolean;
  author: string;
}

export function candidateOf(api: GitHubApi, ref: PrRef, source: QueueSource): Candidate {
  const pull = readPull(api, ref);
  if (pull.baseRepo.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase()) {
    throw new ForgeError(`${ref.owner}/${ref.repo}#${ref.number} belongs to ${pull.baseRepo} (a renamed or transferred repository)`);
  }
  return { ref, repoKey: repoKeyOf(ref), fullName: `${ref.owner}/${ref.repo}`, source, head: pull.headSha, state: pull.state, draft: pull.draft, author: pull.author };
}

/** `owner/name` and the number of a ledger or store key (`github.com/<owner>/<repo>`). */
export function refOfKey(repo: string, num: number): PrRef | null {
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(repo);
  if (!m?.[1] || !m[2] || !NAME.test(m[1]) || !NAME.test(m[2])) return null;
  return { owner: m[1], repo: m[2], number: num };
}
