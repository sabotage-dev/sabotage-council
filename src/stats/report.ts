import type { StatsConfig } from '../config/schema.js';
import type { RoundCounts, SeatTestRecord, StatsData, StatsOccupant } from './data.js';
import { agreementOf, cardOf, isAdopted, isOwed, isRefuted, outcomeKey, type AgreementPair, type Card, type OutcomeKey } from './metrics.js';

/*
 * The scorecard report: the one structure `stats` prints as text, as JSON (`--json`) and as HTML (`--html`). Its JSON
 * form is versioned (`schema` + `version`); a change that renames, removes or changes the meaning of a field bumps
 * `version`, and a new field may be added within one version. The README's stats section documents every field.
 */

export const STATS_SCHEMA = 'sabotage-council.stats';
export const STATS_VERSION = 1;

export interface Thresholds {
  /** N: adjudicated rounds the seat ratified in before it can be flagged. */
  min_ratified_rounds: number;
  /** P: flagged when unique owed is 0 and precision is below this... */
  precision_below: number;
  /** R: ...or the ratified rate is below this. */
  ratified_rate_below: number;
  /** Where they came from: the config's [stats] section, or the built-in defaults (no config file). */
  source: 'config' | 'defaults';
}

export function thresholdsOf(stats: StatsConfig, source: Thresholds['source']): Thresholds {
  return {
    min_ratified_rounds: stats.swap_min_ratified_rounds,
    precision_below: stats.swap_precision_below,
    ratified_rate_below: stats.swap_ratified_rate_below,
    source,
  };
}

export interface Filters {
  seat: string | null;
  /** `backend:model[:effort]`; with no effort it matches every effort of that model. */
  occupant: string | null;
}

export interface OccupantRef {
  id: number;
  backend: string;
  model: string;
  effort: string | null;
  transport: string;
  key: string;
}

export interface SeatCard extends Card {
  seat: string;
  /** Occupants that sat in this seat in the window, primary and fallback (store ids). */
  occupants: number[];
}

export interface OccupantCard extends Card {
  occupant: OccupantRef;
  /** Seats it sat in during the window. */
  seats: string[];
}

export interface EvidenceRound {
  round: number;
  target: string;
  round_no: number;
  started_at: string;
  dry_run: boolean;
  /** Its legs in the round settled with one ratified. */
  ratified: boolean;
  adjudicated: boolean;
  /** The seat's ratified raw verdict, or why it did not ratify (failure classes of its legs). */
  said: string;
  /** The round's stored verdict (null: not adjudicated). */
  verdict: string | null;
}

export interface EvidenceFinding {
  round: number;
  id: string;
  title: string;
  path: string | null;
  line: number | null;
  severity: string | null;
  outcome: OutcomeKey;
  unique: boolean;
  adopted: boolean;
  refuted: boolean;
  owed: boolean;
}

export interface Recommendation {
  seat: string;
  swap_candidate: boolean;
  /** Enough evidence: adjudicated_ratified >= min_ratified_rounds. */
  eligible: boolean;
  /** Why it is flagged, or why it is not. */
  reasons: string[];
  /** Present when flagged: every round it sat in and every finding it raised in the window. */
  evidence: { rounds: EvidenceRound[]; findings: EvidenceFinding[] } | null;
}

export interface StatsReport {
  schema: typeof STATS_SCHEMA;
  version: typeof STATS_VERSION;
  generated_at: string;
  window: {
    since: string | null;
    first_round_at: string | null;
    last_round_at: string | null;
    rounds: RoundCounts;
    adjudicator_usd: number;
  };
  filters: Filters;
  thresholds: Thresholds;
  /** Set when the window holds no settled council round: nothing to score. */
  message: string | null;
  /** Notes about the read itself (a config warning, no run store yet). */
  notes: string[];
  seats: SeatCard[];
  occupants: OccupantCard[];
  agreement: { seats: AgreementPair[]; occupants: AgreementPair[] };
  recommendations: Recommendation[];
  /** `seats test` runs in the window: never counted in any metric above. */
  seat_tests: SeatTestRecord[];
}

function refOf(o: StatsOccupant): OccupantRef {
  return { id: o.id, backend: o.backend, model: o.model, effort: o.effort, transport: o.transport, key: o.key };
}

/**
 * Whether an occupant matches `--occupant backend:model[:effort]`. With no effort it matches every effort of that
 * model. A model id may hold a `:` itself, so both readings are tried: the whole rest as the model (any effort), and
 * the rest up to its last `:` as the model with the last segment as the effort.
 */
export function occupantMatches(o: Pick<StatsOccupant, 'backend' | 'model' | 'effort'>, spec: string): boolean {
  const at = spec.indexOf(':');
  if (at <= 0 || spec.slice(0, at) !== o.backend) return false;
  const rest = spec.slice(at + 1);
  if (rest === o.model) return true;
  const last = rest.lastIndexOf(':');
  return last > 0 && rest.slice(0, last) === o.model && rest.slice(last + 1) === (o.effort ?? '');
}

export function buildReport(data: StatsData, thresholds: Thresholds, filters: Filters, generatedAt: string = new Date().toISOString()): StatsReport {
  const seatIds = [...new Set(data.rounds.flatMap((r) => r.legs.map((l) => l.seat)))].sort();
  const seatsOf = new Map<number, Set<string>>();
  const occupantsOf = new Map<string, Set<number>>();
  for (const r of data.rounds) {
    for (const l of r.legs) {
      seatsOf.set(l.occupantId, (seatsOf.get(l.occupantId) ?? new Set()).add(l.seat));
      occupantsOf.set(l.seat, (occupantsOf.get(l.seat) ?? new Set()).add(l.occupantId));
    }
  }
  // Filters choose which rows are shown, never which data a metric reads: the drop-one counterfactual, dissent and
  // agreement need every seat's legs.
  const occupantShown = (o: StatsOccupant): boolean => {
    if (filters.occupant !== null && !occupantMatches(o, filters.occupant)) return false;
    if (filters.seat !== null && !(seatsOf.get(o.id)?.has(filters.seat) ?? false)) return false;
    return true;
  };
  const shownOccupants = [...data.occupants.values()].filter(occupantShown).sort((a, b) => a.key.localeCompare(b.key) || a.id - b.id);
  const shownSeats = seatIds.filter((s) => {
    if (filters.seat !== null && s !== filters.seat) return false;
    if (filters.occupant !== null && ![...(occupantsOf.get(s) ?? [])].some((id) => shownOccupants.some((o) => o.id === id))) return false;
    return true;
  });

  const seats: SeatCard[] = shownSeats.map((seat) => ({ seat, occupants: [...(occupantsOf.get(seat) ?? [])].sort((a, b) => a - b), ...cardOf(data, { kind: 'seat', seat }) }));
  const occupants: OccupantCard[] = shownOccupants.map((o) => ({ occupant: refOf(o), seats: [...(seatsOf.get(o.id) ?? [])].sort(), ...cardOf(data, { kind: 'occupant', occupantId: o.id }) }));

  const seatPairs = agreementOf(data, 'seat').filter((p) => shownSeats.includes(p.a) || shownSeats.includes(p.b));
  const shownIds = new Set(shownOccupants.map((o) => String(o.id)));
  const keyOf = (id: string): string => data.occupants.get(Number(id))?.key ?? id;
  const occupantPairs = agreementOf(data, 'occupant')
    .filter((p) => shownIds.has(p.a) || shownIds.has(p.b))
    .map((p) => ({ ...p, a: `${keyOf(p.a)} #${p.a}`, b: `${keyOf(p.b)} #${p.b}` }));

  return {
    schema: STATS_SCHEMA,
    version: STATS_VERSION,
    generated_at: generatedAt,
    window: { since: data.since, first_round_at: data.firstStartedAt, last_round_at: data.lastStartedAt, rounds: data.counts, adjudicator_usd: data.adjudicatorUsd },
    filters,
    thresholds,
    message:
      data.rounds.length === 0
        ? data.counts.total === 0
          ? data.since === null
            ? 'no rounds in the run store yet: nothing to score'
            : `no rounds since ${data.since}: nothing to score`
          : `no settled council round in the window (${data.counts.total} round(s): ${data.counts.identity} identity, ${data.counts.running} still running): nothing to score`
        : null,
    notes: [],
    seats,
    occupants,
    agreement: { seats: seatPairs, occupants: occupantPairs },
    recommendations: seats.map((s) => recommend(data, s, thresholds)),
    seat_tests: data.seatTests,
  };
}

const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

/**
 * Plan 8.3: a seat is a swap candidate when, over at least N adjudicated rounds it ratified in, its unique owed count
 * is 0 and either its precision is below P or its ratified rate is below R. A precision of null (nothing adopted or
 * refuted) is not below P. The flag never swaps anything; it shows the rounds and findings behind it.
 */
export function recommend(data: StatsData, card: SeatCard, t: Thresholds): Recommendation {
  const eligible = card.adjudicated_ratified >= t.min_ratified_rounds;
  const lowPrecision = card.findings.precision !== null && card.findings.precision < t.precision_below;
  const lowRatified = card.ratified_rate !== null && card.ratified_rate < t.ratified_rate_below;
  const reasons: string[] = [];
  if (!eligible) {
    reasons.push(`${card.adjudicated_ratified} adjudicated round(s) ratified, below the ${t.min_ratified_rounds} the flag needs`);
    return { seat: card.seat, swap_candidate: false, eligible, reasons, evidence: null };
  }
  if (card.unique.owed > 0) reasons.push(`${card.unique.owed} unique owed finding(s): it found what no other seat did`);
  if (lowPrecision) reasons.push(`precision ${pct(card.findings.precision ?? 0)} is below ${pct(t.precision_below)}`);
  if (lowRatified) reasons.push(`ratified rate ${pct(card.ratified_rate ?? 0)} is below ${pct(t.ratified_rate_below)}`);
  const flagged = card.unique.owed === 0 && (lowPrecision || lowRatified);
  if (flagged) reasons.unshift(`0 unique owed over ${card.adjudicated_ratified} adjudicated round(s) ratified`);
  else if (card.unique.owed === 0) reasons.push(`precision ${card.findings.precision === null ? 'n/a' : pct(card.findings.precision)} and ratified rate ${card.ratified_rate === null ? 'n/a' : pct(card.ratified_rate)} are at or above the thresholds`);
  return { seat: card.seat, swap_candidate: flagged, eligible, reasons, evidence: flagged ? evidenceOf(data, card.seat) : null };
}

/** Every settled round the seat sat in, and every finding it raised in the adjudicated ones. */
export function evidenceOf(data: StatsData, seat: string): { rounds: EvidenceRound[]; findings: EvidenceFinding[] } {
  const rounds: EvidenceRound[] = [];
  const findings: EvidenceFinding[] = [];
  for (const r of data.rounds) {
    const legs = r.legs.filter((l) => l.seat === seat);
    if (legs.length === 0) continue;
    const pass = legs.find((l) => l.status === 'PASS');
    rounds.push({
      round: r.id,
      target: r.target,
      round_no: r.roundNo,
      started_at: r.startedAt,
      dry_run: r.dryRun,
      ratified: pass !== undefined,
      adjudicated: r.adjudicated,
      said: pass ? pass.verdictRaw : `not ratified: ${legs.map((l) => `${l.role} ${l.attempt} ${l.status}${l.failureClass ? ` ${l.failureClass}` : ''}`).join(', ')}`,
      verdict: r.verdict,
    });
    if (!pass || !r.adjudicated) continue;
    for (const f of r.findings) {
      if (!f.sources.some((s) => s.legId === pass.id)) continue;
      findings.push({
        round: r.id,
        id: f.id,
        title: f.title,
        path: f.path,
        line: f.line,
        severity: f.severity,
        outcome: outcomeKey(f),
        unique: f.sources.every((s) => s.legId === pass.id),
        adopted: isAdopted(f),
        refuted: isRefuted(f),
        owed: isOwed(f),
      });
    }
  }
  return { rounds, findings };
}
