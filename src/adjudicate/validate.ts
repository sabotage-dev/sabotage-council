import type { z } from 'zod';
import type { RoundRule } from '../brief/rules.js';
import type { Severity } from '../parse/severity.js';
import type { Verdict } from '../parse/verdict.js';
import { adjudicationSchema, findingIdOf, type AdjudicatedFinding, type Adjudication, type LegVerdict } from './schema.js';

/*
 * The cross-checks of plan 7.3, enforced by code before anything is stored. Each error starts with its class in
 * brackets, so the main loop (and the tests) can tell which rule a rejection came from.
 */

export const CHECK_CLASSES = [
  'json',
  'schema',
  'identity',
  'ids',
  'attribution',
  'verdict',
  'severity',
  'owner',
  'round-rule',
  'effective',
  'coverage',
  'human-asks',
  'refutation',
  'approval',
  'followups',
] as const;
export type CheckClass = (typeof CHECK_CLASSES)[number];

export interface ContextLeg {
  seat: string;
  verdictRaw: LegVerdict;
  /** The leg's own findings block, parsed; null when the block was missing or broken and the adjudicator extracts. */
  findings: ReadonlyArray<{ id: string; severity: Severity }> | null;
}

export interface ContextItem {
  id: string;
  severity: Severity;
  kind: 'finding' | 'human_ask';
  closedContext: boolean;
}

/** What the adjudication is checked against: the round as the engine recorded it. */
export interface AdjudicationContext {
  roundNo: number;
  nonce: string;
  headSha: string;
  mode: 'plan' | 'diff' | 'pr' | 'auto';
  rule: RoundRule;
  targetKey: string;
  /** The ratified legs, one per seat (the ones that count toward quorum). */
  legs: readonly ContextLeg[];
  earlierItems: readonly ContextItem[];
  /** The asks of the reviewer's open change request, H1.. in order. */
  humanAsks: readonly string[];
  /** Finding ids of the target's earlier rounds, for `same_as`. */
  knownFindingIds: ReadonlySet<string>;
}

export interface ExtractedLegFinding {
  seat: string;
  legFinding: string;
  severity: Severity;
  findingId: string;
}

export interface EffectiveResult {
  /** The round verdict as recorded: SHIP-WITH-FIXES with 0 owed rows reads as SHIP (plan 3.2). */
  verdict: Verdict;
  owed: number;
  legVerdicts: Record<string, LegVerdict>;
  legsClear: boolean;
  /** Findings of legs whose block the adjudicator extracted (`extracted_by: adjudicator`, plan 3.9). */
  extracted: ExtractedLegFinding[];
  /**
   * Majority overrides (3.4 rule 3, fold row 8): findings raised by two or more seats, owed at the seats' severity,
   * that the adjudication refutes, makes non-blocking, or lowers. Each carries its proof, to show the user first.
   */
  majorityOverrides: Array<{ id: string; seats: number; seatSeverity: Severity; outcome: string; severity: Severity; proof: string }>;
}

export type ValidationOutcome =
  | { ok: true; adjudication: Adjudication; effective: EffectiveResult; warnings: string[] }
  | { ok: false; errors: string[] };

const RANK: Readonly<Record<Severity, number>> = { NIT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

/**
 * Whether a finding would be owed under the round's rule if true (plan 3.4 rule 3, 3.5): a human ask always; from
 * round 4 (D5) only HIGH; otherwise anything but a NIT.
 */
export function owedEligible(f: { severity: Severity; kind: 'finding' | 'human_ask' }, rule: RoundRule): boolean {
  if (f.kind === 'human_ask') return true;
  if (rule === 'high-only') return f.severity === 'HIGH';
  return f.severity !== 'NIT';
}

/**
 * A leg's effective verdict (plan 3.2): its NEEDS-WORK holds only while one of its own findings is still blocking
 * (owed, or a ruling on an owed-eligible finding); otherwise it reads as SHIP-WITH-FIXES. Other verdicts stand.
 */
export function effectiveLegVerdict(
  raw: LegVerdict,
  mapped: ReadonlyArray<Pick<AdjudicatedFinding, 'severity' | 'outcome' | 'kind'>>,
  rule: RoundRule,
): LegVerdict {
  if (raw !== 'NEEDS-WORK') return raw;
  const blocking = mapped.some((f) => f.outcome === 'owed' || (f.outcome === 'ruling' && owedEligible(f, rule)));
  return blocking ? 'NEEDS-WORK' : 'SHIP-WITH-FIXES';
}

/** Legs clear (plan 3.2): two ratified legs at exactly SHIP, or two at SHIP/SWF with none at NEEDS-WORK. */
export function legsClear(effective: readonly LegVerdict[]): boolean {
  const ship = effective.filter((v) => v === 'SHIP').length;
  const swf = effective.filter((v) => v === 'SHIP-WITH-FIXES').length;
  const nw = effective.filter((v) => v === 'NEEDS-WORK').length;
  return ship >= 2 || (ship + swf >= 2 && nw === 0);
}

function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => {
    const where = i.path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '');
    if (i.code === 'unrecognized_keys') return `[schema] ${where === '' ? '(top)' : where}: unknown key(s) ${i.keys.join(', ')}`;
    return `[schema] ${where === '' ? '(top)' : where}: ${i.message}`;
  });
}

/** Parses and validates `ADJUDICATION.json` text against the round. */
export function validateAdjudicationText(text: string, ctx: AdjudicationContext): ValidationOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`[json] not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateAdjudication(raw, ctx);
}

export function validateAdjudication(raw: unknown, ctx: AdjudicationContext): ValidationOutcome {
  const parsed = adjudicationSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
  const a = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (cls: CheckClass, message: string): void => {
    errors.push(`[${cls}] ${message}`);
  };

  // Identity.
  if (a.nonce !== ctx.nonce) err('identity', `nonce ${a.nonce} is not this round's (${ctx.nonce})`);
  if (a.head_sha !== ctx.headSha) err('identity', `head_sha ${a.head_sha} is not this round's head (${ctx.headSha})`);
  if (a.round !== ctx.roundNo) err('identity', `round ${a.round} is not this round's number (${ctx.roundNo})`);

  // Finding ids: unique, stable (target + path + normalized title), and links that resolve.
  const byId = new Map<string, AdjudicatedFinding>();
  const itemIds = new Set(ctx.earlierItems.map((i) => i.id));
  for (const f of a.findings) {
    if (byId.has(f.id)) err('ids', `finding id ${f.id} appears twice`);
    byId.set(f.id, f);
    const expected = findingIdOf(ctx.targetKey, f.path, f.title);
    if (f.id !== expected) err('ids', `finding ${f.id} ("${f.title}") must have the stable id ${expected} (sha256 of target, path and normalized title)`);
    if (f.same_as !== null && (f.same_as === f.id || !ctx.knownFindingIds.has(f.same_as))) {
      err('ids', `finding ${f.id}: same_as ${f.same_as} is not a finding of an earlier round of this target`);
    }
    if (f.closes_item !== null && !itemIds.has(f.closes_item)) err('ids', `finding ${f.id}: closes_item ${f.closes_item} is not an earlier item of this round`);
  }

  // Attribution: every leg finding of a ratified leg is mapped exactly once, in raised_by or in unmapped.
  const legs = new Map(ctx.legs.map((l) => [l.seat, l]));
  const seen = new Map<string, string>();
  const extracted: ExtractedLegFinding[] = [];
  const own = (seat: string, id: string): { severity: Severity } | null | undefined => {
    const leg = legs.get(seat);
    if (!leg) return undefined;
    if (leg.findings === null) return null;
    return leg.findings.find((x) => x.id === id);
  };
  const mapOnce = (seat: string, lf: string, where: string): boolean => {
    if (!legs.has(seat)) {
      err('attribution', `${where}: seat ${seat} has no ratified leg in this round`);
      return false;
    }
    const key = `${seat}/${lf}`;
    const prior = seen.get(key);
    if (prior !== undefined) err('attribution', `${seat} ${lf} is mapped twice (${prior} and ${where})`);
    seen.set(key, where);
    if (own(seat, lf) === undefined) err('attribution', `${where}: seat ${seat} raised no finding ${lf}`);
    return prior === undefined;
  };
  for (const f of a.findings) {
    if (f.kind === 'finding' && f.raised_by.length === 0) err('attribution', `finding ${f.id} names no seat in raised_by`);
    for (const r of f.raised_by) {
      if (!mapOnce(r.seat, r.leg_finding, `finding ${f.id}`)) continue;
      const leg = own(r.seat, r.leg_finding);
      if (leg === null) extracted.push({ seat: r.seat, legFinding: r.leg_finding, severity: r.severity, findingId: f.id });
      else if (leg !== undefined && leg.severity !== r.severity) {
        err('attribution', `finding ${f.id}: ${r.seat} ${r.leg_finding} was raised at ${leg.severity}, not ${r.severity} (raised_by keeps the seat's own severity)`);
      }
    }
  }
  for (const u of a.unmapped) {
    mapOnce(u.seat, u.leg_finding, 'unmapped');
    if (u.reason.trim() === '') err('attribution', `unmapped ${u.seat} ${u.leg_finding} has no reason`);
  }
  for (const leg of ctx.legs) {
    for (const x of leg.findings ?? []) {
      if (!seen.has(`${leg.seat}/${x.id}`)) err('attribution', `seat ${leg.seat}'s finding ${x.id} is not mapped (raised_by of a finding, or unmapped with a reason)`);
    }
  }

  // Severity, owner and the round's rule on owed rows.
  for (const f of a.findings) {
    if (f.outcome !== 'owed') continue;
    if (f.severity === 'NIT') err('severity', `finding ${f.id} is owed at NIT: nits never block (plan 3.5)`);
    if (f.owner !== 'this') err('owner', `finding ${f.id} is owed but its owner is ${f.owner}: a fix in another repository is not owed by this change (plan 3.4 rule 8)`);
    if (ctx.rule === 'high-only' && f.severity !== 'HIGH' && f.kind !== 'human_ask') {
      err('round-rule', `finding ${f.id} is owed at ${f.severity} in round ${ctx.roundNo}: from round 4 only HIGH or a human ask is owed (D5)`);
    }
  }
  for (const f of a.findings) {
    if (f.kind === 'human_ask' && ctx.humanAsks.length === 0) err('human-asks', `finding ${f.id} is a human_ask, but this round has no change request`);
  }

  // Verdict.
  const owed = a.findings.filter((f) => f.outcome === 'owed').length;
  const rulings = a.findings.filter((f) => f.outcome === 'ruling').map((f) => f.id);
  if (a.verdict === 'NEEDS-WORK' && owed === 0) err('verdict', 'NEEDS-WORK with 0 owed rows (plan 3.2)');
  if (a.verdict === 'SHIP' && owed > 0) err('verdict', `SHIP with ${owed} owed row(s)`);
  if (rulings.length > 0 && !a.needs_ruling) err('verdict', `finding(s) ${rulings.join(', ')} are rulings, so needs_ruling must be true (plan 3.8)`);

  // Effective leg verdicts.
  const effective: Record<string, LegVerdict> = {};
  const given = new Map<string, (typeof a.leg_verdicts)[number]>();
  for (const v of a.leg_verdicts) {
    if (given.has(v.seat)) err('effective', `leg_verdicts lists seat ${v.seat} twice`);
    given.set(v.seat, v);
    if (!legs.has(v.seat)) err('effective', `leg_verdicts lists seat ${v.seat}, which has no ratified leg`);
  }
  for (const leg of ctx.legs) {
    const mapped = a.findings.filter((f) => f.raised_by.some((r) => r.seat === leg.seat));
    const want = effectiveLegVerdict(leg.verdictRaw, mapped, ctx.rule);
    effective[leg.seat] = want;
    const v = given.get(leg.seat);
    if (!v) {
      err('effective', `leg_verdicts has no entry for seat ${leg.seat}`);
      continue;
    }
    if (v.raw !== leg.verdictRaw) err('effective', `seat ${leg.seat}: raw verdict ${v.raw} is not the leg's own (${leg.verdictRaw})`);
    if (v.effective !== want) err('effective', `seat ${leg.seat}: effective verdict ${v.effective} should be ${want} from its own mapped findings under this round's rule (plan 3.2)`);
  }
  const clear = legsClear(Object.values(effective));

  // Earlier items: every one but closed context has one row; an owed-eligible item still open names its owed row.
  const items = new Map(ctx.earlierItems.map((i) => [i.id, i]));
  const rows = new Set<string>();
  for (const e of a.earlier_items) {
    const item = items.get(e.source);
    if (!item) {
      err('coverage', `earlier_items row ${e.source} is not an earlier item of this round`);
      continue;
    }
    if (rows.has(e.source)) err('coverage', `earlier item ${e.source} has two rows`);
    rows.add(e.source);
    const fix = e.fix_row === null ? undefined : byId.get(e.fix_row);
    if (e.fix_row !== null && !fix) err('coverage', `earlier item ${e.source}: fix_row ${e.fix_row} is not a finding of this adjudication`);
    if (e.status !== 'closed' && owedEligible(item, ctx.rule) && (!fix || (fix.outcome !== 'owed' && fix.outcome !== 'ruling'))) {
      err('coverage', `earlier item ${e.source} is ${e.status} and owed under this round's rule (plan 3.5), so its fix_row must name an owed finding`);
    }
  }
  for (const item of ctx.earlierItems) {
    if (!item.closedContext && !rows.has(item.id)) err('coverage', `earlier item ${item.id} has no row (closed, half-closed or open)`);
  }

  // Human asks: one human_ask row each, every ask covered, open asks owed (Q7: in every round).
  const askIds = ctx.humanAsks.map((_, i) => `H${i + 1}`);
  const askRows = new Map<string, string>();
  for (const h of a.human_asks) {
    if (!askIds.includes(h.id)) {
      err('human-asks', `human_asks row ${h.id} is not an ask of this round's change request`);
      continue;
    }
    if (askRows.has(h.id)) err('human-asks', `ask ${h.id} has two rows`);
    const fix = h.fix_row === null ? undefined : byId.get(h.fix_row);
    if (!fix || fix.kind !== 'human_ask') {
      err('human-asks', `ask ${h.id}: fix_row must name its kind "human_ask" finding row`);
      continue;
    }
    askRows.set(h.id, fix.id);
    if (h.status !== 'closed' && fix.outcome !== 'owed' && fix.outcome !== 'ruling') err('human-asks', `ask ${h.id} is ${h.status}, so its row ${fix.id} must be owed`);
    if (h.status === 'closed' && fix.outcome === 'owed') err('human-asks', `ask ${h.id} is closed, but its row ${fix.id} is owed`);
  }
  for (const id of askIds) if (!askRows.has(id)) err('human-asks', `ask ${id} has no human_asks row`);
  const askFindings = a.findings.filter((f) => f.kind === 'human_ask').map((f) => f.id);
  const linked = [...askRows.values()];
  for (const id of askFindings) {
    const n = linked.filter((x) => x === id).length;
    if (n !== 1 && ctx.humanAsks.length > 0) err('human-asks', `human_ask row ${id} is named by ${n} asks, not exactly one`);
  }

  // Refutations need proof. And a majority override (plan 3.4 rule 3, fold row 8): a finding raised by two or more
  // seats, owed under this round's rule at the severity the seats gave it, that the adjudicator does not keep as
  // owed (refuted, follow-up, noted, nit) or keeps at a lower severity. It needs recorded proof; in auto it is a
  // ruling; interactively the user sees the proof before the storing call (`adjudicate --check`).
  const majorityOverrides: Array<{ id: string; seats: number; seatSeverity: Severity; outcome: string; severity: Severity; proof: string }> = [];
  for (const f of a.findings) {
    if (f.outcome === 'refuted' && f.proof.trim().length < 10) err('refutation', `finding ${f.id} is refuted without proof (file:line or command output)`);
    const seats = new Set(f.raised_by.map((r) => r.seat));
    if (seats.size < 2) continue;
    const seatSeverity = f.raised_by.map((r) => r.severity).reduce((m, x) => (RANK[x] > RANK[m] ? x : m), 'NIT' as Severity);
    if (!owedEligible({ severity: seatSeverity, kind: f.kind }, ctx.rule)) continue;
    const kept = f.outcome === 'owed' || f.outcome === 'ruling';
    if (kept && RANK[f.severity] >= RANK[seatSeverity]) continue;
    majorityOverrides.push({ id: f.id, seats: seats.size, seatSeverity, outcome: f.outcome, severity: f.severity, proof: f.proof });
    if (f.proof.trim().length < 10) {
      err('refutation', `finding ${f.id} overrides a majority (${seats.size} seats, up to ${seatSeverity}) as ${f.outcome} at ${f.severity} with no recorded proof`);
    }
    if (ctx.mode === 'auto' && !a.needs_ruling) {
      err('refutation', `finding ${f.id} was raised by ${seats.size} seats (up to ${seatSeverity}) and is ${f.outcome} at ${f.severity}: in auto that is a ruling (needs_ruling must be true)`);
    }
  }
  if (ctx.mode !== 'auto') {
    for (const o of majorityOverrides) {
      warnings.push(`finding ${o.id} overrides a majority (${o.seats} seats, up to ${o.seatSeverity}) as ${o.outcome} at ${o.severity}: show the user the proof before storing (plan 3.4 rule 3)`);
    }
  }

  // Approval guard.
  if (a.approve) {
    if (a.needs_ruling || rulings.length > 0) err('approval', 'approve is true while a ruling is needed');
    if (owed > 0 || a.verdict === 'NEEDS-WORK') err('approval', `approve is true with verdict ${a.verdict} and ${owed} owed row(s)`);
    if (ctx.legs.length < 2) err('approval', 'approve is true on a solo review: a solo review never approves (plan 3.1 step 8)');
    else if (!clear) err('approval', 'approve is true but the legs are not clear: two ratified legs at SHIP, or two at SHIP/SWF with none at NEEDS-WORK (plan 3.2)');
  }

  // Follow-ups: every follow-up row listed; only follow-up and nit rows.
  const fu = new Set<string>();
  for (const id of a.followups) {
    const f = byId.get(id);
    if (fu.has(id)) err('followups', `followups lists ${id} twice`);
    fu.add(id);
    if (!f) err('followups', `followups lists ${id}, which is not a finding`);
    else if (f.outcome !== 'follow-up' && f.outcome !== 'nit') err('followups', `followups lists ${id}, whose outcome is ${f.outcome}`);
  }
  for (const f of a.findings) if (f.outcome === 'follow-up' && !fu.has(f.id)) err('followups', `follow-up ${f.id} is missing from followups`);

  if (errors.length > 0) return { ok: false, errors };
  const verdict: Verdict = a.verdict === 'SHIP-WITH-FIXES' && owed === 0 ? 'SHIP' : a.verdict;
  return { ok: true, adjudication: a, effective: { verdict, owed, legVerdicts: effective, legsClear: clear, extracted, majorityOverrides }, warnings };
}
