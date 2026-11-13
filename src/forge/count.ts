import { namesPr, parseMarker, type Marker } from './markers.js';
import { sameLogin, type PrRef, type Review, type ReviewComment } from './pr.js';

/*
 * Plan 3.6 for PR targets: the round number counted from the PR's own review history, across every council that
 * reviewed it, plus the hand credits; the baseline head; the user's own open change request (3.8, 3.9); and the
 * earlier reviews that enter the root as items (3.5). Pure functions over what GitHub returned and the store holds.
 */

export interface MarkerConfig {
  /** `github.login`: the user, and the login the engine posts as. */
  login: string;
  council_logins: readonly string[];
  markers_also_count: readonly string[];
}

/** A hand credit (plan 3.6 step 4, 8.1 `credits`): an unmarked review the user vouches for, at its own head and time. */
export interface Credit {
  reviewId: number;
  commitId: string;
  submittedAt: string;
}

/** One counted event: a counted marker review or a credit. */
export interface CountEvent {
  reviewId: number;
  head: string;
  at: string;
  source: 'review' | 'credit';
  /** The `round <N>` a counted marker states; null for a credit or a marker that states none. */
  round: number | null;
  login: string | null;
}

export interface IgnoredReview {
  reviewId: number;
  login: string;
  why: string;
}

export interface RoundCount {
  /** The round this head gets: the count, plus 1 when the head has no event (step 6). */
  roundNo: number;
  /** The running count after every event (step 5). */
  count: number;
  /** The newest counted head other than this one (the one whose first event is the latest), or null. */
  baseline: string | null;
  /** This head has an event. */
  headCounted: boolean;
  events: CountEvent[];
  /** Reviews passed over, with why: logged (plan 3.6 step 3 asks for the mismatch to be logged). */
  ignored: IgnoredReview[];
}

export const allowlisted = (login: string, cfg: MarkerConfig): boolean => sameLogin(login, cfg.login) || cfg.council_logins.some((l) => sameLogin(l, login));

/** Whether a stated sha (7 to 40 hex) names this full sha. */
const shaMatches = (stated: string, full: string): boolean => full.toLowerCase().startsWith(stated.toLowerCase());

/** A marker the round count counts, or why it does not, for a review whose author is allowlisted. */
function counted(review: Review, marker: Marker, ref: PrRef): { round: number | null } | { why: string } {
  if (marker.kind === 'identity') return { why: 'an identity approval never counts as a round (plan 3.10)' };
  if (marker.kind === 'round' && !namesPr(marker.target, ref)) return { why: `its marker names ${marker.target}, not this pull request` };
  const stated = marker.sha;
  if (stated !== null && !shaMatches(stated, review.commitId)) {
    return { why: `its marker says ${stated} but it was submitted on ${review.commitId.slice(0, 7)} (commit_id): not counted` };
  }
  return { round: marker.round };
}

/**
 * Whether a review is a council review of this PR by the round count's own rules (3.6 steps 1-3): submitted, by an
 * allowlisted login, its first line our marker for this PR or a `markers_also_count` pattern, with no stated sha that
 * disagrees with its `commit_id`. An identity approval is not one. The approval race (3.7) withdraws our approval
 * for any review that landed meanwhile and is not one of these (P6 round 1 row 3): a marker-shaped first line by a
 * stranger is not.
 */
export function countsAsCouncil(review: Review, cfg: MarkerConfig, ref: PrRef): boolean {
  if (review.state === 'PENDING' || !allowlisted(review.login, cfg)) return false;
  const marker = parseMarker(review.body, cfg.markers_also_count);
  return marker !== null && !('why' in counted(review, marker, ref));
}

const byTime = (a: { at: string; reviewId: number }, b: { at: string; reviewId: number }): number =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.reviewId - b.reviewId;

/**
 * Plan 3.6, steps 1-6:
 * 1. keep submitted reviews (not PENDING; DISMISSED counts) by `github.login` or a `council_logins` login;
 * 2. keep those whose first line (one wrapper stripped) is our marker for this PR or a `markers_also_count` pattern
 *    (never an identity approval);
 * 3. the head is the review's `commit_id`; a marker whose stated sha disagrees is not counted, and is logged;
 * 4. credits join as events at their review's own head and time, de-duplicated by review id only: a counted marker
 *    and a credit with one review id are one event, the marker's, with its `round <N>` (N19);
 * 5. walk the events in time order: a head seen for the first time adds 1, then a marker's `round <N>` raises the
 *    count to N, never lowering it (N14: the new head first, then the floor, within one event);
 * 6. the round is the count, plus 1 when this head has no event.
 */
export function countRounds(input: { ref: PrRef; head: string; reviews: readonly Review[]; credits: readonly Credit[]; cfg: MarkerConfig }): RoundCount {
  const { ref, head, cfg } = input;
  const events = new Map<number, CountEvent>();
  const ignored: IgnoredReview[] = [];
  for (const review of input.reviews) {
    if (review.state === 'PENDING') continue;
    const marker = parseMarker(review.body, cfg.markers_also_count);
    if (marker === null) continue;
    if (!allowlisted(review.login, cfg)) {
      ignored.push({ reviewId: review.id, login: review.login, why: 'a marker review by a login outside github.login and council_logins' });
      continue;
    }
    const c = counted(review, marker, ref);
    if ('why' in c) {
      ignored.push({ reviewId: review.id, login: review.login, why: c.why });
      continue;
    }
    events.set(review.id, { reviewId: review.id, head: review.commitId, at: review.submittedAt, source: 'review', round: c.round, login: review.login });
  }
  for (const credit of input.credits) {
    if (events.has(credit.reviewId)) continue; // N19: the marker's event, and its round, stand
    events.set(credit.reviewId, { reviewId: credit.reviewId, head: credit.commitId, at: credit.submittedAt, source: 'credit', round: null, login: null });
  }
  const ordered = [...events.values()].sort(byTime);
  const seen = new Set<string>();
  const firstSeen: Array<{ head: string; at: string; reviewId: number }> = [];
  let count = 0;
  for (const e of ordered) {
    const h = e.head.toLowerCase();
    if (!seen.has(h)) {
      seen.add(h);
      count += 1;
      firstSeen.push({ head: e.head, at: e.at, reviewId: e.reviewId });
    }
    if (e.round !== null) count = Math.max(count, e.round);
  }
  const headCounted = seen.has(head.toLowerCase());
  const others = firstSeen.filter((f) => f.head.toLowerCase() !== head.toLowerCase());
  return { roundNo: count + (headCounted ? 0 : 1), count, baseline: others.at(-1)?.head ?? null, headCounted, events: ordered, ignored };
}

/** States that set a reviewer's standing on GitHub; COMMENTED does not change it. */
const STANDING = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** The newest review of a set that sets a standing (by time, then id): a reviewer's standing review on GitHub. */
export function latestStanding(reviews: readonly Review[]): Review | null {
  const standing = reviews.filter((r) => STANDING.has(r.state)).sort((a, b) => byTime({ at: a.submittedAt, reviewId: a.id }, { at: b.submittedAt, reviewId: b.id }));
  return standing.at(-1) ?? null;
}

export interface UserChangeRequest {
  review: Review;
  /** It stands on the head under review: a hold (plan 3.8), not asks. */
  onHead: boolean;
}

/**
 * The user's own open change request (plan 3.8, 3.9): `github.login`'s newest standing review that carries no
 * marker of any kind, when it is CHANGES_REQUESTED. The engine posts as the same login, so its own marker reviews
 * (a council REQUEST_CHANGES included) are never the user's request. On the current head it is a hold; on an
 * earlier head its asks go into the brief.
 */
export function userChangeRequest(reviews: readonly Review[], cfg: MarkerConfig, head: string): UserChangeRequest | null {
  const own = reviews.filter((r) => sameLogin(r.login, cfg.login) && r.state !== 'PENDING' && parseMarker(r.body, cfg.markers_also_count) === null);
  const latest = latestStanding(own);
  if (latest?.state !== 'CHANGES_REQUESTED') return null;
  return { review: latest, onHead: latest.commitId.toLowerCase() === head.toLowerCase() };
}

/** Caps one item's text: a review body can hold up to 65,536 characters. */
export const ITEM_TEXT_MAX = 20_000;

function cap(text: string): string {
  return text.length > ITEM_TEXT_MAX ? `${text.slice(0, ITEM_TEXT_MAX)}\n(truncated at ${ITEM_TEXT_MAX} characters)` : text;
}

function inlineOf(comments: readonly ReviewComment[], reviewId: number): ReviewComment[] {
  return comments.filter((c) => c.reviewId === reviewId);
}

/**
 * The asks of the user's change request, in order (H1, H2, ...): the review's body, then each of its inline
 * comments as `path:line: text`. A change request with no text at all is one ask saying so.
 */
export function changeRequestAsks(review: Review, comments: readonly ReviewComment[]): string[] {
  const asks: string[] = [];
  if (review.body.trim() !== '') asks.push(cap(review.body.trim()));
  for (const c of inlineOf(comments, review.id)) {
    if (c.body.trim() === '') continue;
    asks.push(cap(`${c.path}${c.line !== null ? `:${c.line}` : ''}: ${c.body.trim()}`));
  }
  return asks.length > 0 ? asks : [`(review ${review.id} requested changes with no text)`];
}

/** An earlier review carried into the round as an item (plan 3.5): source id `R<review id>`. */
export interface ReviewItem {
  id: string;
  reviewId: number;
  login: string;
  kind: 'council-review' | 'change-request';
  text: string;
}

/**
 * The earlier reviews a PR round carries as items (plan 3.5 rule (c); 9.4 "other reviewers' change requests are
 * earlier items"):
 * - every counted council review at the baseline head that this store did not adjudicate (another council, or this
 *   engine from another store): the reviews at the baseline carry the earlier rounds' open items forward;
 * - every other reviewer's (outside `github.login` and `council_logins`) newest standing review, when it is
 *   CHANGES_REQUESTED, on any head.
 * Each holds the review's body and its inline comments, as data.
 */
export function reviewItems(input: {
  reviews: readonly Review[];
  comments: readonly ReviewComment[];
  count: RoundCount;
  cfg: MarkerConfig;
  /** Review ids this store posted: their items come from the store, not from the body. */
  ours: ReadonlySet<number>;
}): ReviewItem[] {
  const { reviews, comments, count, cfg, ours } = input;
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const items: ReviewItem[] = [];
  const text = (r: Review, label: string): string => {
    const parts = [`${label} by ${r.login} (${r.state}) on ${r.commitId.slice(0, 7)}, submitted ${r.submittedAt}:`, r.body.trim() === '' ? '(no body)' : r.body.trim()];
    for (const c of inlineOf(comments, r.id)) parts.push(`Inline comment on ${c.path}${c.line !== null ? `:${c.line}` : ''}:`, c.body.trim());
    return cap(parts.join('\n'));
  };
  if (count.baseline !== null) {
    const base = count.baseline.toLowerCase();
    for (const e of count.events) {
      if (e.head.toLowerCase() !== base || ours.has(e.reviewId)) continue;
      const r = byId.get(e.reviewId);
      if (r === undefined) continue; // a credit whose review is gone: nothing to carry
      items.push({ id: `R${r.id}`, reviewId: r.id, login: r.login, kind: 'council-review', text: text(r, `Council review R${r.id}`) });
    }
  }
  for (const latest of othersChangeRequests(reviews, cfg)) {
    if (items.some((i) => i.reviewId === latest.id)) continue;
    items.push({ id: `R${latest.id}`, reviewId: latest.id, login: latest.login, kind: 'change-request', text: text(latest, `Change request R${latest.id}`) });
  }
  return items;
}

/** Every other reviewer's (outside github.login and council_logins) newest standing review, when it requests changes. */
function othersChangeRequests(reviews: readonly Review[], cfg: MarkerConfig): Review[] {
  const byLogin = new Map<string, Review[]>();
  for (const r of reviews) {
    if (r.state === 'PENDING' || allowlisted(r.login, cfg)) continue;
    const key = r.login.toLowerCase();
    byLogin.set(key, [...(byLogin.get(key) ?? []), r]);
  }
  return [...byLogin.values()].map(latestStanding).filter((r): r is Review => r?.state === 'CHANGES_REQUESTED');
}

/**
 * Every human change request standing on the PR, on any head (plan 3.5, 3.8): the user's own unmarked one and every
 * other reviewer's. A round carries each one it saw (asks, a hold or an R item); at post time one it did not carry
 * holds an approval, since its asks were never adjudicated (P6 round 1 row 12).
 */
export function standingChangeRequests(reviews: readonly Review[], cfg: MarkerConfig): Review[] {
  const own = userChangeRequest(reviews, cfg, '');
  return [...(own === null ? [] : [own.review]), ...othersChangeRequests(reviews, cfg)];
}
