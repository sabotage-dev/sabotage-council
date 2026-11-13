import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Adjudication } from '../adjudicate/schema.js';
import type { CouncilConfig } from '../config/schema.js';
import { readCi, type CiState } from '../forge/ci.js';
import { userChangeRequest } from '../forge/count.js';
import { decideEvent, type EventDecision, type EventFacts, type ReviewEvent } from '../forge/events.js';
import { ForgeError, restPath, type GitHubApi } from '../forge/github.js';
import { apiTreeOf, recheckIdentity, type IdentityMatch } from '../forge/identity.js';
import { firstLine, namesPr, parseMarker } from '../forge/markers.js';
import { normalizeReview, readPr, sameLogin, type PrRef, type PrSnapshot, type Review } from '../forge/pr.js';
import { renderBody, validateBody, type BodyLeg } from '../forge/render.js';
import type { Store } from '../store/open.js';
import { preparedDetail } from './facts.js';
import { autoOf, markerConfig, participantsOf } from './pr.js';
import { roundDirOf, type DataLayout } from './prepare.js';
import { getEvents, getLegs, getRound, insertEvent, now, sha256, type RoundRow } from './records.js';

/*
 * `sabotage-council post <round> --dry-run | --post` (plan 7.1 step 5, 3.7, 3.10): the post step after adjudication.
 * It re-reads the PR live, maps the round to its event (3.7's table), renders and validates the body, and then either
 * prints it (`--dry-run`, nothing is written to GitHub) or posts exactly one review on the reviewed head, followed by
 * the guards: the approval-race dismissal and the stale-change-request dismissal (only when nothing is owed, N11).
 */

export interface PostOptions {
  config: CouncilConfig;
  layout: DataLayout;
  api: GitHubApi;
  roundId: number;
  mode: 'dry-run' | 'post';
}

export type PostOutcome = 'rendered' | 'posted' | 'superseded' | 'refused' | 'already-posted';

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
  /** Our earlier REQUEST_CHANGES reviews dismissed (or, in a dry run, that would be). */
  dismissals: Array<{ reviewId: number; ok: boolean; why: string }>;
  /** The approval race (plan 3.7): our approval was dismissed, and why. */
  approvalDismissed: { ok: boolean; why: string } | null;
  ci: CiState | null;
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
  return { roundId, mode, outcome: 'refused', event: null, row: null, commitId, body: null, bodySha256: null, problems: [], reviewId: null, dismissals: [], approvalDismissed: null, ci: null };
}

/** Runs the post step. Never throws for a guard: every refusal is an outcome with its reasons, and an event. */
export function postRound(store: Store, o: PostOptions): PostResult {
  const { db } = store;
  const round = getRound(db, o.roundId);
  if (!round) throw new ForgeError(`no round ${o.roundId} in the store`);
  const result = base(round.id, o.mode, round.head_sha);
  const refuse = (why: string): PostResult => {
    result.problems.push(why);
    insertEvent(db, o.mode === 'post' ? 'post-refused' : 'post-dry-run', round.id, { outcome: 'refused', why });
    return result;
  };
  if (round.mode !== 'pr') return refuse(`round ${round.id} is a ${round.mode} round: only pr rounds post`);
  if (round.status !== 'adjudicated' && round.status !== 'identity') return refuse(`round ${round.id} is ${round.status}: a council round posts only once it is adjudicated`);
  if (round.event_posted !== null) {
    result.outcome = 'already-posted';
    result.event = round.event_posted as ReviewEvent;
    result.reviewId = round.review_id;
    result.problems.push(`round ${round.id} already posted review ${String(round.review_id)} (${round.event_posted})`);
    return result;
  }
  if (o.mode === 'post' && round.dry_run === 1) return refuse(`round ${round.id} was started with --dry-run: it can render its post but never post`);
  if (round.marker === null) return refuse(`round ${round.id} has no marker`);

  const ref = refOf(store, round);
  const cfg = markerConfig(o.config);
  const auto = autoOf(o.config);
  const pr: PrSnapshot = readPr(o.api, ref);
  const head = round.head_sha;
  // Guard: head moved (plan 3.7). The round is superseded and nothing posts.
  if (pr.headSha.toLowerCase() !== head.toLowerCase()) {
    result.outcome = 'superseded';
    result.problems.push(`the head moved from ${head.slice(0, 7)} to ${pr.headSha.slice(0, 7)}: the round is superseded and nothing posts`);
    if (o.mode === 'post') db.prepare("UPDATE rounds SET status = 'superseded' WHERE id = ?").run(round.id);
    insertEvent(db, o.mode === 'post' ? 'superseded' : 'post-dry-run', round.id, { outcome: 'superseded', head: pr.headSha });
    return result;
  }
  if (pr.state === 'closed' && o.mode === 'post') return refuse(`${ref.owner}/${ref.repo}#${ref.number} is closed: nothing posts`);
  // Plan 9.4 resume, for a post this round began and did not record (a crash between the POST and the store): a
  // review of ours with this marker on this head means it landed. Without that intent, such a review is another
  // council's on the same head (the same round number, 3.6), not ours.
  const roundEvents = getEvents(db, round.id);
  const intent = roundEvents.filter((e) => e.kind === 'posting').at(-1)?.detail as { body_sha256?: string } | undefined;
  const landed = intent === undefined ? undefined : pr.reviews.find((r) => sameLogin(r.login, cfg.login) && r.commitId === head && firstLine(r.body) === round.marker);
  if (landed !== undefined) {
    result.outcome = 'already-posted';
    result.reviewId = landed.id;
    result.event = EVENT_OF_STATE[landed.state] ?? null;
    result.problems.push(`review ${landed.id} with this round's marker is already on this head`);
    if (o.mode === 'post') {
      db.prepare('UPDATE rounds SET review_id = ?, event_posted = ?, posted_commit_id = ? WHERE id = ?').run(landed.id, result.event, head, round.id);
      insertEvent(db, 'post-adopted', round.id, { review_id: landed.id, state: landed.state });
    }
    return result;
  }

  const ci = readCi(o.api, ref, head, pr.baseRef, auto.ci_gate);
  result.ci = ci;
  const fullName = `${ref.owner}/${ref.repo}`;
  const configuredTests = Object.keys(auto.tests).some((k) => k.toLowerCase() === fullName.toLowerCase());
  const cr = userChangeRequest(pr.reviews, cfg, head);
  const participants = new Set(participantsOf(pr, cfg));
  const identity = round.kind === 'identity';
  const common = {
    isAuthor: sameLogin(pr.author, cfg.login),
    identity,
    autoApprove: auto.approve,
    ci,
    ciRedEvent: auto.ci_red_event,
    tests: configuredTests ? { state: 'held' as const, why: 'opt-in test runs are not built yet (P8)' } : { state: 'off' as const, why: 'no tests configured' },
    onHoldList: onList(auto.repos_hold, fullName),
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
      const r = recheckIdentity(o.api, ref, prep.match, apiTreeOf(o.api, ref, head));
      recheck = r.ok ? null : `the live re-check failed: ${r.why}`;
    } catch (error) {
      recheck = `the live re-check could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
    facts = { ...common, needsRuling: false, verdict: null, owed: 0, legsClear: false, council: false, adjudicatorApprove: false, userChangeRequest: cr !== null, identityRecheck: recheck };
    decision = decideEvent(facts);
    body = renderBody({ kind: 'identity', marker: round.marker, decision, number: prep.match.number, commitId: prep.match.commitId, reviewId: prep.match.reviewId, ci }, { nonce: null, participants });
    owed = null;
    holdsDismissal = cr !== null;
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
        marker: round.marker,
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
    holdsDismissal = facts.needsRuling;
  }
  result.event = decision.event;
  result.row = decision.row;
  result.body = body;
  result.bodySha256 = sha256(body);
  result.problems.push(...validateBody(body, { marker: round.marker, rules: { nonce: round.nonce, participants }, owed }));
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
    result.dismissals = stale.map((r) => ({ reviewId: r.id, ok: true, why: 'would be dismissed: superseded by this round, nothing owed' }));
    writeFileSync(join(roundDir, 'REVIEW.dry-run.md'), body);
    insertEvent(db, 'post-dry-run', round.id, { outcome: 'rendered', event: decision.event, row: decision.row, commit_id: head, body_sha256: result.bodySha256, would_dismiss: stale.map((r) => r.id), ci });
    return result;
  }

  insertEvent(db, 'posting', round.id, { event: decision.event, row: decision.row, commit_id: head, body_sha256: result.bodySha256 });
  const seen = new Set(pr.reviews.map((r) => r.id));
  const posted = normalizeReview(o.api.send('POST', `${restPath('repos', ref.owner, ref.repo, 'pulls', ref.number)}/reviews`, { commit_id: head, event: decision.event, body }));
  writeFileSync(join(roundDir, 'REVIEW.md'), body);
  db.prepare('UPDATE rounds SET event_posted = ?, review_id = ?, posted_commit_id = ?, posted_at = ?, posted_body_sha256 = ? WHERE id = ?').run(
    decision.event,
    posted.id,
    posted.commitId,
    now(),
    result.bodySha256,
    round.id,
  );
  insertEvent(db, 'posted', round.id, { review_id: posted.id, event: decision.event, row: decision.row, commit_id: posted.commitId, state: posted.state });
  result.outcome = 'posted';
  result.reviewId = posted.id;

  const dismiss = (reviewId: number, message: string): { ok: boolean; why: string } => {
    try {
      o.api.send('PUT', `${restPath('repos', ref.owner, ref.repo, 'pulls', ref.number, 'reviews', reviewId)}/dismissals`, { message, event: 'DISMISS' });
      return { ok: true, why: message };
    } catch (error) {
      return { ok: false, why: `${message} (the dismissal failed: ${error instanceof Error ? error.message : String(error)})` };
    }
  };

  // Guard: the approval race (plan 3.7). Re-read; a moved head or a review that landed meanwhile dismisses ours.
  if (decision.event === 'APPROVE') {
    let why: string | null = null;
    try {
      const after = readPr(o.api, ref);
      const landedMeanwhile = after.reviews.filter((r) => !seen.has(r.id) && r.id !== posted.id && parseMarker(r.body, cfg.markers_also_count) === null);
      if (after.headSha !== head) why = `the head moved to ${after.headSha.slice(0, 7)} while the approval was posted`;
      else if (landedMeanwhile.length > 0) why = `a review landed while the approval was posted (${landedMeanwhile.map((r) => `${r.login} ${r.state}`).join(', ')})`;
    } catch (error) {
      why = `the re-read after the approval failed (${error instanceof Error ? error.message : String(error)}), so the approval is not trusted`;
    }
    if (why !== null) {
      result.approvalDismissed = dismiss(posted.id, `sabotage-council: approval withdrawn: ${why}.`);
      insertEvent(db, 'approval-dismissed', round.id, { review_id: posted.id, ...result.approvalDismissed });
    }
  }
  for (const r of stale) {
    const d = dismiss(r.id, `sabotage-council: superseded by round ${round.round_no} at ${head.slice(0, 7)}, which owes nothing.`);
    result.dismissals.push({ reviewId: r.id, ...d });
    insertEvent(db, 'dismissed', round.id, { review_id: r.id, ...d });
  }
  return result;
}

/** Reads one review for a hand credit (plan 3.6 step 4) and stores it; refuses a pending review or one off this PR. */
export function addCredit(store: Store, api: GitHubApi, ref: PrRef, reviewId: number, by: string, note: string | null): { commitId: string; submittedAt: string } {
  const r = normalizeReview(api.get(`${restPath('repos', ref.owner, ref.repo, 'pulls', ref.number, 'reviews', reviewId)}`));
  if (r.state === 'PENDING' || r.submittedAt === '') throw new ForgeError(`review ${reviewId} is not submitted`);
  store.db
    .prepare(
      `INSERT INTO credits (repo, num, review_id, commit_id, submitted_at, credited_by, credited_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo, num, review_id) DO UPDATE SET note = excluded.note`,
    )
    .run(`github.com/${ref.owner}/${ref.repo}`, ref.number, r.id, r.commitId, r.submittedAt, by, now(), note);
  return { commitId: r.commitId, submittedAt: r.submittedAt };
}
