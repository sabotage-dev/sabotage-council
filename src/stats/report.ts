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

/**
 * Whom the flag judges: the seat's current primary occupant, over the seat's rounds since that occupant took the seat
 * (its tenure). Current is the config's occupant for the seat when a config loads, else the occupant the latest round
 * in the window seated there. The tenure starts at the first round whose roster snapshot seats it there after a
 * different occupant (or at the window's start); a round whose snapshot does not name the seat reads its primary leg.
 * The seat's fallback legs in those rounds count, as they do on the seat card: changing only the fallback does not
 * start the evidence over.
 */
export interface Tenure {
  /** `backend:model[:effort]`. */
  occupant: string;
  source: 'config' | 'roster';
  /** The first round of its tenure in the window; null when no round in the window seated it. */
  since_round: number | null;
  since_at: string | null;
}

export interface Recommendation {
  seat: string;
  swap_candidate: boolean;
  /**
   * Enough evidence for at least one branch: rounds seated under the current occupant >= N (the ratified-rate
   * branch). The precision branch also needs N adjudicated rounds ratified.
   */
  eligible: boolean;
  /** The occupant judged; null when the seat has no known occupant. */
  occupant: Tenure | null;
  /** Why it is flagged, or why it is not. */
  reasons: string[];
  /** Present when flagged: every round of the tenure it sat in and every finding it raised in them. */
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

/** The seat's primary occupant in a round: its roster snapshot's, else its primary leg's; null when neither names one. */
export function primaryOccupantOf(data: StatsData, r: StatsData['rounds'][number], seat: string): string | null {
  const fromRoster = r.roster.get(seat);
  if (fromRoster !== undefined) return fromRoster;
  const leg = r.legs.find((l) => l.seat === seat && l.role === 'primary');
  return leg === undefined ? null : (data.occupants.get(leg.occupantId)?.key ?? null);
}

/** The seat's current occupant and the window's rounds of its tenure (see Tenure). */
export function tenureOf(data: StatsData, seat: string, current: string | undefined): { tenure: Tenure | null; rounds: StatsData['rounds'] } {
  const keys = data.rounds.map((r) => primaryOccupantOf(data, r, seat));
  const occupant = current ?? [...keys].reverse().find((k): k is string => k !== null);
  if (occupant === undefined) return { tenure: null, rounds: [] };
  let start = data.rounds.length;
  for (let i = data.rounds.length - 1; i >= 0; i--) {
    const k = keys[i];
    if (k === null || k === undefined) continue; // the round does not name the seat: no change of occupant
    if (k !== occupant) break;
    start = i;
  }
  const rounds = data.rounds.slice(start);
  const first = rounds[0];
  return {
    tenure: { occupant, source: current !== undefined ? 'config' : 'roster', since_round: first?.id ?? null, since_at: first?.startedAt ?? null },
    rounds,
  };
}

/**
 * Builds the report. `current` maps a seat id to its current primary occupant (`backend:model[:effort]`, from the
 * config); a seat it does not name is judged on the occupant the latest round seated there.
 */
export function buildReport(
  data: StatsData,
  thresholds: Thresholds,
  filters: Filters,
  generatedAt: string = new Date().toISOString(),
  current: ReadonlyMap<string, string> = new Map(),
): StatsReport {
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
    recommendations: seats.map((s) => recommendFor(data, s.seat, thresholds, current.get(s.seat))),
    seat_tests: data.seatTests,
  };
}

const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

/** The recommendation for a seat, judged on its current occupant's tenure in the window. */
export function recommendFor(data: StatsData, seat: string, t: Thresholds, current: string | undefined): Recommendation {
  const { tenure, rounds } = tenureOf(data, seat, current);
  const scoped: StatsData = { ...data, rounds };
  const rec = recommend(cardOf(scoped, { kind: 'seat', seat }), t, tenure, seat);
  return rec.swap_candidate ? { ...rec, evidence: evidenceOf(scoped, seat) } : rec;
}

/**
 * Plan 8.3, two branches, judged on the seat's current occupant (its tenure, `card` computed over those rounds). A seat
 * is a swap candidate when its unique owed count is 0 and either
 * - its ratified rate is below R over at least N rounds seated (a seat that fails every attempt is flagged, its
 *   failures the evidence), or
 * - its precision is below P over at least N adjudicated rounds it ratified in.
 * A precision of null (nothing adopted or refuted) is not below P: it is reported as inconclusive, and whether such a
 * seat should be flagged is the owner's call. The flag never swaps anything.
 */
export function recommend(card: Card, t: Thresholds, tenure: Tenure | null, seat: string): Recommendation {
  const n = t.min_ratified_rounds;
  const seated = card.rounds_seated;
  const adjudicated = card.adjudicated_ratified;
  const rateEligible = seated >= n;
  const precisionEligible = adjudicated >= n;
  const lowPrecision = precisionEligible && card.findings.precision !== null && card.findings.precision < t.precision_below;
  const lowRatified = rateEligible && card.ratified_rate !== null && card.ratified_rate < t.ratified_rate_below;
  const reasons: string[] = [];
  if (tenure !== null) {
    reasons.push(
      tenure.since_round === null
        ? `judged on its current occupant ${tenure.occupant} (${tenure.source === 'config' ? 'the config' : 'the latest round'}): no round in the window seated it yet`
        : `judged on its current occupant ${tenure.occupant} (${tenure.source === 'config' ? 'the config' : 'the latest round'}), in the seat since round #${tenure.since_round} (${(tenure.since_at ?? '').slice(0, 10)})`,
    );
  }
  if (!rateEligible) {
    reasons.push(`${seated} round(s) seated and ${adjudicated} adjudicated round(s) ratified under it, below the ${n} the flag needs`);
    return { seat, swap_candidate: false, eligible: false, occupant: tenure, reasons, evidence: null };
  }
  const flagged = card.unique.owed === 0 && (lowPrecision || lowRatified);
  if (flagged) reasons.push(`0 unique owed over ${seated} round(s) seated (${adjudicated} adjudicated and ratified)`);
  if (card.unique.owed > 0) reasons.push(`${card.unique.owed} unique owed finding(s): it found what no other seat did`);
  if (!precisionEligible) reasons.push(`precision not judged: ${adjudicated} adjudicated round(s) ratified, below the ${n} that branch needs`);
  else if (card.findings.precision === null) {
    reasons.push(
      `precision inconclusive: nothing it raised was adopted or refuted over ${adjudicated} adjudicated round(s) ratified (${card.findings.raised} finding(s) raised, ${card.drop_one.blocking_lost} blocking lost without it)`,
    );
  } else reasons.push(`precision ${pct(card.findings.precision)} is ${lowPrecision ? 'below' : 'at or above'} ${pct(t.precision_below)}`);
  reasons.push(
    `ratified rate ${card.ratified_rate === null ? 'n/a' : pct(card.ratified_rate)} (${card.rounds_ratified} of ${seated} round(s) seated) is ${lowRatified ? 'below' : 'at or above'} ${pct(t.ratified_rate_below)}`,
  );
  return { seat, swap_candidate: flagged, eligible: true, occupant: tenure, reasons, evidence: null };
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
