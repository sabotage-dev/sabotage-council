import type { AdjudicatedFinding, Adjudication } from '../adjudicate/schema.js';
import { effectiveLegVerdict, legsClear, type LegVerdict } from '../adjudicate/index.js';
import { claimLive, getRow, immediate, patchUnclaimed, rowOfRound } from '../auto/ledger.js';
import type { Store } from '../store/open.js';
import type { DatabaseSync } from '../store/sqlite.js';
import { preparedDetail } from './facts.js';
import { countedLegs, getEvents, getRound, insertEvent, now, type RoundRow } from './records.js';

/*
 * Rulings (plan 3.8). A round that needs a ruling holds: it posts its "Ruling needed" COMMENT (when anything can be
 * posted), and nothing more happens at that head until the user rules or a new head arrives. Two commands:
 *
 *   ruling <round> <finding-id> uphold|overturn [--note]   the finding's ruling_result, actor and time (8.1)
 *   ruling <round> approve|post|skip [--note]               releases the round
 *
 * A release is recorded on the round (a `ruling-release` event) and on its ledger row:
 *   - approve: the round's review is mapped again with the rulings applied (an upheld finding is owed, an overturned
 *     one refuted) and may approve when every other gate allows it (CI, the hold list, auto.approve, tests, legs
 *     clear, a council). Refused while any ruling finding is unruled or upheld (that review would request changes:
 *     release it with post).
 *   - post: the same review, with approval held: it posts REQUEST_CHANGES for an upheld finding, else a COMMENT.
 *   - skip: nothing more posts for this round; its ledger row is skipped.
 *
 * A ruling round that already posted its COMMENT posts its release as one more review on the same head: the COMMENT's
 * post record moves into a `ruling-comment-archived` event in the release's transaction, so the round can post once
 * more and a resumed post never adopts the COMMENT for it. Only a release lets a held round post an APPROVE: nothing
 * else clears the hold.
 */

export class RulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulingError';
  }
}

export type ReleaseDecision = 'approve' | 'post' | 'skip';

export interface RulingRelease {
  decision: ReleaseDecision;
  by: string;
  at: string;
  note: string | null;
}

interface RulingRow {
  id: string;
  title: string;
  severity: string | null;
  kind: 'finding' | 'human_ask';
  ruling_result: 'upheld' | 'overturned' | null;
  ruled_by: string | null;
  ruled_at: string | null;
}

/** The round's `ruling` findings with what the user ruled on each. */
export function rulingFindings(db: DatabaseSync, roundId: number): RulingRow[] {
  return db.prepare("SELECT id, title, severity, kind, ruling_result, ruled_by, ruled_at FROM findings WHERE round_id = ? AND outcome = 'ruling' ORDER BY id").all(roundId) as unknown as RulingRow[];
}

/** The round's latest release, or null. A later release replaces an earlier one only before it posted. */
export function latestRelease(db: DatabaseSync, roundId: number): RulingRelease | null {
  const e = getEvents(db, roundId)
    .filter((x) => x.kind === 'ruling-release')
    .at(-1);
  const d = e?.detail as Partial<RulingRelease> | undefined;
  if (d?.decision !== 'approve' && d?.decision !== 'post' && d?.decision !== 'skip') return null;
  return { decision: d.decision, by: String(d.by ?? ''), at: String(d.at ?? e?.ts ?? ''), note: typeof d.note === 'string' ? d.note : null };
}

/** The events of a round after its latest release (the whole list when it has none): what a release post judges. */
export function sinceRelease<T extends { kind: string }>(events: readonly T[]): T[] {
  let cut = -1;
  events.forEach((e, i) => {
    if (e.kind === 'ruling-release') cut = i;
  });
  return events.slice(cut + 1);
}

/** Review ids the round posted before a release (its ruling COMMENT): never adopted for the release's post. */
export function archivedReviews(db: DatabaseSync, roundId: number): Set<number> {
  const ids = getEvents(db, roundId)
    .filter((e) => e.kind === 'ruling-comment-archived')
    .map((e) => Number((e.detail as { review_id?: unknown } | null)?.review_id))
    .filter((n) => Number.isSafeInteger(n) && n > 0);
  return new Set(ids);
}

/** Whether the round holds for a ruling: the round says so, or its ledger row is held. */
export function roundHeld(db: DatabaseSync, round: RoundRow): boolean {
  if (round.needs_ruling === 1) return true;
  if (round.kind === 'council' && rulingFindings(db, round.id).length > 0) return true;
  return rowOfRound(db, round.id)?.state === 'needs-ruling';
}

/** `ruling <round> <finding-id> uphold|overturn`: the finding's ruling_result, actor and time. */
export function ruleFinding(store: Store, roundId: number, findingId: string, result: 'uphold' | 'overturn', by: string, note: string | null): RulingRow {
  const { db } = store;
  return immediate(db, () => {
    const round = getRound(db, roundId);
    if (!round) throw new RulingError(`no round ${roundId} in the store`);
    if (latestRelease(db, roundId) !== null) throw new RulingError(`round ${roundId} was already released: its rulings are final`);
    const f = db.prepare('SELECT id, outcome FROM findings WHERE round_id = ? AND id = ?').get(roundId, findingId) as { id: string; outcome: string } | undefined;
    if (!f) throw new RulingError(`round ${roundId} has no finding ${findingId}`);
    if (f.outcome !== 'ruling') throw new RulingError(`finding ${findingId} of round ${roundId} is ${f.outcome}, not a ruling: only a ruling finding takes your ruling`);
    const value = result === 'uphold' ? 'upheld' : 'overturned';
    db.prepare('UPDATE findings SET ruling_result = ?, ruled_by = ?, ruled_at = ? WHERE round_id = ? AND id = ?').run(value, by, now(), roundId, findingId);
    insertEvent(db, 'ruling', roundId, { finding: findingId, result: value, by, note });
    return rulingFindings(db, roundId).find((r) => r.id === findingId) as RulingRow;
  });
}

export interface ReleaseResult {
  decision: ReleaseDecision;
  /** The ruling COMMENT moved aside so the release can post, or null. */
  archived: number | null;
  /** The ledger row's new state, when the round has one. */
  ledger: string | null;
  next: string;
}

/** `ruling <round> approve|post|skip`: releases a held round. */
export function releaseRound(store: Store, roundId: number, decision: ReleaseDecision, by: string, note: string | null, nowMs: number = Date.now()): ReleaseResult {
  const { db } = store;
  return immediate(db, () => {
    const round = getRound(db, roundId);
    if (!round) throw new RulingError(`no round ${roundId} in the store`);
    if (!roundHeld(db, round)) throw new RulingError(`round ${roundId} does not hold for a ruling: there is nothing to release`);
    const prior = latestRelease(db, roundId);
    if (prior !== null && round.event_posted !== null) throw new RulingError(`round ${roundId} was released (${prior.decision}) and its review is posted: a new head starts a new round`);
    const row = rowOfRound(db, roundId);
    if (row !== undefined && claimLive(row, nowMs)) throw new RulingError(`the auto daemon is working on round ${roundId} right now: rule again once its pass ends`);
    if (decision !== 'skip') {
      if (round.status !== 'adjudicated' && round.status !== 'identity') {
        throw new RulingError(
          `round ${roundId} is ${round.status}: there is no adjudication to post. Adjudicate it yourself (sabotage-council adjudicate ${roundId} <ADJUDICATION.json>), then release it, or release it with skip`,
        );
      }
      const open = rulingFindings(db, roundId).filter((f) => f.ruling_result === null);
      if (open.length > 0) throw new RulingError(`rule on every ruling finding first: ${open.map((f) => f.id).join(', ')} (sabotage-council ruling ${roundId} <finding-id> uphold|overturn)`);
      if (decision === 'approve') {
        const upheld = rulingFindings(db, roundId).filter((f) => f.ruling_result === 'upheld');
        if (upheld.length > 0) throw new RulingError(`${upheld.map((f) => f.id).join(', ')} upheld: that review requests changes, so it cannot approve; release it with post`);
      }
      const pending = (db.prepare("SELECT count(*) AS n FROM post_guards WHERE round_id = ? AND status = 'pending'").get(roundId) as { n: number }).n;
      if (pending > 0) throw new RulingError(`round ${roundId}'s posted review still owes ${pending} guard(s): run sabotage-council post ${roundId} --post to finish them first`);
    }
    insertEvent(db, 'ruling-release', roundId, { decision, by, note, at: now() } satisfies RulingRelease);
    let archived: number | null = null;
    if (decision !== 'skip' && round.event_posted !== null) {
      archived = round.review_id;
      insertEvent(db, 'ruling-comment-archived', roundId, {
        review_id: round.review_id,
        event: round.event_posted,
        posted_at: round.posted_at,
        posted_commit_id: round.posted_commit_id,
        posted_body_sha256: round.posted_body_sha256,
      });
      db.prepare('UPDATE rounds SET event_posted = NULL, review_id = NULL, posted_commit_id = NULL, posted_at = NULL, posted_body_sha256 = NULL WHERE id = ?').run(roundId);
    }
    let ledger: string | null = null;
    if (row !== undefined) {
      const state = decision === 'skip' ? 'skipped' : 'running';
      patchUnclaimed(db, row, { state, records_sha: null, event: null, review_sha256: null, review_id: decision === 'skip' ? row.review_id : null, reason: `released by a ruling (${decision})${note !== null ? `: ${note}` : ''}` }, nowMs);
      ledger = getRow(db, row)?.state ?? null;
    }
    const next =
      decision === 'skip'
        ? 'nothing more posts for this round'
        : row !== undefined
          ? 'the auto daemon posts the release on its next pass (or run sabotage-council auto run-once)'
          : `sabotage-council post ${roundId} --dry-run`;
    return { decision, archived, ledger, next };
  });
}

/** What a released round posts: its adjudication with the user's rulings applied (plan 3.8). */
export interface Applied {
  doc: Adjudication;
  owed: number;
  upheld: number;
  overturned: number;
  verdict: string;
  legsClear: boolean;
}

/**
 * The adjudication as the release posts it: each ruling finding upheld is owed, each overturned is refuted with the
 * ruling as its proof; `needs_ruling` is false; the summary names the release. Effective leg verdicts and legs clear
 * are recomputed from the legs' own mapped findings (plan 3.2), so an overturned ruling no longer holds a leg.
 */
export function applyRulings(store: Store, round: RoundRow, doc: Adjudication, release: RulingRelease): Applied {
  const { db } = store;
  const rulings = new Map(rulingFindings(db, round.id).map((r) => [r.id, r]));
  let upheld = 0;
  let overturned = 0;
  const findings: AdjudicatedFinding[] = doc.findings.map((f) => {
    if (f.outcome !== 'ruling') return f;
    const r = rulings.get(f.id);
    if (r?.ruling_result === 'upheld') {
      upheld++;
      return { ...f, outcome: 'owed' as const, proof: `${f.proof} (upheld by ${r.ruled_by ?? 'the user'}'s ruling)` };
    }
    if (r?.ruling_result === 'overturned') {
      overturned++;
      return { ...f, outcome: 'refuted' as const, proof: `overturned by ${r.ruled_by ?? 'the user'}'s ruling; the adjudicator's note: ${f.proof}` };
    }
    return f;
  });
  const names = [...rulings.values()].map((r) => `${r.id} ${r.ruling_result ?? 'unruled'}`).join(', ');
  const summary = `${doc.summary}\n\nReleased by a ruling (${release.decision}) of ${release.by}${names !== '' ? `: ${names}` : ''}${release.note !== null ? `. ${release.note}` : ''}.`;
  const applied: Adjudication = { ...doc, findings, needs_ruling: false, summary };
  const rule = preparedDetail(store, round.id).rule;
  const verdicts: LegVerdict[] = countedLegs(db, round.id).map((l) =>
    effectiveLegVerdict((l.verdict_raw ?? 'none') as LegVerdict, findings.filter((f) => f.raised_by.some((x) => x.seat === l.seat_id)), rule),
  );
  return {
    doc: applied,
    owed: (round.owed_count ?? 0) + upheld,
    upheld,
    overturned,
    verdict: upheld > 0 ? 'NEEDS-WORK' : (round.verdict ?? doc.verdict),
    legsClear: legsClear(verdicts),
  };
}
