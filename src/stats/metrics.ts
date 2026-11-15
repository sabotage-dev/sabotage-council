import { QUORUM } from '../config/vocab.js';
import type { LegVerdict, StatsData, StatsFinding, StatsLeg, StatsRound } from './data.js';

/*
 * The scorecard metrics (plan 8.2), per seat and per occupant. Each metric's definition sits beside it; the README's
 * stats section repeats them. A subject is a seat id or an occupant; a fallback leg belongs to its seat (seat_id) and
 * to its own occupant (occupant_id), so it counts for both, and never for the seat's primary occupant.
 *
 * An occupant can hold two seats in one round (two kiro seats on one model with two logins share an occupant row): its
 * card counts every ratified leg of it in the round (verdicts, durations, findings), and a finding raised by both legs
 * is one finding, unique to the occupant when no other occupant raised it. Its position in that round (dissent,
 * agreement) is the one its legs share; when they differ (one NEEDS-WORK, one not) it has no position in that round.
 */

export type Subject = { kind: 'seat'; seat: string } | { kind: 'occupant'; occupantId: number };

/** A ratio, or null when its denominator is 0 (never a silent 0 or 100%). */
export function rate(n: number, d: number): number | null {
  return d > 0 ? n / d : null;
}

/** Nearest-rank percentile (p in 0..100) of a list of numbers; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] ?? null;
}

// ---- finding outcomes (plan 3.3) ----

/**
 * Adopted (plan 8.2): owed, follow-up, or a ruling the user upheld. A nit or a noted finding is neither adopted nor
 * refuted: it stays out of precision.
 */
export function isAdopted(f: Pick<StatsFinding, 'outcome' | 'rulingResult'>): boolean {
  return f.outcome === 'owed' || f.outcome === 'follow-up' || (f.outcome === 'ruling' && f.rulingResult === 'upheld');
}

/**
 * Refuted: the adjudicator refuted it with proof, or the user overturned it as a ruling (plan 3.8: an overturned
 * ruling is refuted). A ruling not yet ruled on is pending: neither adopted nor refuted, and out of precision until
 * the user rules.
 */
export function isRefuted(f: Pick<StatsFinding, 'outcome' | 'rulingResult'>): boolean {
  return f.outcome === 'refuted' || (f.outcome === 'ruling' && f.rulingResult === 'overturned');
}

export function isPendingRuling(f: Pick<StatsFinding, 'outcome' | 'rulingResult'>): boolean {
  return f.outcome === 'ruling' && f.rulingResult === null;
}

/** Owed: owed by the adjudicator, or a ruling the user upheld (plan 3.8: an upheld ruling is owed). */
export function isOwed(f: Pick<StatsFinding, 'outcome' | 'rulingResult'>): boolean {
  return f.outcome === 'owed' || (f.outcome === 'ruling' && f.rulingResult === 'upheld');
}

/**
 * Blocking: what stands between the round and SHIP. Owed rows, and rulings that still hold (unruled or upheld); an
 * overturned ruling no longer blocks.
 */
export function isBlocking(f: Pick<StatsFinding, 'outcome' | 'rulingResult'>): boolean {
  return f.outcome === 'owed' || (f.outcome === 'ruling' && f.rulingResult !== 'overturned');
}

/** The outcome as the scorecard groups it: a ruling is split by what the user ruled. */
export type OutcomeKey = 'owed' | 'follow-up' | 'nit' | 'refuted' | 'noted' | 'ruling-upheld' | 'ruling-overturned' | 'ruling-pending';
export const OUTCOME_KEYS: readonly OutcomeKey[] = ['owed', 'follow-up', 'nit', 'refuted', 'noted', 'ruling-upheld', 'ruling-overturned', 'ruling-pending'];

export function outcomeKey(f: Pick<StatsFinding, 'outcome' | 'rulingResult'>): OutcomeKey {
  if (f.outcome !== 'ruling') return f.outcome;
  return f.rulingResult === 'upheld' ? 'ruling-upheld' : f.rulingResult === 'overturned' ? 'ruling-overturned' : 'ruling-pending';
}

/**
 * A position on the decision axis of dissent and agreement: NEEDS-WORK vs not (plan 3.2 treats SHIP and
 * SHIP-WITH-FIXES alike; only NEEDS-WORK blocks). The council chose this axis over the plan's earlier SHIP vs not in
 * round 1 of P9, so a SHIP-WITH-FIXES whose findings became follow-ups is not a dissent from two SHIPs.
 */
export type Position = 'blocks' | 'clears';

/** A leg's position from its raw verdict (what the seat said): NEEDS-WORK blocks, SHIP and SHIP-WITH-FIXES clear; `none` has none. */
export function position(v: LegVerdict): Position | null {
  return v === 'none' ? null : v === 'NEEDS-WORK' ? 'blocks' : 'clears';
}

/**
 * The round's final position, ruling-aware: it clears when nothing blocks (a SHIP-WITH-FIXES with no owed row reads as
 * SHIP, plan 3.2), and blocks while any owed row or holding ruling remains.
 */
export function finalPosition(r: StatsRound): Position {
  return r.findings.some(isBlocking) ? 'blocks' : 'clears';
}

// ---- the card ----

export const FAILURE_CLASS_ORDER = ['usage_limit', 'auth', 'capacity', 'transport', 'model', 'timeout', 'empty', 'contaminated', 'setup'] as const;

export interface Card {
  /** Settled rounds in which the subject had at least one settled leg (a launch, or a primary that failed preflight). */
  rounds_seated: number;
  /** Seated rounds in which one of its legs ratified (status PASS). */
  rounds_ratified: number;
  /** rounds_ratified / rounds_seated (failed and solo rounds count). */
  ratified_rate: number | null;
  /** Adjudicated rounds in which it ratified: the rounds every finding metric stands on. */
  adjudicated_ratified: number;
  failures: {
    /** Settled legs of the subject: every attempt, primary and fallback. */
    legs: number;
    /** Legs that did not ratify. */
    failed_legs: number;
    /** Failed legs per failure class (plan 4.4); a REFUSED duplicate-occupant leg is `setup`. */
    by_class: Record<string, number>;
    /**
     * Seat: seated rounds in which the seat moved to its fallback (it had a `fallback` leg). Occupant: rounds in which
     * it sat as a primary and its seat moved to the fallback, over the rounds it sat as a primary.
     */
    fallback_used_rounds: number;
    fallback_used_rate: number | null;
    /** Occupant only: rounds it sat in as a seat's fallback. */
    as_fallback_rounds: number | null;
    /**
     * Seated rounds with a relaunch: a leg with attempt >= 2 (the same seat and role launched again, plan 3.1 step 6).
     * A fallback is a `fallback` leg at attempt 1, so the two are told apart by role and attempt; a fallback's own
     * relaunch is both.
     */
    relaunch_rounds: number;
    relaunch_rate: number | null;
  };
  /** Raw verdict of each ratified leg (what the seat said, before adjudication). */
  verdicts: Record<LegVerdict, number>;
  findings: {
    /** Canonical findings (adjudicated rounds) the subject raised, each counted once however many leg findings map to it. */
    raised: number;
    adopted: number;
    refuted: number;
    /** Rulings not yet ruled on. */
    pending: number;
    by_outcome: Record<OutcomeKey, number>;
    /** adopted / (adopted + refuted); null when both are 0. */
    precision: number | null;
    /** Its leg findings the adjudicator left unmapped (not a finding of the round). */
    unmapped: number;
  };
  unique: {
    /**
     * Findings it raised alone: every source leg is the subject's. Uniqueness counts raisers, not severities: a finding
     * two seats raised at different severities is unique to neither.
     */
    raised: number;
    adopted: number;
    owed: number;
    /** Unique, adopted, and HIGH by the adjudicator's final severity (a seat's own HIGH label earns nothing). */
    high: number;
  };
  drop_one: {
    /** Adjudicated rounds in which it ratified. */
    rounds: number;
    /** Blocking findings (owed, or a ruling that holds) it raised alone: lost had it been absent. */
    blocking_lost: number;
    /**
     * Rounds whose stored verdict was not SHIP, whose every blocking finding it raised alone, and that would still have
     * had quorum (2 ratified legs) without it: they would have been SHIP. A stored SHIP is never a flip, even with a
     * ruling of its alone held on it (the validator stores SHIP with a held ruling when nothing is owed).
     */
    flipped_to_ship: number;
    flipped_rounds: number[];
    /**
     * Rounds whose other legs had fewer than 2 ratified: without it the round would have been a solo review (never
     * approves) or failed. Never counted as a flip.
     */
    quorum_lost: number;
  };
  dissent: {
    /**
     * Adjudicated rounds where its ratified raw verdict, NEEDS-WORK vs not, differed from the two other ratified legs,
     * which agreed with each other. A `none` verdict has no position; a round with fewer than two other positioned legs
     * has no lone dissent.
     */
    lone: number;
    /**
     * Lone dissents the outcome sided with: a lone NEEDS-WORK (`said: blocks`) when the round ended blocked or one of its
     * own findings was owed; a lone SHIP or SHIP-WITH-FIXES (`said: clears`) when nothing blocked at the end.
     */
    right: number;
    right_rate: number | null;
    rounds: Array<{ round: number; said: Position; right: boolean }>;
  };
  cost: {
    /** Summed over every settled leg of the subject (failed attempts cost too). Units are never converted (Q8). */
    usd: number;
    credits: number;
    legs_with_usd: number;
    legs_with_credits: number;
    /** quota_used_pct is a snapshot of a CLI's own rate window, not additive: the highest and the latest seen. */
    quota_pct_max: number | null;
    quota_pct_last: number | null;
    /** Nearest-rank percentiles over its ratified legs' durations. */
    duration_ms_p50: number | null;
    duration_ms_p90: number | null;
    /**
     * Its legs' USD (credits) in adjudicated rounds / adopted findings in those rounds. Null with nothing adopted, or when
     * none of its legs in an adjudicated round recorded that unit (a cost recorded only outside them never reads as free).
     */
    usd_per_adopted: number | null;
    credits_per_adopted: number | null;
  };
}

function emptyOutcomes(): Record<OutcomeKey, number> {
  return Object.fromEntries(OUTCOME_KEYS.map((k) => [k, 0])) as Record<OutcomeKey, number>;
}

export function matches(subject: Subject, leg: StatsLeg): boolean {
  return subject.kind === 'seat' ? leg.seat === subject.seat : leg.occupantId === subject.occupantId;
}

/** Of a round's blocking findings, those only `mine` (the subject's ratified legs) raised: lost had it been absent. */
function loneBlocking(blocking: readonly StatsFinding[], mine: ReadonlySet<number>): StatsFinding[] {
  return blocking.filter((f) => f.sources.length > 0 && f.sources.every((s) => mine.has(s.legId)));
}

/**
 * The findings `drop_one.blocking_lost` counts, by round id and finding id, in round order: in each adjudicated round
 * the subject ratified in, the blocking findings only it raised.
 */
export function blockingLostOf(data: StatsData, subject: Subject): Array<{ round: number; id: string }> {
  const out: Array<{ round: number; id: string }> = [];
  for (const r of data.rounds) {
    if (!r.adjudicated) continue;
    const mine = new Set(r.legs.filter((l) => matches(subject, l) && l.status === 'PASS').map((l) => l.id));
    if (mine.size === 0) continue;
    for (const f of loneBlocking(r.findings.filter(isBlocking), mine)) out.push({ round: r.id, id: f.id });
  }
  return out;
}

/** The card for one subject over the window's rounds. */
export function cardOf(data: StatsData, subject: Subject): Card {
  const byClass: Record<string, number> = {};
  const verdicts: Record<LegVerdict, number> = { SHIP: 0, 'SHIP-WITH-FIXES': 0, 'NEEDS-WORK': 0, none: 0 };
  const byOutcome = emptyOutcomes();
  const durations: number[] = [];
  let seated = 0;
  let ratified = 0;
  let adjRatified = 0;
  let legsN = 0;
  let failedLegs = 0;
  let fallbackUsed = 0;
  let asPrimary = 0;
  let asFallback = 0;
  let relaunched = 0;
  let raised = 0;
  let unmapped = 0;
  const unique = { raised: 0, adopted: 0, owed: 0, high: 0 };
  let blockingLost = 0;
  const flipped: number[] = [];
  let quorumLost = 0;
  const dissents: Card['dissent']['rounds'] = [];
  let usd = 0;
  let credits = 0;
  let usdLegs = 0;
  let creditLegs = 0;
  let usdAdj = 0;
  let creditsAdj = 0;
  let usdAdjLegs = 0;
  let creditsAdjLegs = 0;
  let adoptedAll = 0;
  let quotaMax: number | null = null;
  let quotaLast: { id: number; pct: number } | null = null;

  for (const r of data.rounds) {
    const legs = r.legs.filter((l) => matches(subject, l));
    if (legs.length === 0) continue;
    seated += 1;
    // Every ratified leg of the subject in the round: one for a seat, two for an occupant that held two seats.
    const passes = legs.filter((l) => l.status === 'PASS');
    if (passes.length > 0) ratified += 1;
    for (const l of legs) {
      legsN += 1;
      if (l.status !== 'PASS') {
        failedLegs += 1;
        const cls = l.failureClass ?? 'unclassified';
        byClass[cls] = (byClass[cls] ?? 0) + 1;
      }
      if (l.costUsd !== null) {
        usd += l.costUsd;
        usdLegs += 1;
        if (r.adjudicated) {
          usdAdj += l.costUsd;
          usdAdjLegs += 1;
        }
      }
      if (l.credits !== null) {
        credits += l.credits;
        creditLegs += 1;
        if (r.adjudicated) {
          creditsAdj += l.credits;
          creditsAdjLegs += 1;
        }
      }
      if (l.quotaPct !== null) {
        quotaMax = quotaMax === null ? l.quotaPct : Math.max(quotaMax, l.quotaPct);
        if (quotaLast === null || l.id > quotaLast.id) quotaLast = { id: l.id, pct: l.quotaPct };
      }
    }
    if (subject.kind === 'seat') {
      if (legs.some((l) => l.role === 'fallback')) fallbackUsed += 1;
    } else {
      const primarySeats = new Set(legs.filter((l) => l.role === 'primary').map((l) => l.seat));
      if (primarySeats.size > 0) {
        asPrimary += 1;
        if (r.legs.some((l) => primarySeats.has(l.seat) && l.role === 'fallback')) fallbackUsed += 1;
      }
      if (legs.some((l) => l.role === 'fallback')) asFallback += 1;
    }
    if (legs.some((l) => l.attempt >= 2)) relaunched += 1;
    if (passes.length === 0) continue;
    for (const p of passes) {
      verdicts[p.verdictRaw] += 1;
      if (p.durationMs !== null) durations.push(p.durationMs);
    }
    if (!r.adjudicated) continue;
    // Before adjudication no leg finding is mapped yet: only an adjudicated round's unmapped ones mean anything.
    for (const p of passes) unmapped += p.unmapped;

    // ---- adjudicated rounds it ratified in: findings, drop-one, dissent ----
    adjRatified += 1;
    const mine = new Set(passes.map((p) => p.id));
    const others = r.legs.filter((l) => l.status === 'PASS' && !matches(subject, l));
    for (const f of r.findings) {
      if (!f.sources.some((s) => mine.has(s.legId))) continue;
      raised += 1;
      byOutcome[outcomeKey(f)] += 1;
      if (isAdopted(f)) adoptedAll += 1;
      if (!f.sources.every((s) => mine.has(s.legId))) continue;
      unique.raised += 1;
      if (isAdopted(f)) unique.adopted += 1;
      if (isOwed(f)) unique.owed += 1;
      if (isAdopted(f) && f.severity === 'HIGH') unique.high += 1;
    }
    const blocking = r.findings.filter(isBlocking);
    const lost = loneBlocking(blocking, mine);
    blockingLost += lost.length;
    if (others.length < QUORUM) quorumLost += 1;
    else if (r.verdict !== 'SHIP' && blocking.length > 0 && lost.length === blocking.length) flipped.push(r.id);

    const said = sharedPosition(passes);
    const otherPositions = others.map((l) => position(l.verdictRaw)).filter((p): p is Position => p !== null);
    if (said !== null && otherPositions.length >= 2 && otherPositions.every((p) => p === otherPositions[0]) && otherPositions[0] !== said) {
      const end = finalPosition(r);
      const ownOwed = r.findings.some((f) => isOwed(f) && f.sources.some((s) => mine.has(s.legId)));
      const right = said === 'clears' ? end === 'clears' : end === 'blocks' || ownOwed;
      dissents.push({ round: r.id, said, right });
    }
  }

  const adopted = byOutcome['owed'] + byOutcome['follow-up'] + byOutcome['ruling-upheld'];
  const refuted = byOutcome['refuted'] + byOutcome['ruling-overturned'];
  const rightN = dissents.filter((d) => d.right).length;
  return {
    rounds_seated: seated,
    rounds_ratified: ratified,
    ratified_rate: rate(ratified, seated),
    adjudicated_ratified: adjRatified,
    failures: {
      legs: legsN,
      failed_legs: failedLegs,
      by_class: byClass,
      fallback_used_rounds: fallbackUsed,
      fallback_used_rate: subject.kind === 'seat' ? rate(fallbackUsed, seated) : rate(fallbackUsed, asPrimary),
      as_fallback_rounds: subject.kind === 'seat' ? null : asFallback,
      relaunch_rounds: relaunched,
      relaunch_rate: rate(relaunched, seated),
    },
    verdicts,
    findings: { raised, adopted, refuted, pending: byOutcome['ruling-pending'], by_outcome: byOutcome, precision: rate(adopted, adopted + refuted), unmapped },
    unique,
    drop_one: { rounds: adjRatified, blocking_lost: blockingLost, flipped_to_ship: flipped.length, flipped_rounds: flipped, quorum_lost: quorumLost },
    dissent: { lone: dissents.length, right: rightN, right_rate: rate(rightN, dissents.length), rounds: dissents },
    cost: {
      usd,
      credits,
      legs_with_usd: usdLegs,
      legs_with_credits: creditLegs,
      quota_pct_max: quotaMax,
      quota_pct_last: (quotaLast as { pct: number } | null)?.pct ?? null,
      duration_ms_p50: percentile(durations, 50),
      duration_ms_p90: percentile(durations, 90),
      usd_per_adopted: usdAdjLegs > 0 && adoptedAll > 0 ? usdAdj / adoptedAll : null,
      credits_per_adopted: creditsAdjLegs > 0 && adoptedAll > 0 ? creditsAdj / adoptedAll : null,
    },
  };
}

/** The position a subject's ratified legs in one round share; null when none has one or two of them differ. */
function sharedPosition(legs: readonly StatsLeg[]): Position | null {
  const own = legs.map((l) => position(l.verdictRaw)).filter((p): p is Position => p !== null);
  const first = own[0];
  return first !== undefined && own.every((p) => p === first) ? first : null;
}

// ---- agreement (plan 8.2) ----

export interface AgreementPair {
  a: string;
  b: string;
  /** Settled rounds where both had a ratified leg with a verdict. */
  rounds: number;
  /** Of those, rounds where one said NEEDS-WORK and the other did not. */
  disagree: number;
  disagree_rate: number | null;
  /** They agreed in every shared round: two such seats behave as one. */
  always_agree: boolean;
}

/** Pairwise NEEDS-WORK-vs-not disagreement (raw verdicts) between seats (or occupants), over every settled round both ratified in. */
export function agreementOf(data: StatsData, kind: 'seat' | 'occupant'): AgreementPair[] {
  const pairs = new Map<string, { a: string; b: string; rounds: number; disagree: number }>();
  const keyOf = (l: StatsLeg): string => (kind === 'seat' ? l.seat : String(l.occupantId));
  for (const r of data.rounds) {
    // One position per key: an occupant whose two legs in the round differ has none there, and is left out of its pairs.
    const legsOf = new Map<string, StatsLeg[]>();
    for (const l of r.legs) if (l.status === 'PASS') legsOf.set(keyOf(l), [...(legsOf.get(keyOf(l)) ?? []), l]);
    const pos = new Map<string, Position>();
    for (const [key, legs] of legsOf) {
      const p = sharedPosition(legs);
      if (p !== null) pos.set(key, p);
    }
    const keys = [...pos.keys()].sort(compareKeys);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i] as string;
        const b = keys[j] as string;
        const id = `${a}\n${b}`;
        const pair = pairs.get(id) ?? { a, b, rounds: 0, disagree: 0 };
        pair.rounds += 1;
        if (pos.get(a) !== pos.get(b)) pair.disagree += 1;
        pairs.set(id, pair);
      }
    }
  }
  return [...pairs.values()]
    .sort((x, y) => compareKeys(x.a, y.a) || compareKeys(x.b, y.b))
    .map((p) => ({ ...p, disagree_rate: rate(p.disagree, p.rounds), always_agree: p.rounds > 0 && p.disagree === 0 }));
}

/** Numeric keys (occupant ids) in number order, others in text order. */
function compareKeys(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
