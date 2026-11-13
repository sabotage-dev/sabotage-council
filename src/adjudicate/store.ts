import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { LegReply } from '../parse/index.js';
import type { Severity } from '../parse/severity.js';
import type { Store } from '../store/open.js';
import { roundFacts, type RoundFacts } from '../engine/facts.js';
import { roundDirOf, type DataLayout } from '../engine/prepare.js';
import { countedLegs, getRound, insertEvent, now, sha256, type LegRow } from '../engine/records.js';
import { removeRoundRoots } from '../engine/roots.js';
import type { LegVerdict } from './schema.js';
import { validateAdjudicationText, type AdjudicationContext, type ValidationOutcome } from './validate.js';

/*
 * `sabotage-council adjudicate <round> <ADJUDICATION.json>` (plan 7.1 step 4): validate against the round, then
 * store per-finding attribution in one transaction (plan 8.1), so the scorecard covers interactive rounds too.
 */

export class AdjudicateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdjudicateError';
  }
}

export function legDirOf(roundDir: string, leg: Pick<LegRow, 'seat_id' | 'role' | 'attempt'>): string {
  return join(roundDir, 'legs', `${leg.seat_id}-${leg.role}-${leg.attempt}`);
}

export function readReply(legDir: string): LegReply | null {
  const file = join(legDir, 'reply.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as LegReply) : null;
}

/**
 * Whether each ratified leg's findings block parsed, from the `legs-settled` event (fold row 3: the store, not the
 * leg dir's reply.json, decides what the adjudicator must map).
 */
function extractionNeeded(store: Store, roundId: number): Set<number> {
  const row = store.db.prepare("SELECT detail_json FROM events WHERE round_id = ? AND kind = 'legs-settled' ORDER BY id DESC LIMIT 1").get(roundId) as
    | { detail_json: string | null }
    | undefined;
  const detail = row?.detail_json ? (JSON.parse(row.detail_json) as { legs?: Array<{ id: number; findings?: string }> }) : {};
  return new Set((detail.legs ?? []).filter((l) => l.findings === 'adjudicator-needed').map((l) => l.id));
}

/** The round as the engine recorded it in the store, for the cross-checks. round.json is never read. */
export function adjudicationContext(store: Store, layout: DataLayout, roundId: number): { ctx: AdjudicationContext; facts: RoundFacts; legs: LegRow[] } {
  const facts = roundFacts(store, layout, roundId);
  const legs = countedLegs(store.db, roundId);
  const needed = extractionNeeded(store, roundId);
  const legFindings = store.db.prepare("SELECT local_id, severity FROM leg_findings WHERE leg_id = ? AND extracted_by = 'leg' ORDER BY id");
  const known = store.db
    .prepare('SELECT findings.id FROM findings JOIN rounds ON rounds.id = findings.round_id WHERE rounds.target_id = ? AND rounds.id <> ?')
    .all(facts.targetId, roundId) as Array<{ id: string }>;
  const ctx: AdjudicationContext = {
    roundNo: facts.roundNo,
    nonce: facts.nonce,
    headSha: facts.head,
    mode: facts.mode,
    rule: facts.rule,
    targetKey: facts.targetKey,
    legs: legs.map((l) => ({
      seat: l.seat_id,
      verdictRaw: (l.verdict_raw ?? 'none') as LegVerdict,
      findings: needed.has(l.id)
        ? null
        : (legFindings.all(l.id) as Array<{ local_id: string; severity: Severity }>).map((x) => ({ id: x.local_id, severity: x.severity })),
    })),
    earlierItems: facts.detail.earlier_items.map((i) => ({ id: i.id, severity: i.severity, kind: i.kind, origin: i.origin ?? 'owed', closedContext: i.closedContext })),
    humanAsks: facts.detail.human_asks,
    knownFindingIds: new Set(known.map((k) => k.id)),
  };
  return { ctx, facts, legs };
}

export interface AdjudicateResult {
  outcome: ValidationOutcome;
  roundId: number;
  stored: boolean;
}

export interface AdjudicateOptions {
  /** Validate only (fold row 8): nothing is stored, not even a rejection event. */
  check?: boolean | undefined;
  /**
   * Tests only: runs after the call decided to adjudicate and before its write transaction, standing in for another
   * process that adjudicates the same round at that moment (fold row 4).
   */
  beforeTransaction?: (() => void) | undefined;
}

/** Writes a file whole or not at all: a temp file in the same dir, then a rename. */
function writeAtomic(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Validates and, when it passes, stores the adjudication. A rejection stores nothing but an event with the errors.
 * Only a round whose legs have settled with at least one ratified leg can be adjudicated, and only once: the status
 * is checked, the context read and the document validated inside one `BEGIN IMMEDIATE` transaction, the round row
 * moves only from `awaiting-adjudication`, the whole validated document is stored in the `adjudicated` event, and
 * `ADJUDICATION.json` is written atomically before the commit (fold row 4). The store is the source of truth; the
 * file is an export of it.
 */
export function adjudicate(store: Store, layout: DataLayout, roundId: number, text: string, options: AdjudicateOptions = {}): AdjudicateResult {
  const { db } = store;
  if (!getRound(db, roundId)) throw new AdjudicateError(`no round ${roundId} in the store`);
  if (options.check === true) {
    const round = getRound(db, roundId);
    if (round?.status !== 'awaiting-adjudication') {
      throw new AdjudicateError(`round ${roundId} is ${String(round?.status)}; only a round awaiting adjudication can be adjudicated`);
    }
    return { outcome: validateAdjudicationText(text, adjudicationContext(store, layout, roundId).ctx), roundId, stored: false };
  }
  options.beforeTransaction?.();
  db.exec('BEGIN IMMEDIATE');
  let open = true;
  const commit = (): void => {
    db.exec('COMMIT');
    open = false;
  };
  let outcome: ValidationOutcome;
  try {
    const round = getRound(db, roundId);
    if (round?.status !== 'awaiting-adjudication') {
      throw new AdjudicateError(`round ${roundId} is ${String(round?.status)}; only a round awaiting adjudication can be adjudicated`);
    }
    const { ctx, facts, legs } = adjudicationContext(store, layout, roundId);
    outcome = validateAdjudicationText(text, ctx);
    if (!outcome.ok) {
      insertEvent(db, 'adjudication-rejected', roundId, { errors: outcome.errors });
      commit();
      return { outcome, roundId, stored: false };
    }
    const a = outcome.adjudication;
    const eff = outcome.effective;
    const legBySeat = new Map(legs.map((l) => [l.seat_id, l]));
    const lfId = db.prepare('SELECT id FROM leg_findings WHERE leg_id = ? AND local_id = ?');
    const insFinding = db.prepare(
      `INSERT INTO findings (round_id, id, kind, title, path, line, severity, outcome, owner, proof_ref, same_as, closes_item)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of a.findings) insFinding.run(roundId, f.id, f.kind, f.title, f.path, f.line, f.severity, f.outcome, f.owner, f.proof, f.same_as, f.closes_item);
    const insExtracted = db.prepare(
      `INSERT INTO leg_findings (leg_id, local_id, severity_raw, severity, path, line, title, extracted_by) VALUES (?, ?, NULL, ?, ?, ?, ?, 'adjudicator')`,
    );
    const map = db.prepare('UPDATE leg_findings SET mapped_round_id = ?, mapped_finding_id = ? WHERE id = ?');
    const source = db.prepare('INSERT INTO finding_sources (round_id, finding_id, leg_finding_id) VALUES (?, ?, ?)');
    for (const f of a.findings) {
      for (const r of f.raised_by) {
        const leg = legBySeat.get(r.seat);
        if (!leg) throw new AdjudicateError(`seat ${r.seat} has no ratified leg`);
        let row = lfId.get(leg.id, r.leg_finding) as { id: number } | undefined;
        if (!row && eff.extracted.some((x) => x.seat === r.seat && x.legFinding === r.leg_finding)) {
          const ins = insExtracted.run(leg.id, r.leg_finding, r.severity, f.path, f.line, f.title);
          row = { id: Number(ins.lastInsertRowid) };
        }
        if (!row) throw new AdjudicateError(`seat ${r.seat} finding ${r.leg_finding} is not in the store`);
        map.run(roundId, f.id, row.id);
        source.run(roundId, f.id, row.id);
      }
    }
    const unmap = db.prepare('UPDATE leg_findings SET unmapped_reason = ? WHERE id = ?');
    for (const u of a.unmapped) {
      const leg = legBySeat.get(u.seat);
      // An item of a leg whose block the adjudicator extracted has no row: it is not a finding, so none is made.
      const row = leg ? (lfId.get(leg.id, u.leg_finding) as { id: number } | undefined) : undefined;
      if (row) unmap.run(u.reason, row.id);
    }
    const items = new Map(facts.detail.earlier_items.map((i) => [i.id, i]));
    const insItem = db.prepare('INSERT INTO earlier_items (round_id, source_id, kind, status, evidence, body_sha256) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of a.earlier_items) {
      const item = items.get(e.source);
      // A closed item keeps the hash of the text it was closed on (plan 3.5): unchanged, later rounds list it as context.
      insItem.run(roundId, e.source, item?.kind ?? 'finding', e.status, e.evidence, e.status === 'closed' && item ? sha256(item.text) : null);
    }
    const legVerdict = db.prepare('UPDATE legs SET verdict_effective = ? WHERE id = ?');
    for (const [seat, v] of Object.entries(eff.legVerdicts)) {
      const leg = legBySeat.get(seat);
      if (leg) legVerdict.run(v, leg.id);
    }
    const fu = db.prepare("INSERT INTO followups (target_id, round_id, finding_id, status) VALUES (?, ?, ?, 'open')");
    for (const id of a.followups) fu.run(round.target_id, roundId, id);
    const moved = db
      .prepare(
        "UPDATE rounds SET verdict = ?, owed_count = ?, approve = ?, needs_ruling = ?, status = 'adjudicated', finished_at = ? WHERE id = ? AND status = 'awaiting-adjudication'",
      )
      .run(eff.verdict, eff.owed, a.approve ? 1 : 0, a.needs_ruling ? 1 : 0, now(), roundId);
    if (Number(moved.changes) !== 1) throw new AdjudicateError(`round ${roundId} changed status during adjudication`);
    insertEvent(db, 'adjudicated', roundId, {
      verdict: eff.verdict,
      verdict_given: a.verdict,
      owed: eff.owed,
      approve: a.approve,
      needs_ruling: a.needs_ruling,
      quorum: legs.length >= 2 ? 'council' : 'solo',
      legs_clear: eff.legsClear,
      extracted: eff.extracted.length,
      majority_overrides: eff.majorityOverrides,
      warnings: outcome.warnings,
      // The whole validated document: the store keeps what the file says (fold row 4, codex F7).
      document: a,
    });
    if (a.needs_ruling) insertEvent(db, 'needs-ruling', roundId, { rulings: a.findings.filter((f) => f.outcome === 'ruling').map((f) => f.id) });
    writeAtomic(join(roundDirOf(layout, facts.roundId), 'ADJUDICATION.json'), text.endsWith('\n') ? text : `${text}\n`);
    commit();
  } catch (error) {
    if (open) db.exec('ROLLBACK');
    throw error;
  }
  // The root is deleted at round end (plan 5.4), by its name under the layout's roots dir only (fold row 1); the
  // round dir keeps the brief, the legs and the adjudication.
  removeRoundRoots(layout, roundId);
  return { outcome, roundId, stored: true };
}
