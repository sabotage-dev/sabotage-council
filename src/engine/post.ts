import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Adjudication } from '../adjudicate/schema.js';
import type { CouncilConfig } from '../config/schema.js';
import { readCi, type CiState } from '../forge/ci.js';
import { countsAsCouncil, standingChangeRequests, userChangeRequest, type MarkerConfig } from '../forge/count.js';
import { decideEvent, type EventDecision, type EventFacts, type ReviewEvent } from '../forge/events.js';
import { ForgeError, restPath, type GitHubApi } from '../forge/github.js';
import { apiTreeOf, recheckIdentity, type IdentityMatch } from '../forge/identity.js';
import { firstLine, namesPr, parseMarker } from '../forge/markers.js';
import { loginMismatch, normalizeReview, readPr, readPull, repoKeyOf, sameLogin, type PrRef, type PrSnapshot, type Review } from '../forge/pr.js';
import { renderBody, validateBody, type BodyLeg } from '../forge/render.js';
import type { Store } from '../store/open.js';
import type { DatabaseSync } from '../store/sqlite.js';
import { preparedDetail } from './facts.js';
import { autoOf, markerConfig, participantsOf } from './pr.js';
import { roundDirOf, type DataLayout } from './prepare.js';
import { getEvents, getLegs, getRound, insertEvent, now, sha256, type RoundRow } from './records.js';

/*
 * `sabotage-council post <round> --dry-run | --post` (plan 7.1 step 5, 3.7, 3.10): the post step after adjudication.
 * It re-reads the PR live, maps the round to its event (3.7's table), renders and validates the body, and then either
 * prints it (`--dry-run`, nothing is written to GitHub) or posts exactly one review on the reviewed head.
 *
 * P6 round 1 made the post safe against a second process, a crash and a failed call:
 * - `--post` claims the round in the store (one IMMEDIATE transaction) before any network call; a second `post` on
 *   a claimed round is refused, and a claim whose process is gone can be taken over (row 9);
 * - the guards a post owes (the approval race, our stale change request's dismissal, the withdrawal of a review bound
 *   to another commit) are recorded as pending with the post's intent, before the POST, and each is marked done once
 *   it ran; the next `post` (already posted, or adopting a review that landed) resumes the pending ones, and a guard
 *   that is still pending makes `post` exit non-zero (row 2);
 * - an interrupted post adopts only a review whose body and event are the ones it meant to post and that no other
 *   round has stored, and refuses when more than one matches (row 4);
 * - the head is read again right before the POST (row 5), and the approval race withdraws our approval for any
 *   review that landed meanwhile unless it is a counted council review (row 3).
 *
 * P6 round 2: an interrupted post is reconciled before a moved head or a closed PR ends the call, and a review GitHub
 * bound to another commit is adopted too, with its withdrawal recorded in the same transaction as the posted state
 * (row 1).
 */

export interface PostOptions {
  config: CouncilConfig;
  layout: DataLayout;
  api: GitHubApi;
  roundId: number;
  mode: 'dry-run' | 'post';
  /**
   * `--expect <sha256>` (row 8): the body hash of the dry run the user approved. `--post` then sends only that body,
   * with the event that dry run showed. Without it, `--post` sends only what the round's latest dry run showed.
   */
  expect?: string | undefined;
  /**
   * Tests only: stand-ins for another process or a crash at a fixed point of a post. `afterClaim` runs once the
   * claim is taken (a second `post` at that moment); `afterPost` runs once the POST returned and before the store
   * records it (a crash there, when it throws).
   */
  hooks?: { afterClaim?: (() => void) | undefined; afterPost?: (() => void) | undefined } | undefined;
}

export type PostOutcome = 'rendered' | 'posted' | 'superseded' | 'refused' | 'already-posted';

export type GuardKind = 'approval-race' | 'dismiss-stale' | 'withdraw-off-head';

/** One guard a post owes: pending until it ran (a failed call leaves it pending), done once it did; in a dry run, would-run. */
export interface GuardReport {
  kind: GuardKind;
  /** The review it dismisses (our stale change request, or our review bound to another commit); null for the approval race. */
  reviewId: number | null;
  status: 'pending' | 'done' | 'would-run';
  /** What it did, why it was not needed, or why its last attempt failed. */
  outcome: string;
  attempts: number;
}

export interface PostResult {
  roundId: number;
  mode: 'dry-run' | 'post';
  outcome: PostOutcome;
  event: ReviewEvent | null;
  row: number | null;
  /** The head the review is (or would be) bound to: the reviewed head. */
  commitId: string;
  body: string | null;
  bodySha256: string | null;
  /** Why it was refused or superseded, or what the body validation found. */
  problems: string[];
  reviewId: number | null;
  /** The round's guards after this call (plan 3.7, row 2). */
  guards: GuardReport[];
  ci: CiState | null;
  /** The command that comes next, when there is one: a rendered dry run names the `--post --expect` that sends it. */
  next: string | null;
}

/** `owner/name` against `auto.repos_hold` patterns (`*` matches any run of characters), case-insensitively. */
export function onList(patterns: readonly string[], fullName: string): boolean {
  return patterns.some((p) => new RegExp(`^${p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(fullName));
}

const EVENT_OF_STATE: Record<string, ReviewEvent> = { APPROVED: 'APPROVE', CHANGES_REQUESTED: 'REQUEST_CHANGES', COMMENTED: 'COMMENT' };

function refOf(store: Store, round: RoundRow): PrRef {
  const t = store.db.prepare('SELECT kind, repo, number FROM targets WHERE id = ?').get(round.target_id) as { kind: string; repo: string; number: number | null } | undefined;
  const m = /^github\.com\/([^/]+)\/([^/]+)$/.exec(t?.repo ?? '');
  if (t?.kind !== 'pr' || !m?.[1] || !m[2] || t.number === null) throw new ForgeError(`round ${round.id} is not a pr round`);
  return { owner: m[1], repo: m[2], number: t.number };
}

function adjudicationOf(store: Store, roundId: number): { doc: Adjudication; legsClear: boolean; quorum: string } {
  const e = getEvents(store.db, roundId).find((x) => x.kind === 'adjudicated');
  const d = e?.detail as { document?: Adjudication; legs_clear?: boolean; quorum?: string } | undefined;
  if (!d?.document) throw new ForgeError(`round ${roundId} has no stored adjudication`);
  return { doc: d.document, legsClear: d.legs_clear === true, quorum: d.quorum ?? 'solo' };
}

function bodyLegs(store: Store, roundId: number): BodyLeg[] {
  return getLegs(store.db, roundId).map((l) => ({
    seat: l.seat_id,
    role: l.role,
    attempt: l.attempt,
    backend: l.backend,
    model: l.model,
    effort: l.effort,
    status: l.status,
    failureClass: l.failure_class,
    counted: l.status === 'PASS',
    verdictRaw: l.verdict_raw,
    verdictEffective: l.verdict_effective,
  }));
}

/** Our own marker reviews that requested changes on this PR and still stand: the only reviews `post` may dismiss. */
export function staleChangeRequests(reviews: readonly Review[], login: string, ref: PrRef): Review[] {
  return reviews.filter((r) => {
    if (!sameLogin(r.login, login) || r.state !== 'CHANGES_REQUESTED') return false;
    const m = parseMarker(r.body);
    return m?.kind === 'round' && namesPr(m.target, ref);
  });
}

function base(roundId: number, mode: PostOptions['mode'], commitId: string): PostResult {
  return { roundId, mode, outcome: 'refused', event: null, row: null, commitId, body: null, bodySha256: null, problems: [], reviewId: null, guards: [], ci: null, next: null };
}

/* ---------- the claim (row 9) ---------- */

/** A claim older than this is taken over even when its pid looks alive (a reused pid). A post takes minutes at most. */
export const CLAIM_STALE_MS = 60 * 60 * 1000;

interface ClaimOwner {
  host: string;
  pid: number;
  token: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a stored claim still holds: its process runs (same host), or it is another host's within the hour. */
function claimLive(ownerJson: string, claimedAt: string | null): boolean {
  let owner: Partial<ClaimOwner>;
  try {
    owner = JSON.parse(ownerJson) as Partial<ClaimOwner>;
  } catch {
    return false;
  }
  const age = claimedAt === null ? Number.NaN : Date.now() - Date.parse(claimedAt);
  if (!(age < CLAIM_STALE_MS)) return false;
  if (owner.host === hostname() && typeof owner.pid === 'number') return pidAlive(owner.pid);
  return true;
}

/** Claims a round for posting, atomically; the owner token, or why another post holds it. */
/** Runs `fn` inside one IMMEDIATE transaction: committed when it returns, rolled back when it throws. */
function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let value: T;
  try {
    value = fn();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('COMMIT');
  return value;
}

/** Claims a round for posting, atomically; the owner token, or why another post holds it. */
export function claimPost(db: DatabaseSync, roundId: number): { owner: string } | { why: string } {
  return immediate(db, () => {
    const r = db.prepare('SELECT post_owner, post_claimed_at FROM rounds WHERE id = ?').get(roundId) as { post_owner: string | null; post_claimed_at: string | null } | undefined;
    if (r === undefined) throw new ForgeError(`no round ${roundId} in the store`);
    if (r.post_owner !== null && claimLive(r.post_owner, r.post_claimed_at)) {
      const pid = String((JSON.parse(r.post_owner) as Partial<ClaimOwner>).pid ?? '?');
      return { why: `another post of round ${roundId} holds it (pid ${pid}, since ${String(r.post_claimed_at)}): nothing posts; run post again once it ends` };
    }
    const owner = JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() } satisfies ClaimOwner);
    db.prepare('UPDATE rounds SET post_owner = ?, post_claimed_at = ? WHERE id = ?').run(owner, now(), roundId);
    if (r.post_owner !== null) insertEvent(db, 'post-claim-taken-over', roundId, { previous_claimed_at: r.post_claimed_at });
    return { owner };
  });
}

function releaseClaim(db: DatabaseSync, roundId: number, owner: string): void {
  db.prepare('UPDATE rounds SET post_owner = NULL, post_claimed_at = NULL WHERE id = ? AND post_owner = ?').run(roundId, owner);
}

/* ---------- the intent and the guards (rows 2, 4) ---------- */

/** What a post recorded before its POST (plan 9.4): the event, the exact body, and the reviews it had seen. */
interface Intent {
  event?: ReviewEvent;
  row?: number;
  commit_id?: string;
  body_sha256?: string;
  body?: string;
  /** Submitted review ids on the pre-post read: a review outside it landed meanwhile (the approval race). */
  reviews_seen?: number[];
}

function latestIntent(db: DatabaseSync, roundId: number): Intent | undefined {
  return getEvents(db, roundId)
    .filter((e) => e.kind === 'posting')
    .at(-1)?.detail as Intent | undefined;
}

/** A body as GitHub may hand it back: line endings unified, trailing whitespace dropped. */
const normalizedBody = (body: string): string => body.replace(/\r\n?/g, '\n').trimEnd();

function bodyMatches(landed: string, intent: Intent): boolean {
  if (typeof intent.body === 'string') return normalizedBody(landed) === normalizedBody(intent.body);
  return sha256(landed) === intent.body_sha256 || sha256(`${normalizedBody(landed)}\n`) === intent.body_sha256;
}

/**
 * The reviews an interrupted post may adopt (plan 9.4, row 4): ours (github.login), submitted, first line this
 * round's marker, with the body and the event the post meant to send (a dismissed review's event is unknown, so only
 * its body is matched), and stored on no other round of this store. Wherever GitHub bound it: one bound to another
 * commit than the reviewed head is ours too, and is adopted with its withdrawal owed (P6 round 2 row 1).
 */
function adoptable(db: DatabaseSync, round: RoundRow, pr: PrSnapshot, login: string, intent: Intent): Review[] {
  const storedElsewhere = db.prepare('SELECT 1 FROM rounds WHERE review_id = ? AND id <> ?');
  return pr.reviews.filter(
    (r) =>
      r.state !== 'PENDING' &&
      sameLogin(r.login, login) &&
      firstLine(r.body) === round.marker &&
      (intent.event === undefined || r.state === 'DISMISSED' || EVENT_OF_STATE[r.state] === intent.event) &&
      bodyMatches(r.body, intent) &&
      storedElsewhere.get(r.id, round.id) === undefined,
  );
}

interface GuardRow {
  id: number;
  kind: GuardKind;
  review_id: number | null;
  status: 'pending' | 'done';
  attempts: number;
  outcome: string | null;
}

function guardRows(db: DatabaseSync, roundId: number): GuardRow[] {
  return db.prepare('SELECT id, kind, review_id, status, attempts, outcome FROM post_guards WHERE round_id = ? ORDER BY id').all(roundId) as unknown as GuardRow[];
}

function reports(db: DatabaseSync, roundId: number): GuardReport[] {
  return guardRows(db, roundId).map((g) => ({ kind: g.kind, reviewId: g.review_id, status: g.status, outcome: g.outcome ?? 'not run yet', attempts: g.attempts }));
}

/** The number of guards a round still owes. */
export function pendingGuards(db: DatabaseSync, roundId: number): number {
  return (db.prepare("SELECT count(*) AS n FROM post_guards WHERE round_id = ? AND status = 'pending'").get(roundId) as { n: number }).n;
}

function addGuard(db: DatabaseSync, roundId: number, kind: GuardKind, reviewId: number | null): void {
  db.prepare("INSERT INTO post_guards (round_id, kind, review_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(roundId, kind, reviewId, now());
}

/** A review of the round that is on GitHub: posted by this call, or adopted after an interrupted one. */
interface Landed {
  event: ReviewEvent | null;
  reviewId: number;
  commitId: string;
  postedAt: string;
  bodySha256: string;
}

/**
 * Records a review of the round as posted, and the withdrawal it owes when GitHub bound it to another commit than
 * the reviewed head, in one transaction (P6 round 2 row 1): a crash can no longer leave the round posted with that
 * guard missing.
 */
function recordPosted(db: DatabaseSync, round: RoundRow, landed: Landed, kind: 'posted' | 'post-adopted', detail: Record<string, unknown>): void {
  immediate(db, () => {
    db.prepare('UPDATE rounds SET event_posted = ?, review_id = ?, posted_commit_id = ?, posted_at = ?, posted_body_sha256 = ? WHERE id = ?').run(
      landed.event,
      landed.reviewId,
      landed.commitId,
      landed.postedAt,
      landed.bodySha256,
      round.id,
    );
    insertEvent(db, kind, round.id, detail);
    // Row 5: a review GitHub bound to another commit than the reviewed head is withdrawn, whatever its event.
    if (landed.commitId.toLowerCase() !== round.head_sha.toLowerCase()) addGuard(db, round.id, 'withdraw-off-head', landed.reviewId);
  });
}

/**
 * Runs the round's pending guards and records each result. A guard whose call fails stays pending, with why, for the
 * next `post`; every other guard is marked done with what it did (or why it was not needed).
 */
function runGuards(store: Store, api: GitHubApi, round: RoundRow, ref: PrRef, cfg: MarkerConfig): void {
  const { db } = store;
  const pending = guardRows(db, round.id).filter((g) => g.status === 'pending');
  if (pending.length === 0) return;
  const intent = latestIntent(db, round.id) ?? {};
  const seen = new Set(intent.reviews_seen ?? []);
  const head = round.head_sha;
  let live: PrSnapshot | Error | undefined;
  const read = (): PrSnapshot => {
    if (live === undefined) {
      try {
        live = readPr(api, ref);
      } catch (error) {
        live = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (live instanceof Error) throw live;
    return live;
  };
  const withdrawn = new Set<number>();
  const dismiss = (reviewId: number, message: string): string | null => {
    try {
      api.send('PUT', `${restPath('repos', ref.owner, ref.repo, 'pulls', ref.number, 'reviews', reviewId)}/dismissals`, { message, event: 'DISMISS' });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
  /** The live state of a review, or null when the read failed or the review is gone. */
  const stateOf = (reviewId: number): string | null => {
    try {
      return read().reviews.find((r) => r.id === reviewId)?.state ?? null;
    } catch {
      return null;
    }
  };
  const finish = (g: GuardRow, done: boolean, outcome: string): void => {
    db.prepare('UPDATE post_guards SET status = ?, attempts = attempts + 1, outcome = ?, done_at = ? WHERE id = ?').run(done ? 'done' : 'pending', outcome, done ? now() : null, g.id);
    insertEvent(db, 'guard', round.id, { guard: g.id, kind: g.kind, review_id: g.review_id, status: done ? 'done' : 'pending', outcome });
  };

  for (const g of pending) {
    if (g.kind === 'approval-race') {
      const ours = round.review_id;
      if (ours === null) {
        finish(g, false, 'the round has no posted review yet');
        continue;
      }
      if (withdrawn.has(ours) || stateOf(ours) === 'DISMISSED') {
        finish(g, true, 'our approval is already withdrawn');
        continue;
      }
      let why: string | null = null;
      try {
        const after = read();
        // Row 3: any submitted review the pre-post read did not see (a pending draft submitted since counts) that is
        // not a counted council review of this PR. A stranger's marker-shaped first line is not one.
        const landed = after.reviews.filter((r) => r.state !== 'PENDING' && r.id !== ours && !seen.has(r.id) && !countsAsCouncil(r, cfg, ref));
        if (after.headSha.toLowerCase() !== head.toLowerCase()) why = `the head moved to ${after.headSha.slice(0, 7)} while the approval was posted`;
        else if (landed.length > 0) why = `a review landed while the approval was posted (${landed.map((r) => `${r.login} ${r.state}`).join(', ')})`;
      } catch (error) {
        why = `the re-read after the approval failed (${error instanceof Error ? error.message : String(error)}), so the approval is not trusted`;
      }
      if (why === null) {
        finish(g, true, 'kept: no review landed meanwhile and the head held');
        continue;
      }
      const failed = dismiss(ours, `sabotage-council: approval withdrawn: ${why}.`);
      if (failed === null) withdrawn.add(ours);
      finish(g, failed === null, failed === null ? `withdrawn: ${why}` : `${why}; the withdrawal failed (${failed}), so the approval still stands`);
    } else if (g.kind === 'dismiss-stale') {
      const id = g.review_id ?? 0;
      const state = stateOf(id);
      if (state !== null && state !== 'CHANGES_REQUESTED') {
        finish(g, true, `no longer standing (${state})`);
        continue;
      }
      const failed = dismiss(id, `sabotage-council: superseded by round ${round.round_no} at ${head.slice(0, 7)}, which owes nothing.`);
      finish(g, failed === null, failed === null ? `dismissed: superseded by round ${round.round_no}, which owes nothing` : `the dismissal failed (${failed})`);
    } else {
      // withdraw-off-head (row 5): GitHub bound our review to another commit than the reviewed head.
      const id = g.review_id ?? 0;
      if (round.event_posted === 'COMMENT') {
        finish(g, true, 'a comment sets no approval or block, and GitHub dismisses only approvals and change requests');
        continue;
      }
      if (withdrawn.has(id) || stateOf(id) === 'DISMISSED') {
        finish(g, true, 'already withdrawn');
        continue;
      }
      const failed = dismiss(id, `sabotage-council: withdrawn: this review is bound to another commit than the reviewed head ${head.slice(0, 7)}.`);
      if (failed === null) withdrawn.add(id);
      finish(g, failed === null, failed === null ? 'withdrawn: bound to another commit than the reviewed head' : `the withdrawal failed (${failed})`);
    }
  }
}

/* ---------- change requests the round never saw (row 12) ---------- */

/**
 * The change requests the round carried when it was prepared: a council round's R items and the user's own request
 * (asks or a hold); for an identity round (which carries none), every review it saw.
 */
function knownRequests(store: Store, round: RoundRow): Set<number> {
  if (round.kind === 'identity') {
    const d = getEvents(store.db, round.id).find((e) => e.kind === 'identity-prepared')?.detail as { reviews_seen?: number[] } | undefined;
    return new Set(d?.reviews_seen ?? []);
  }
  const pr = preparedDetail(store, round.id).pr;
  const known = new Set((pr?.review_items ?? []).map((i) => Number(i.replace(/^R/, ''))));
  if (pr?.user_change_request) known.add(pr.user_change_request.review_id);
  return known;
}

/** One hold line per standing human change request the round never carried. */
function unadjudicatedRequests(store: Store, round: RoundRow, pr: PrSnapshot, cfg: MarkerConfig): string[] {
  const known = knownRequests(store, round);
  return standingChangeRequests(pr.reviews, cfg)
    .filter((r) => !known.has(r.id))
    .map((r) => `a change request by ${r.login} (review ${r.id}) came after this round was prepared, so its asks were never adjudicated: re-run the round`);
}

/* ---------- what the user approved (row 8) ---------- */

/** The renders the round's dry runs printed, oldest first: what the user can have seen and approved. */
function dryRuns(db: DatabaseSync, roundId: number): Array<{ event: string; sha: string }> {
  return getEvents(db, roundId)
    .filter((e) => e.kind === 'post-dry-run')
    .map((e) => e.detail as { outcome?: string; event?: string; body_sha256?: string } | null)
    .filter((d) => d?.outcome === 'rendered' && typeof d.event === 'string' && typeof d.body_sha256 === 'string')
    .map((d) => ({ event: d?.event ?? '', sha: d?.body_sha256 ?? '' }));
}

/**
 * Why `--post` may not send this render, or null (row 8, claude F1): the event and body must be those of a dry run of
 * this round that the user saw, the one `--expect` names or else the latest. A render that changed since (CI turned
 * green, a review landed) is refused, never sent on the old go.
 */
function notApproved(db: DatabaseSync, roundId: number, event: string, sha: string, expect: string | undefined): string | null {
  const runs = dryRuns(db, roundId);
  const again = `run post ${roundId} --dry-run, show the user that review, and post it with --expect <its sha256> only on their go`;
  if (expect !== undefined) {
    if (expect !== sha) return `the review now differs from the one --expect names (${expect.slice(0, 12)}; now ${event} ${sha.slice(0, 12)}): nothing posts; ${again}`;
    if (!runs.some((r) => r.sha === expect && r.event === event)) return `no dry run of round ${roundId} printed ${event} with body ${expect.slice(0, 12)}: nothing posts; ${again}`;
    return null;
  }
  const last = runs.at(-1);
  if (last === undefined) return `round ${roundId} has no dry run: --post sends only a review the user saw; ${again}`;
  if (last.event !== event || last.sha !== sha) {
    return `the review differs from the latest dry run (that showed ${last.event} ${last.sha.slice(0, 12)}; now ${event} ${sha.slice(0, 12)}): nothing posts; ${again}`;
  }
  return null;
}

/* ---------- the post step ---------- */

type Refuse = (why: string) => PostResult;

/** Runs the post step. Never throws for a guard: every refusal is an outcome with its reasons, and an event. */
export function postRound(store: Store, o: PostOptions): PostResult {
  const { db } = store;
  const round = getRound(db, o.roundId);
  if (!round) throw new ForgeError(`no round ${o.roundId} in the store`);
  const result = base(round.id, o.mode, round.head_sha);
  const refuse: Refuse = (why) => {
    result.problems.push(why);
    insertEvent(db, o.mode === 'post' ? 'post-refused' : 'post-dry-run', round.id, { outcome: 'refused', why, event: result.event, body_sha256: result.bodySha256 });
    return result;
  };
  if (round.mode !== 'pr') return refuse(`round ${round.id} is a ${round.mode} round: only pr rounds post`);
  if (round.status !== 'adjudicated' && round.status !== 'identity') return refuse(`round ${round.id} is ${round.status}: a council round posts only once it is adjudicated`);
  if (o.mode === 'post' && round.dry_run === 1) return refuse(`round ${round.id} was started with --dry-run: it can render its post but never post`);
  if (round.marker === null) return refuse(`round ${round.id} has no marker`);
  if (o.mode === 'dry-run') return step(store, o, round, result, refuse);

  // Row 9: one POST per round. The claim is taken before any network call; the round is read again under it.
  const claim = claimPost(db, round.id);
  if ('why' in claim) return refuse(claim.why);
  try {
    o.hooks?.afterClaim?.();
    return step(store, o, getRound(db, round.id) ?? round, result, refuse);
  } finally {
    releaseClaim(db, round.id, claim.owner);
  }
}

function step(store: Store, o: PostOptions, round: RoundRow, result: PostResult, refuse: Refuse): PostResult {
  const { db } = store;
  const marker = round.marker ?? '';
  const ref = refOf(store, round);
  const cfg = markerConfig(o.config);
  const auto = autoOf(o.config);
  // Row 10: gh posts (and dismisses) as whichever account it is logged in as; that must be github.login.
  const wrongLogin = loginMismatch(o.api, cfg.login);
  if (wrongLogin !== null) return refuse(wrongLogin);
  if (round.event_posted !== null) {
    // Posted already: a later `post` resumes the guards it still owes (row 2).
    result.outcome = 'already-posted';
    result.event = round.event_posted as ReviewEvent;
    result.reviewId = round.review_id;
    result.problems.push(`round ${round.id} already posted review ${String(round.review_id)} (${round.event_posted})`);
    if (o.mode === 'post') runGuards(store, o.api, round, ref, cfg);
    result.guards = reports(db, round.id);
    return result;
  }
  const pr: PrSnapshot = readPr(o.api, ref);
  const head = round.head_sha;
  const superseded = (headNow: string): PostResult => {
    result.outcome = 'superseded';
    result.problems.push(`the head moved from ${head.slice(0, 7)} to ${headNow.slice(0, 7)}: the round is superseded and nothing posts`);
    if (o.mode === 'post') db.prepare("UPDATE rounds SET status = 'superseded' WHERE id = ?").run(round.id);
    insertEvent(db, o.mode === 'post' ? 'superseded' : 'post-dry-run', round.id, { outcome: 'superseded', head: headNow });
    return result;
  };
  // Plan 9.4 resume, for a post this round began and did not record (a crash between the POST and the store): a
  // review with this round's marker, body and event, that no other round stored, means it landed. It is reconciled
  // first, before a moved head or a closed PR can end the call, so the guards that post owes still run (P6 round 2
  // row 1); one GitHub bound to another commit is adopted with its withdrawal owed.
  const intent = latestIntent(db, round.id);
  if (intent !== undefined) {
    const found = adoptable(db, round, pr, cfg.login, intent);
    if (found.length > 1) {
      return refuse(`an earlier post of this round was interrupted, and ${found.length} reviews match what it meant to post (${found.map((r) => r.id).join(', ')}): nothing is adopted or posted; check them on GitHub`);
    }
    const landed = found[0];
    if (landed !== undefined) {
      const offHead = landed.commitId.toLowerCase() !== head.toLowerCase();
      result.outcome = 'already-posted';
      result.reviewId = landed.id;
      result.event = intent.event ?? EVENT_OF_STATE[landed.state] ?? null;
      result.problems.push(
        offHead
          ? `review ${landed.id} with this round's marker and body is already on GitHub, bound to ${landed.commitId.slice(0, 7)}, not the reviewed head`
          : `review ${landed.id} with this round's marker and body is already on this head`,
      );
      if (o.mode === 'post') {
        recordPosted(
          db,
          round,
          { event: result.event, reviewId: landed.id, commitId: landed.commitId, postedAt: landed.submittedAt === '' ? now() : landed.submittedAt, bodySha256: intent.body_sha256 ?? sha256(landed.body) },
          'post-adopted',
          { review_id: landed.id, state: landed.state, commit_id: landed.commitId },
        );
        // Row 2: the guards recorded with the intent still run, and the withdrawal of an off-head review with them.
        runGuards(store, o.api, getRound(db, round.id) ?? round, ref, cfg);
      }
      result.guards = reports(db, round.id);
      return result;
    }
  }
  // Guard: head moved (plan 3.7). The round is superseded and nothing posts.
  if (pr.headSha.toLowerCase() !== head.toLowerCase()) return superseded(pr.headSha);
  if (pr.state === 'closed' && o.mode === 'post') return refuse(`${ref.owner}/${ref.repo}#${ref.number} is closed: nothing posts`);

  const ci = readCi(o.api, ref, head, pr.baseRef, auto.ci_gate);
  result.ci = ci;
  const fullName = `${ref.owner}/${ref.repo}`;
  const configuredTests = Object.keys(auto.tests).some((k) => k.toLowerCase() === fullName.toLowerCase());
  const cr = userChangeRequest(pr.reviews, cfg, head);
  const participants = new Set(participantsOf(pr, cfg));
  const identity = round.kind === 'identity';
  const unadjudicated = unadjudicatedRequests(store, round, pr, cfg);
  const common = {
    isAuthor: sameLogin(pr.author, cfg.login),
    identity,
    autoApprove: auto.approve,
    ci,
    ciRedEvent: auto.ci_red_event,
    tests: configuredTests ? { state: 'held' as const, why: 'opt-in test runs are not built yet (P8)' } : { state: 'off' as const, why: 'no tests configured' },
    onHoldList: onList(auto.repos_hold, fullName),
    unadjudicated,
  };

  let facts: EventFacts;
  let decision: EventDecision;
  let body: string;
  let owed: number | null;
  let holdsDismissal: boolean;
  if (identity) {
    const prep = getEvents(db, round.id).find((e) => e.kind === 'identity-prepared')?.detail as { match?: IdentityMatch } | undefined;
    if (!prep?.match) return refuse(`round ${round.id} has no identity record`);
    let recheck: string | null;
    try {
      const r = recheckIdentity(o.api, pr, cfg.login, prep.match, apiTreeOf(o.api, ref, head));
      recheck = r.ok ? null : `the live re-check failed: ${r.why}`;
    } catch (error) {
      recheck = `the live re-check could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
    // Row 14: on the user's own PR the author row matches first; its comment still carries "Ruling needed" when the
    // round recorded one or the user's change request stands now (N10). Elsewhere the identity rows decide (N2).
    const authorRuling = common.isAuthor && (round.needs_ruling === 1 || cr !== null);
    const holds = cr !== null ? [`Your own change request (review ${cr.review.id}) stands (plan 3.8).`] : [];
    facts = { ...common, needsRuling: authorRuling, verdict: null, owed: 0, legsClear: false, council: false, adjudicatorApprove: false, userChangeRequest: cr !== null, identityRecheck: recheck };
    decision = decideEvent(facts);
    body = renderBody(
      { kind: 'identity', marker, decision, number: prep.match.number, commitId: prep.match.commitId, reviewId: prep.match.reviewId, ci, recheck, holds },
      { nonce: null, participants },
    );
    owed = null;
    holdsDismissal = cr !== null || unadjudicated.length > 0;
  } else {
    const { doc, legsClear, quorum } = adjudicationOf(store, round.id);
    const rulings = doc.findings.some((f) => f.outcome === 'ruling');
    const holdLive = cr !== null && cr.onHead;
    const holds = holdLive ? [`Your own change request (review ${cr.review.id}) stands on this head (plan 3.8).`] : [];
    facts = {
      ...common,
      needsRuling: round.needs_ruling === 1 || doc.needs_ruling || rulings || holdLive,
      verdict: round.verdict as EventFacts['verdict'],
      owed: round.owed_count ?? 0,
      legsClear,
      council: quorum === 'council',
      adjudicatorApprove: round.approve === 1,
      userChangeRequest: cr !== null,
      identityRecheck: null,
    };
    decision = decideEvent(facts);
    const detail = preparedDetail(store, round.id);
    body = renderBody(
      {
        kind: 'council',
        marker,
        decision,
        adjudication: doc,
        verdict: round.verdict ?? doc.verdict,
        owed: round.owed_count ?? 0,
        legs: bodyLegs(store, round.id),
        quorum: quorum === 'council' ? 'council' : 'solo',
        ci,
        holds,
        fullRoundReason: round.full_round_reason ?? (detail.scope === 'fallback' ? 'the baseline could not serve' : null),
      },
      { nonce: round.nonce, participants },
    );
    owed = round.owed_count ?? 0;
    // A request the round never adjudicated means its "owes nothing" is not final: our stale request stands too.
    holdsDismissal = facts.needsRuling || unadjudicated.length > 0;
  }
  result.event = decision.event;
  result.row = decision.row;
  result.body = body;
  result.bodySha256 = sha256(body);
  result.problems.push(...validateBody(body, { marker, rules: { nonce: round.nonce, participants }, owed, ruling: decision.ruling }));
  if (result.problems.length > 0) {
    insertEvent(db, o.mode === 'post' ? 'post-refused' : 'post-dry-run', round.id, { outcome: 'refused', problems: result.problems, event: decision.event, row: decision.row });
    return result;
  }
  // Plan 9.4: an interrupted post that did not land re-posts only the body it meant to post.
  if (intent !== undefined && intent.body_sha256 !== result.bodySha256) {
    return refuse(`an earlier post of this round was interrupted, and the body now differs from the one it meant to post (${String(intent.body_sha256).slice(0, 12)}): nothing posts`);
  }
  // N11: our own earlier REQUEST_CHANGES is dismissed only after a COMMENT with nothing owed and no ruling pending.
  const stale = decision.event === 'COMMENT' && (owed ?? 0) === 0 && !holdsDismissal ? staleChangeRequests(pr.reviews, cfg.login, ref) : [];
  const roundDir = roundDirOf(o.layout, round.id);

  if (o.mode === 'dry-run') {
    result.outcome = 'rendered';
    result.guards = [
      ...(decision.event === 'APPROVE'
        ? [{ kind: 'approval-race' as const, reviewId: null, status: 'would-run' as const, outcome: 'would re-read the PR after the approval and withdraw it if the head moved or another review landed', attempts: 0 }]
        : []),
      ...stale.map((r) => ({ kind: 'dismiss-stale' as const, reviewId: r.id, status: 'would-run' as const, outcome: 'would be dismissed: superseded by this round, nothing owed', attempts: 0 })),
    ];
    writeFileSync(join(roundDir, 'REVIEW.dry-run.md'), body);
    insertEvent(db, 'post-dry-run', round.id, { outcome: 'rendered', event: decision.event, row: decision.row, commit_id: head, body_sha256: result.bodySha256, would_dismiss: stale.map((r) => r.id), ci });
    if (round.dry_run === 0) result.next = `sabotage-council post ${round.id} --post --expect ${result.bodySha256}`;
    return result;
  }

  // Row 8: --post sends only the review a dry run showed the user.
  const unapproved = notApproved(db, round.id, decision.event, result.bodySha256, o.expect);
  if (unapproved !== null) {
    result.next = `sabotage-council post ${round.id} --dry-run`;
    return refuse(unapproved);
  }

  // Row 5: the CI and identity reads take time; read the head once more right before the POST.
  const headNow = readPull(o.api, ref).headSha;
  if (headNow.toLowerCase() !== head.toLowerCase()) return superseded(headNow);

  // The intent and the guards it owes, in one transaction before the POST (plan 9.4, row 2). A re-post after an
  // interrupted POST that did not land replaces the guards that never ran.
  immediate(db, () => {
    db.prepare("DELETE FROM post_guards WHERE round_id = ? AND status = 'pending'").run(round.id);
    insertEvent(db, 'posting', round.id, {
      event: decision.event,
      row: decision.row,
      commit_id: head,
      body_sha256: result.bodySha256 ?? '',
      body,
      reviews_seen: pr.reviews.filter((r) => r.state !== 'PENDING').map((r) => r.id),
    } satisfies Intent);
    if (decision.event === 'APPROVE') addGuard(db, round.id, 'approval-race', null);
    for (const r of stale) addGuard(db, round.id, 'dismiss-stale', r.id);
  });
  const posted = normalizeReview(o.api.send('POST', `${restPath('repos', ref.owner, ref.repo, 'pulls', ref.number)}/reviews`, { commit_id: head, event: decision.event, body }));
  o.hooks?.afterPost?.();
  writeFileSync(join(roundDir, 'REVIEW.md'), body);
  recordPosted(
    db,
    round,
    { event: decision.event, reviewId: posted.id, commitId: posted.commitId, postedAt: now(), bodySha256: result.bodySha256 ?? sha256(body) },
    'posted',
    { review_id: posted.id, event: decision.event, row: decision.row, commit_id: posted.commitId, state: posted.state },
  );
  result.outcome = 'posted';
  result.reviewId = posted.id;
  runGuards(store, o.api, getRound(db, round.id) ?? round, ref, cfg);
  result.guards = reports(db, round.id);
  return result;
}

/**
 * Reads one review for a hand credit (plan 3.6 step 4) and stores it; refuses a pending review, one off this PR, and
 * one whose first line carries a round, identity or `markers_also_count` marker (P6 round 1 row 17): the marker rules
 * already decide whether such a review counts (a stranger's, a sha mismatch, an identity approval: never), and a
 * credit must not overrule them.
 */
export function addCredit(store: Store, api: GitHubApi, ref: PrRef, reviewId: number, cfg: MarkerConfig, note: string | null): { commitId: string; submittedAt: string } {
  const r = normalizeReview(api.get(`${restPath('repos', ref.owner, ref.repo, 'pulls', ref.number, 'reviews', reviewId)}`));
  if (r.state === 'PENDING' || r.submittedAt === '') throw new ForgeError(`review ${reviewId} is not submitted`);
  const marker = parseMarker(r.body, cfg.markers_also_count);
  if (marker !== null) {
    throw new ForgeError(`review ${reviewId} starts with a ${marker.kind === 'also' ? 'markers_also_count' : marker.kind} marker: the round count's marker rules decide whether it counts, so it cannot be credited`);
  }
  const by = cfg.login;
  store.db
    .prepare(
      `INSERT INTO credits (repo, num, review_id, commit_id, submitted_at, credited_by, credited_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, num, review_id) DO UPDATE SET note = excluded.note`,
    )
    .run(repoKeyOf(ref), ref.number, r.id, r.commitId, r.submittedAt, by, now(), note);
  return { commitId: r.commitId, submittedAt: r.submittedAt };
}
