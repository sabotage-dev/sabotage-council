import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LegReply } from '../parse/index.js';
import type { Store } from '../store/open.js';
import { readRoundInputs, roundDirOf, type DataLayout, type RoundInputs } from '../engine/prepare.js';
import { countedLegs, getRound, insertEvent, now, sha256, type LegRow } from '../engine/records.js';
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

/** The round as the engine recorded it, for the cross-checks. */
export function adjudicationContext(store: Store, layout: DataLayout, roundId: number): { ctx: AdjudicationContext; inputs: RoundInputs; legs: LegRow[] } {
  const round = getRound(store.db, roundId);
  if (!round) throw new AdjudicateError(`no round ${roundId} in the store`);
  const roundDir = roundDirOf(layout, roundId);
  const inputs = readRoundInputs(roundDir);
  const legs = countedLegs(store.db, roundId);
  const known = store.db
    .prepare('SELECT findings.id FROM findings JOIN rounds ON rounds.id = findings.round_id WHERE rounds.target_id = ? AND rounds.id <> ?')
    .all(round.target_id, roundId) as Array<{ id: string }>;
  const ctx: AdjudicationContext = {
    roundNo: round.round_no,
    nonce: round.nonce ?? '',
    headSha: round.head_sha,
    mode: round.mode as AdjudicationContext['mode'],
    rule: inputs.rule,
    targetKey: inputs.targetKey,
    legs: legs.map((l) => {
      const reply = readReply(legDirOf(roundDir, l));
      const f = reply?.findings;
      return {
        seat: l.seat_id,
        verdictRaw: (l.verdict_raw ?? 'none') as LegVerdict,
        findings: f?.extracted_by === 'leg' ? f.findings.map((x) => ({ id: x.id, severity: x.severity })) : null,
      };
    }),
    earlierItems: inputs.earlierItems.map((i) => ({ id: i.id, severity: i.severity, kind: i.kind, closedContext: i.closedContext })),
    humanAsks: inputs.humanAsks,
    knownFindingIds: new Set(known.map((k) => k.id)),
  };
  return { ctx, inputs, legs };
}

export interface AdjudicateResult {
  outcome: ValidationOutcome;
  roundId: number;
  stored: boolean;
}

/**
 * Validates and, when it passes, stores the adjudication. A rejection stores nothing but an event with the errors.
 * Only a round whose legs have settled with at least one ratified leg can be adjudicated, and only once.
 */
export function adjudicate(store: Store, layout: DataLayout, roundId: number, text: string): AdjudicateResult {
  const { db } = store;
  const round = getRound(db, roundId);
  if (!round) throw new AdjudicateError(`no round ${roundId} in the store`);
  if (round.status !== 'awaiting-adjudication') {
    throw new AdjudicateError(`round ${roundId} is ${round.status}; only a round awaiting adjudication can be adjudicated`);
  }
  const { ctx, inputs, legs } = adjudicationContext(store, layout, roundId);
  const outcome = validateAdjudicationText(text, ctx);
  if (!outcome.ok) {
    insertEvent(db, 'adjudication-rejected', roundId, { errors: outcome.errors });
    return { outcome, roundId, stored: false };
  }
  const a = outcome.adjudication;
  const eff = outcome.effective;
  const legBySeat = new Map(legs.map((l) => [l.seat_id, l]));
  const lfId = db.prepare('SELECT id FROM leg_findings WHERE leg_id = ? AND local_id = ?');
  db.exec('BEGIN IMMEDIATE');
  try {
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
    const items = new Map(inputs.earlierItems.map((i) => [i.id, i]));
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
    db.prepare(
      "UPDATE rounds SET verdict = ?, owed_count = ?, approve = ?, needs_ruling = ?, status = 'adjudicated', finished_at = ? WHERE id = ?",
    ).run(eff.verdict, eff.owed, a.approve ? 1 : 0, a.needs_ruling ? 1 : 0, now(), roundId);
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
    });
    if (a.needs_ruling) insertEvent(db, 'needs-ruling', roundId, { rulings: a.findings.filter((f) => f.outcome === 'ruling').map((f) => f.id) });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const roundDir = roundDirOf(layout, roundId);
  writeFileSync(join(roundDir, 'ADJUDICATION.json'), text.endsWith('\n') ? text : `${text}\n`);
  // The root is deleted at round end (plan 5.4); the round dir keeps the brief, the legs and the adjudication.
  rmSync(inputs.root, { recursive: true, force: true });
  rmSync(`${inputs.root}.git`, { recursive: true, force: true });
  return { outcome, roundId, stored: true };
}
