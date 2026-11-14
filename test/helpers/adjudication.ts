import { findingIdOf } from '../../src/adjudicate/index.js';
import type { RoundSummary } from '../../src/engine/index.js';

/*
 * A valid ADJUDICATION.json for a settled round, built from its summary: every counted leg's findings clustered into
 * one canonical finding (an extracted X1 for a leg whose block needs extraction), every open earlier item closed with
 * evidence, every human ask with its own row, and the effective leg verdicts that follow (plan 3.2).
 */

export interface AdjOptions {
  /** The canonical finding's outcome. */
  outcome: 'owed' | 'refuted' | 'follow-up';
  verdict: 'SHIP' | 'SHIP-WITH-FIXES' | 'NEEDS-WORK';
  approve: boolean;
  needsRuling?: boolean | undefined;
  /** The asks of the round (H1, H2, ...), each closed or open. */
  asks?: Array<'closed' | 'open'> | undefined;
  /** Text for the summary (to test what the body does with it). */
  summary?: string | undefined;
}

const RANK = { NIT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

export function adjudicationFromSummary(s: RoundSummary, o: AdjOptions): Record<string, unknown> {
  const counted = s.legs.filter((l) => l.counted);
  const raisedBy: Array<{ seat: string; leg_finding: string; severity: keyof typeof RANK }> = [];
  for (const l of counted) {
    if (l.findings_extracted_by === 'adjudicator-needed') raisedBy.push({ seat: l.seat, leg_finding: 'X1', severity: 'HIGH' });
    else for (const f of l.findings) raisedBy.push({ seat: l.seat, leg_finding: f.id, severity: f.severity as keyof typeof RANK });
  }
  const severity = raisedBy.reduce<keyof typeof RANK>((m, r) => (RANK[r.severity] > RANK[m] ? r.severity : m), 'LOW');
  const title = 'the replayed finding';
  const path = 'sabotage-council/src/config/rules.ts';
  const findings: Array<Record<string, unknown>> = [];
  if (raisedBy.length > 0) {
    findings.push({
      id: findingIdOf(s.target_key, path, title),
      title,
      path,
      line: 1,
      severity,
      outcome: o.outcome,
      owner: 'this',
      proof: 'sabotage-council/src/config/rules.ts:1 checked against the root',
      kind: 'finding',
      raised_by: raisedBy,
      same_as: null,
      closes_item: null,
    });
  }
  const asks = (o.asks ?? []).map((status, i) => {
    const id = `H${i + 1}`;
    const fid = findingIdOf(s.target_key, null, `ask ${id}`);
    findings.push({
      id: fid,
      title: `ask ${id}`,
      path: null,
      line: null,
      severity: 'MEDIUM',
      outcome: status === 'open' ? 'owed' : 'noted',
      owner: 'this',
      proof: 'sabotage-council/src/config/rules.ts:1 shows it',
      kind: 'human_ask',
      raised_by: [],
      same_as: null,
      closes_item: null,
    });
    return { id, status, evidence: 'sabotage-council/src/config/rules.ts:1', fix_row: fid };
  });
  const blocking = o.outcome === 'owed';
  return {
    nonce: s.nonce,
    head_sha: s.head_sha,
    round: s.round_no,
    verdict: o.verdict,
    approve: o.approve,
    needs_ruling: o.needsRuling ?? false,
    reason: 'replayed legs',
    findings,
    unmapped: [],
    earlier_items: s.earlier_items.filter((i) => !i.closed_context).map((i) => ({ source: i.id, status: 'closed', evidence: 'sabotage-council/src/config/rules.ts:1 closes it', fix_row: null })),
    human_asks: asks,
    leg_verdicts: counted.map((l) => {
      const raw = l.verdict_raw ?? 'none';
      return { seat: l.seat, raw, effective: raw === 'NEEDS-WORK' && !blocking ? 'SHIP-WITH-FIXES' : raw };
    }),
    not_verified: [],
    followups: o.outcome === 'follow-up' && raisedBy.length > 0 ? [findingIdOf(s.target_key, path, title)] : [],
    summary: o.summary ?? 'The replayed legs, adjudicated.',
    blocker_call: blocking ? 'Fix the replayed finding.' : 'Nothing blocks.',
  };
}
