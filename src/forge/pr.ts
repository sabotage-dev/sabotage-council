import { ForgeError, restPath, type GitHubApi } from './github.js';

/*
 * What `pr` mode reads of a pull request (plan 9.3, P6 scope 1): head and base, author and state, every review with
 * its `commit_id`, the inline comments (a change request's asks), the conversation (PR.md), the commits, and the
 * author's permission (plan 6.3: who counts as trusted). Every read is required: one that fails stops the round
 * (plan 3.6, fail closed). Only the fields below are kept; the rest of GitHub's JSON is dropped at the edge.
 */

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** `owner/repo#num`, or `https://github.com/owner/repo/pull/num` (a trailing path or query is ignored). */
export function parsePrRef(text: string): PrRef {
  const t = text.trim();
  let m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]{0,9})$/.exec(t);
  if (!m) m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,9})(?:[/?#].*)?$/.exec(t);
  const [, owner, repo, num] = m ?? [];
  if (owner === undefined || repo === undefined || num === undefined || !NAME.test(owner) || !NAME.test(repo) || [owner, repo].some((s) => s === '.' || s === '..')) {
    throw new ForgeError(`a pr target is owner/repo#num or https://github.com/owner/repo/pull/num, got "${text}"`);
  }
  return { owner, repo, number: Number(num) };
}

export const prLabel = (ref: PrRef): string => `${ref.owner}/${ref.repo}#${ref.number}`;

/**
 * The run store's repo key for a GitHub repository (the `host/owner/name` form of a git remote, P5), lower case:
 * GitHub resolves owner and repository names case-insensitively, so `Org/Repo#5` and `org/repo#5` are one pull
 * request, with one target, one set of credits and one set of our own reviews (P6 round 1, migration 003).
 */
export const repoKeyOf = (ref: Pick<PrRef, 'owner' | 'repo'>): string => `github.com/${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}`;

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface Review {
  id: number;
  login: string;
  state: ReviewState | string;
  /** The head the review was submitted on (plan 3.6 step 3: the reviewed head is this, never text). */
  commitId: string;
  /** ISO time; empty for a PENDING review. */
  submittedAt: string;
  body: string;
}

export interface ReviewComment {
  id: number;
  /** The review the comment belongs to; null for a comment GitHub does not tie to one. */
  reviewId: number | null;
  login: string;
  path: string;
  line: number | null;
  body: string;
}

/** A changed file as GitHub lists it: a rename also names the path it came from. */
export interface PrFile {
  path: string;
  previous: string | null;
}

/** GitHub lists at most this many changed files for a PR; a longer change cannot be cross-checked. */
export const PR_FILES_MAX = 3000;

export interface IssueComment {
  id: number;
  login: string;
  createdAt: string;
  body: string;
}

export interface PrSnapshot {
  ref: PrRef;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  author: string;
  headSha: string;
  headRef: string;
  /** `owner/name` of the head repository; null when it was deleted. */
  headRepo: string | null;
  baseSha: string;
  baseRef: string;
  /** The base repository's default branch (plan 3.10: identity approval needs the base to be it). */
  defaultBranch: string;
  /** `owner/name` of the base repository, as GitHub spells it. */
  baseRepo: string;
  reviews: Review[];
  reviewComments: ReviewComment[];
  issueComments: IssueComment[];
  commits: string[];
  /** The changed files GitHub lists (P6 cross-checks them against the fetched base and head). */
  files: PrFile[];
  requestedReviewers: string[];
  assignees: string[];
  /** The author's permission on the base repository; null when GitHub would not say (counted as untrusted). */
  authorPermission: string | null;
}

const FULL_SHA = /^[0-9a-f]{40}$/;

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ForgeError(`${what} is not an object`);
  return v as Obj;
}

function str(o: Obj, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string') throw new ForgeError(`${what}.${key} is not a string`);
  return v;
}

function optStr(o: Obj, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}

function int(o: Obj, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw new ForgeError(`${what}.${key} is not an integer`);
  return v;
}

function sha(o: Obj, key: string, what: string): string {
  const v = str(o, key, what);
  if (!FULL_SHA.test(v)) throw new ForgeError(`${what}.${key} is not a full sha`);
  return v;
}

/** A user object's login; a deleted account shows as `ghost`, as on GitHub. */
function loginOf(v: unknown): string {
  if (v === null || typeof v !== 'object') return 'ghost';
  const login = (v as Obj)['login'];
  return typeof login === 'string' && login !== '' ? login : 'ghost';
}

export function normalizeReview(v: unknown): Review {
  const o = obj(v, 'a review');
  const state = str(o, 'state', 'review');
  return {
    id: int(o, 'id', 'review'),
    login: loginOf(o['user']),
    state,
    commitId: state === 'PENDING' ? optStr(o, 'commit_id') : sha(o, 'commit_id', 'review'),
    submittedAt: optStr(o, 'submitted_at'),
    body: optStr(o, 'body'),
  };
}

export function normalizeReviewComment(v: unknown): ReviewComment {
  const o = obj(v, 'a review comment');
  const rid = o['pull_request_review_id'];
  const line = o['line'] ?? o['original_line'];
  return {
    id: int(o, 'id', 'review comment'),
    reviewId: typeof rid === 'number' ? rid : null,
    login: loginOf(o['user']),
    path: optStr(o, 'path'),
    line: typeof line === 'number' && line >= 1 ? line : null,
    body: optStr(o, 'body'),
  };
}

function normalizeIssueComment(v: unknown): IssueComment {
  const o = obj(v, 'a comment');
  return { id: int(o, 'id', 'comment'), login: loginOf(o['user']), createdAt: optStr(o, 'created_at'), body: optStr(o, 'body') };
}

/** The pull request object's fields `pr` mode uses. */
export function normalizePull(ref: PrRef, v: unknown): Omit<PrSnapshot, 'reviews' | 'reviewComments' | 'issueComments' | 'commits' | 'files' | 'authorPermission'> {
  const o = obj(v, 'the pull request');
  if (int(o, 'number', 'pull request') !== ref.number) throw new ForgeError(`GitHub returned pull request ${String(o['number'])}, not ${ref.number}`);
  const head = obj(o['head'], 'pull request head');
  const base = obj(o['base'], 'pull request base');
  const baseRepo = obj(base['repo'], 'pull request base repo');
  const headRepo = head['repo'] === null || head['repo'] === undefined ? null : obj(head['repo'], 'pull request head repo');
  const state = str(o, 'state', 'pull request');
  if (state !== 'open' && state !== 'closed') throw new ForgeError(`pull request state "${state}" is unknown`);
  const logins = (k: string): string[] => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(loginOf) : []);
  return {
    ref,
    title: optStr(o, 'title'),
    body: optStr(o, 'body'),
    state,
    merged: o['merged'] === true,
    draft: o['draft'] === true,
    author: loginOf(o['user']),
    headSha: sha(head, 'sha', 'head'),
    headRef: optStr(head, 'ref'),
    headRepo: headRepo === null ? null : optStr(headRepo, 'full_name'),
    baseSha: sha(base, 'sha', 'base'),
    baseRef: str(base, 'ref', 'base'),
    defaultBranch: str(baseRepo, 'default_branch', 'base repo'),
    baseRepo: str(baseRepo, 'full_name', 'base repo'),
    requestedReviewers: logins('requested_reviewers'),
    assignees: logins('assignees'),
  };
}

/** Reads one pull request with everything `pr` mode needs. Any failed or partial read throws (fail closed). */
export function readPr(api: GitHubApi, ref: PrRef): PrSnapshot {
  const base = restPath('repos', ref.owner, ref.repo);
  const pulls = `${base}/${restPath('pulls', ref.number)}`;
  const pull = normalizePull(ref, api.get(pulls));
  const canonical = pull.baseRepo.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase();
  if (!canonical) throw new ForgeError(`${prLabel(ref)} belongs to ${pull.baseRepo} (a renamed or transferred repository): use that name`);
  const reviews = api.list(`${pulls}/reviews`).map(normalizeReview);
  const reviewComments = api.list(`${pulls}/comments`).map(normalizeReviewComment);
  const issueComments = api.list(`${base}/${restPath('issues', ref.number)}/comments`).map(normalizeIssueComment);
  const commits = api.list(`${pulls}/commits`).map((c) => sha(obj(c, 'a commit'), 'sha', 'commit'));
  const files = api.list(`${pulls}/files`).map((f): PrFile => {
    const o = obj(f, 'a changed file');
    const previous = o['previous_filename'];
    return { path: str(o, 'filename', 'changed file'), previous: typeof previous === 'string' ? previous : null };
  });
  let authorPermission: string | null = null;
  try {
    const p = obj(api.get(`${base}/${restPath('collaborators', pull.author)}/permission`), 'permission');
    authorPermission = typeof p['permission'] === 'string' ? p['permission'] : null;
  } catch {
    // GitHub answers this only for some callers and some users (a non-collaborator gives 404): unknown is untrusted.
    authorPermission = null;
  }
  return { ...pull, reviews, reviewComments, issueComments, commits, files, authorPermission };
}

/** Write access (plan 5.2, 6.3): admin, maintain or write. Anything else, or unknown, is untrusted. */
export function authorTrusted(pr: Pick<PrSnapshot, 'authorPermission'>): boolean {
  return pr.authorPermission === 'admin' || pr.authorPermission === 'maintain' || pr.authorPermission === 'write';
}

export const sameLogin = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
