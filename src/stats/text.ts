import type { Card } from './metrics.js';
import { FAILURE_CLASS_ORDER } from './metrics.js';
import type { AgreementPair } from './metrics.js';
import type { Recommendation, StatsReport } from './report.js';

/*
 * The text form of the scorecard (`stats` with no --json). Values that came from a round (targets, finding titles,
 * paths, model names) are printed with control characters replaced, so a hostile title cannot move the cursor or
 * forge lines in a terminal.
 */

/** Control characters (C0 but tab, DEL, C1) and line separators replaced by U+FFFD: one value stays one line. */
export function clean(text: string): string {
  return text.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g, '\uFFFD');
}

export const pctText = (x: number | null): string => (x === null ? 'n/a' : `${Math.round(x * 1000) / 10}%`);

export function durationText(ms: number | null): string {
  if (ms === null) return 'n/a';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 120_000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms / 6000) / 10} min`;
}

export const money = (usd: number): string => `$${usd.toFixed(usd >= 10 ? 2 : 4)}`;

export function failureMixText(c: Card): string {
  const known = FAILURE_CLASS_ORDER.filter((k) => (c.failures.by_class[k] ?? 0) > 0).map((k) => `${k} ${c.failures.by_class[k]}`);
  const other = Object.keys(c.failures.by_class)
    .filter((k) => !(FAILURE_CLASS_ORDER as readonly string[]).includes(k))
    .sort()
    .map((k) => `${clean(k)} ${c.failures.by_class[k]}`);
  return [...known, ...other].join(', ') || 'none';
}

export function costText(c: Card): string {
  const parts: string[] = [];
  if (c.cost.legs_with_usd > 0) parts.push(`${money(c.cost.usd)} over ${c.cost.legs_with_usd} leg(s)`);
  if (c.cost.legs_with_credits > 0) parts.push(`${Math.round(c.cost.credits * 1000) / 1000} credits over ${c.cost.legs_with_credits} leg(s)`);
  if (c.cost.quota_pct_max !== null) parts.push(`quota max ${c.cost.quota_pct_max}%, last ${c.cost.quota_pct_last ?? 'n/a'}%`);
  return parts.join('; ') || 'none recorded';
}

export function perAdoptedText(c: Card): string {
  const parts: string[] = [];
  if (c.cost.usd_per_adopted !== null) parts.push(money(c.cost.usd_per_adopted));
  if (c.cost.credits_per_adopted !== null) parts.push(`${Math.round(c.cost.credits_per_adopted * 1000) / 1000} credits`);
  return parts.join(', ') || 'n/a';
}

function cardLines(c: Card): string[] {
  const v = c.verdicts;
  return [
    `  rounds    seated ${c.rounds_seated}, ratified ${c.rounds_ratified} (${pctText(c.ratified_rate)}); ${c.adjudicated_ratified} adjudicated`,
    `  failures  ${failureMixText(c)}; fallback used ${c.failures.fallback_used_rounds} (${pctText(c.failures.fallback_used_rate)})${c.failures.as_fallback_rounds !== null ? `, sat as a fallback ${c.failures.as_fallback_rounds}` : ''}; relaunched ${c.failures.relaunch_rounds} (${pctText(c.failures.relaunch_rate)})`,
    `  verdicts  SHIP ${v.SHIP}, SWF ${v['SHIP-WITH-FIXES']}, NW ${v['NEEDS-WORK']}, none ${v.none}`,
    `  findings  raised ${c.findings.raised}, adopted ${c.findings.adopted}, refuted ${c.findings.refuted}${c.findings.pending > 0 ? `, ruling pending ${c.findings.pending}` : ''}; precision ${pctText(c.findings.precision)}${c.findings.unmapped > 0 ? `; ${c.findings.unmapped} unmapped` : ''}`,
    `  unique    raised ${c.unique.raised}, adopted ${c.unique.adopted}, owed ${c.unique.owed}, HIGH ${c.unique.high}`,
    `  drop-one  blocking lost ${c.drop_one.blocking_lost}, flipped to SHIP ${c.drop_one.flipped_to_ship}${c.drop_one.flipped_rounds.length > 0 ? ` (rounds ${c.drop_one.flipped_rounds.join(', ')})` : ''}, quorum lost ${c.drop_one.quorum_lost} (of ${c.drop_one.rounds} adjudicated)`,
    `  dissent   lone ${c.dissent.lone}, right ${c.dissent.right} (${pctText(c.dissent.right_rate)})`,
    `  cost      ${costText(c)}; duration p50 ${durationText(c.cost.duration_ms_p50)}, p90 ${durationText(c.cost.duration_ms_p90)}; per adopted finding ${perAdoptedText(c)}`,
  ];
}

function matrixLines(pairs: readonly AgreementPair[]): string[] {
  if (pairs.length === 0) return ['  no two ratified with a verdict in the same round'];
  return pairs.map(
    (p) => `  ${clean(p.a)}  vs  ${clean(p.b)}: disagree ${p.disagree} of ${p.rounds} (${pctText(p.disagree_rate)})${p.always_agree ? '  always agree' : ''}`,
  );
}

export function recommendationLines(r: Recommendation): string[] {
  const head = r.swap_candidate ? `  seat ${clean(r.seat)}: SWAP CANDIDATE` : `  seat ${clean(r.seat)}: keep${r.eligible ? '' : ' (not enough rounds yet)'}`;
  const lines = [head, ...r.reasons.map((x) => `    - ${clean(x)}`)];
  if (r.evidence) {
    lines.push('    rounds:');
    for (const e of r.evidence.rounds) {
      lines.push(
        `      #${e.round} ${clean(e.target)} round ${e.round_no} ${e.started_at.slice(0, 10)}${e.dry_run ? ' (dry run)' : ''}: ${clean(e.said)}; round verdict ${e.verdict ?? 'not adjudicated'}`,
      );
    }
    lines.push('    findings:');
    if (r.evidence.findings.length === 0) lines.push('      none raised');
    for (const f of r.evidence.findings) {
      const where = f.path === null ? '' : ` ${clean(f.path)}${f.line === null ? '' : `:${f.line}`}`;
      lines.push(`      #${f.round} ${f.id} ${f.severity ?? '-'} ${f.outcome}${f.unique ? ' unique' : ''}${where}: ${clean(f.title)}`);
    }
  }
  return lines;
}

export function renderText(report: StatsReport): string[] {
  const w = report.window;
  const r = w.rounds;
  const out: string[] = report.notes.map((n) => `note  ${clean(n)}`);
  const span = w.first_round_at === null ? '' : ` (rounds from ${w.first_round_at.slice(0, 10)} to ${(w.last_round_at ?? w.first_round_at).slice(0, 10)})`;
  out.push(`sabotage-council stats: ${w.since === null ? 'all history' : `since ${w.since}`}${span}`);
  out.push(
    `rounds: ${r.council} council (${r.settled} settled, ${r.adjudicated} adjudicated, ${r.failed} failed, ${r.awaitingAdjudication} awaiting adjudication, ${r.running} still running, ${r.dryRun} dry run), ${r.identity} identity`,
  );
  if (report.filters.seat !== null || report.filters.occupant !== null) {
    out.push(`filters: ${[report.filters.seat === null ? null : `seat ${clean(report.filters.seat)}`, report.filters.occupant === null ? null : `occupant ${clean(report.filters.occupant)}`].filter((x) => x !== null).join(', ')} (rows shown; every metric still reads every seat's legs)`);
  }
  if (report.message !== null) {
    out.push(report.message);
    return [...out, ...seatTestLines(report)];
  }
  const t = report.thresholds;
  out.push(
    `swap candidate: >= ${t.min_ratified_rounds} adjudicated rounds ratified, 0 unique owed, and precision < ${pctText(t.precision_below)} or ratified rate < ${pctText(t.ratified_rate_below)} (${t.source === 'config' ? 'config [stats]' : 'defaults'})`,
  );
  if (w.adjudicator_usd > 0) out.push(`adjudicator: ${money(w.adjudicator_usd)} (headless runs)`);
  out.push('');
  out.push('seats');
  if (report.seats.length === 0) out.push('  none in the window');
  for (const s of report.seats) {
    out.push(`seat ${clean(s.seat)}  (occupants ${s.occupants.map((id) => `#${id}`).join(', ')})`);
    out.push(...cardLines(s));
  }
  out.push('');
  out.push('occupants');
  if (report.occupants.length === 0) out.push('  none in the window');
  for (const o of report.occupants) {
    out.push(`occupant #${o.occupant.id} ${clean(o.occupant.key)} (${clean(o.occupant.transport)}), seats ${o.seats.map(clean).join(', ')}`);
    out.push(...cardLines(o));
  }
  out.push('');
  out.push('agreement (SHIP vs not, rounds both ratified with a verdict)');
  out.push(...matrixLines(report.agreement.seats));
  if (report.agreement.occupants.length > 0) {
    out.push('agreement by occupant');
    out.push(...matrixLines(report.agreement.occupants));
  }
  out.push('');
  out.push('recommendations (they only inform: nothing swaps a seat by itself)');
  if (report.recommendations.length === 0) out.push('  none');
  for (const rec of report.recommendations) out.push(...recommendationLines(rec));
  return [...out, ...seatTestLines(report)];
}

function seatTestLines(report: StatsReport): string[] {
  if (report.seat_tests.length === 0) return [];
  const out = ['', 'seat tests (never counted above)'];
  for (const t of report.seat_tests) {
    const occ = [t.backend, t.model, t.effort].filter((x) => x !== null).map((x) => clean(String(x))).join(':');
    const cost = [t.cost_usd !== null ? money(t.cost_usd) : null, t.credits !== null ? `${t.credits} credits` : null].filter((x) => x !== null).join(', ');
    out.push(
      `  ${t.ts.slice(0, 19)}Z ${occ}${t.seat !== null ? ` (seat ${clean(t.seat)})` : ''}: ${t.ratified ? 'ratified' : `not ratified (${clean(t.failure_class ?? t.status)})`}, verdict ${clean(t.verdict ?? 'none')}, defects ${t.defects_found.length}/${t.defects_total}${cost !== '' ? `, ${cost}` : ''}, ${durationText(t.duration_ms)}`,
    );
  }
  return out;
}
