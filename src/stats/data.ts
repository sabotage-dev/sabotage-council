import type { DatabaseSync } from '../store/sqlite.js';

/*
 * The scorecard's read of the run store (plan 8.1, 8.2). It only reads: a round records what it records (P0-P8),
 * and the scorecard is computed from those rows. Seat tests (`seats test`) are `seat-test` events with no round, so
 * no round metric ever reads them (they are listed on their own).
 *
 * Which rounds are read (P9 choices, also in the README's stats section):
 * - council rounds only: an identity round (plan 3.10) has no legs, so no seat sat in it;
 * - dry-run rounds count like any other (the shadow week is all dry runs);
 * - a round still `running` is left out until its legs settle; every settled round counts for the leg metrics
 *   (failed, solo, awaiting adjudication and superseded rounds included), and only an adjudicated round (one with a
 *   stored verdict) counts for the finding metrics;
 * - a leg still `RUNNING` (in a round superseded before it settled) is left out.
 * The window keeps rounds whose `started_at` is at or after `since`; every writer stamps it with `toISOString()`, so
 * the text comparison is a time comparison.
 */

export const VERDICTS = ['SHIP', 'SHIP-WITH-FIXES', 'NEEDS-WORK'] as const;
export type Verdict = (typeof VERDICTS)[number];
export type LegVerdict = Verdict | 'none';
export type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'NIT';
export type Outcome = 'owed' | 'follow-up' | 'nit' | 'refuted' | 'ruling' | 'noted';

export interface StatsLeg {
  id: number;
  roundId: number;
  seat: string;
  occupantId: number;
  attempt: number;
  role: 'primary' | 'fallback';
  status: string;
  failureClass: string | null;
  verdictRaw: LegVerdict;
  durationMs: number | null;
  costUsd: number | null;
  credits: number | null;
  quotaPct: number | null;
  /** Leg findings of this leg the adjudicator left unmapped (not a canonical finding). */
  unmapped: number;
}

export interface StatsFinding {
  roundId: number;
  id: string;
  kind: 'finding' | 'human_ask';
  title: string;
  path: string | null;
  line: number | null;
  /** The adjudicator's final severity (plan 3.3), never a seat's own label. */
  severity: Severity | null;
  outcome: Outcome;
  rulingResult: 'upheld' | 'overturned' | null;
  /** Every ratified leg that raised it (finding_sources), with the severity that leg gave it. */
  sources: Array<{ legId: number; severity: Severity }>;
}

export interface StatsRound {
  id: number;
  /** A label for the target: `owner/repo#12`, `repo@branch`, `repo:docs/PLAN.md`. */
  target: string;
  roundNo: number;
  mode: string;
  startedAt: string;
  status: string;
  dryRun: boolean;
  verdict: Verdict | null;
  owedCount: number | null;
  needsRuling: boolean;
  /** A verdict is stored: the adjudication went in (plan 7.1 step 4). */
  adjudicated: boolean;
  adjudicatorUsd: number | null;
  /**
   * Each seat's primary occupant (`backend:model[:effort]`) as the round's roster snapshot recorded it; a seat the
   * snapshot does not name (or a snapshot that does not parse) is absent.
   */
  roster: Map<string, string>;
  /** Settled legs only (a leg still RUNNING is left out). */
  legs: StatsLeg[];
  findings: StatsFinding[];
}

export interface StatsOccupant {
  id: number;
  backend: string;
  model: string;
  effort: string | null;
  transport: string;
  /** `backend:model[:effort]`, the form `--occupant` and `seats test` take. */
  key: string;
}

/** A `seats test` run (never a round): its event's detail. */
export interface SeatTestRecord {
  ts: string;
  seat: string | null;
  backend: string;
  model: string;
  effort: string | null;
  ratified: boolean;
  status: string;
  failure_class: string | null;
  verdict: string | null;
  defects_found: string[];
  defects_total: number;
  cost_usd: number | null;
  credits: number | null;
  duration_ms: number | null;
}

export interface RoundCounts {
  /** Every round in the window, of any kind. */
  total: number;
  identity: number;
  council: number;
  /** Council rounds still running: left out until they settle. */
  running: number;
  /** Council rounds whose legs settled: the leg metrics read these. */
  settled: number;
  /** Settled rounds with a stored verdict: the finding metrics read these. */
  adjudicated: number;
  failed: number;
  awaiting_adjudication: number;
  dry_run: number;
}

export interface StatsData {
  since: string | null;
  rounds: StatsRound[];
  occupants: Map<number, StatsOccupant>;
  counts: RoundCounts;
  /** The adjudicator's own cost over the settled rounds (headless runs record it; plan 8.1). */
  adjudicatorUsd: number;
  firstStartedAt: string | null;
  lastStartedAt: string | null;
  seatTests: SeatTestRecord[];
}

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function occupantKey(o: { backend: string; model: string; effort?: string | null | undefined }): string {
  return o.effort === null || o.effort === undefined ? `${o.backend}:${o.model}` : `${o.backend}:${o.model}:${o.effort}`;
}

function targetLabel(r: Row): string {
  const repo = (str(r['repo']) ?? '').replace(/^github\.com\//, '');
  if (r['target_kind'] === 'pr') return `${repo}#${String(num(r['number']) ?? '?')}`;
  if (r['target_kind'] === 'plan') return repo === '' ? String(r['path']) : `${repo}:${String(r['path'])}`;
  return `${repo}@${String(r['branch'])}`;
}

const asVerdict = (v: unknown): Verdict | null => (VERDICTS as readonly unknown[]).includes(v) ? (v as Verdict) : null;

/** The roster snapshot's seats (plan 8.1: `rounds.roster_json`): seat id -> its primary occupant's key. */
function rosterOf(json: unknown): Map<string, string> {
  const out = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(json));
  } catch {
    return out;
  }
  const seats = typeof parsed === 'object' && parsed !== null ? (parsed as { seats?: unknown }).seats : undefined;
  if (!Array.isArray(seats)) return out;
  for (const s of seats as unknown[]) {
    if (typeof s !== 'object' || s === null) continue;
    const { id, backend, model, effort } = s as Record<string, unknown>;
    if (typeof id !== 'string' || typeof backend !== 'string' || typeof model !== 'string') continue;
    out.set(id, occupantKey({ backend, model, effort: typeof effort === 'string' ? effort : null }));
  }
  return out;
}

/** Reads the window's rounds with their legs, findings and sources, and the window's seat tests. */
export function loadStats(db: DatabaseSync, since: string | null): StatsData {
  const inWindow = '(? IS NULL OR rounds.started_at >= ?)';
  const rows = db
    .prepare(
      `SELECT rounds.id, rounds.round_no, rounds.mode, rounds.started_at, rounds.status, rounds.kind, rounds.dry_run, rounds.verdict,
              rounds.owed_count, rounds.needs_ruling, rounds.adjudicator_cost_usd, rounds.roster_json,
              targets.kind AS target_kind, targets.repo, targets.number, targets.path, targets.branch
         FROM rounds JOIN targets ON targets.id = rounds.target_id
        WHERE ${inWindow}
        ORDER BY rounds.started_at, rounds.id`,
    )
    .all(since, since) as Row[];

  const counts: RoundCounts = { total: rows.length, identity: 0, council: 0, running: 0, settled: 0, adjudicated: 0, failed: 0, awaiting_adjudication: 0, dry_run: 0 };
  const rounds = new Map<number, StatsRound>();
  let adjudicatorUsd = 0;
  for (const r of rows) {
    if (r['kind'] === 'identity') {
      counts.identity += 1;
      continue;
    }
    counts.council += 1;
    if (r['status'] === 'running') {
      counts.running += 1;
      continue;
    }
    const verdict = asVerdict(r['verdict']);
    const round: StatsRound = {
      id: Number(r['id']),
      target: targetLabel(r),
      roundNo: Number(r['round_no']),
      mode: String(r['mode']),
      startedAt: String(r['started_at']),
      status: String(r['status']),
      dryRun: r['dry_run'] === 1 || r['dry_run'] === 1n,
      verdict,
      owedCount: num(r['owed_count']),
      needsRuling: r['needs_ruling'] === 1 || r['needs_ruling'] === 1n,
      adjudicated: verdict !== null,
      adjudicatorUsd: num(r['adjudicator_cost_usd']),
      roster: rosterOf(r['roster_json']),
      legs: [],
      findings: [],
    };
    counts.settled += 1;
    if (round.adjudicated) counts.adjudicated += 1;
    if (round.status === 'failed') counts.failed += 1;
    if (round.status === 'awaiting-adjudication') counts.awaiting_adjudication += 1;
    if (round.dryRun) counts.dry_run += 1;
    adjudicatorUsd += round.adjudicatorUsd ?? 0;
    rounds.set(round.id, round);
  }

  const unmapped = new Map<number, number>();
  for (const u of db
    .prepare(
      `SELECT leg_findings.leg_id, count(*) AS n FROM leg_findings JOIN legs ON legs.id = leg_findings.leg_id JOIN rounds ON rounds.id = legs.round_id
        WHERE leg_findings.mapped_finding_id IS NULL AND ${inWindow} GROUP BY leg_findings.leg_id`,
    )
    .all(since, since) as Row[]) {
    unmapped.set(Number(u['leg_id']), Number(u['n']));
  }

  const occupantIds = new Set<number>();
  const legs = new Map<number, StatsLeg>();
  for (const l of db
    .prepare(
      `SELECT legs.* FROM legs JOIN rounds ON rounds.id = legs.round_id WHERE ${inWindow} ORDER BY legs.id`,
    )
    .all(since, since) as Row[]) {
    const round = rounds.get(Number(l['round_id']));
    if (!round || l['status'] === 'RUNNING') continue;
    const verdictRaw = asVerdict(l['verdict_raw']) ?? 'none';
    const leg: StatsLeg = {
      id: Number(l['id']),
      roundId: round.id,
      seat: String(l['seat_id']),
      occupantId: Number(l['occupant_id']),
      attempt: Number(l['attempt']),
      role: l['role'] === 'fallback' ? 'fallback' : 'primary',
      status: String(l['status']),
      failureClass: str(l['failure_class']),
      verdictRaw,
      durationMs: num(l['duration_ms']),
      costUsd: num(l['cost_usd']),
      credits: num(l['credits']),
      quotaPct: num(l['quota_used_pct']),
      unmapped: unmapped.get(Number(l['id'])) ?? 0,
    };
    round.legs.push(leg);
    legs.set(leg.id, leg);
    occupantIds.add(leg.occupantId);
  }

  const findings = new Map<string, StatsFinding>();
  for (const f of db
    .prepare(`SELECT findings.* FROM findings JOIN rounds ON rounds.id = findings.round_id WHERE ${inWindow} ORDER BY findings.round_id, findings.id`)
    .all(since, since) as Row[]) {
    const round = rounds.get(Number(f['round_id']));
    if (!round?.adjudicated) continue;
    const finding: StatsFinding = {
      roundId: round.id,
      id: String(f['id']),
      kind: f['kind'] === 'human_ask' ? 'human_ask' : 'finding',
      title: String(f['title']),
      path: str(f['path']),
      line: num(f['line']),
      severity: (str(f['severity']) as Severity | null) ?? null,
      outcome: String(f['outcome']) as Outcome,
      rulingResult: f['ruling_result'] === 'upheld' || f['ruling_result'] === 'overturned' ? f['ruling_result'] : null,
      sources: [],
    };
    round.findings.push(finding);
    findings.set(`${round.id}\n${finding.id}`, finding);
  }
  for (const s of db
    .prepare(
      `SELECT finding_sources.round_id, finding_sources.finding_id, leg_findings.leg_id, leg_findings.severity
         FROM finding_sources JOIN leg_findings ON leg_findings.id = finding_sources.leg_finding_id
         JOIN rounds ON rounds.id = finding_sources.round_id
        WHERE ${inWindow} ORDER BY leg_findings.id`,
    )
    .all(since, since) as Row[]) {
    const finding = findings.get(`${String(s['round_id'])}\n${String(s['finding_id'])}`);
    const legId = Number(s['leg_id']);
    // Only a settled leg of the same round is a source (finding_sources is written for counted legs only).
    if (!finding || legs.get(legId)?.roundId !== finding.roundId) continue;
    if (!finding.sources.some((x) => x.legId === legId)) finding.sources.push({ legId, severity: String(s['severity']) as Severity });
  }

  const occupants = new Map<number, StatsOccupant>();
  if (occupantIds.size > 0) {
    for (const o of db.prepare('SELECT id, backend, model, effort, transport FROM occupants ORDER BY id').all() as Row[]) {
      const id = Number(o['id']);
      if (!occupantIds.has(id)) continue;
      const occupant = { id, backend: String(o['backend']), model: String(o['model']), effort: str(o['effort']), transport: String(o['transport']) };
      occupants.set(id, { ...occupant, key: occupantKey(occupant) });
    }
  }

  const list = [...rounds.values()];
  return {
    since,
    rounds: list,
    occupants,
    counts,
    adjudicatorUsd,
    firstStartedAt: list[0]?.startedAt ?? null,
    lastStartedAt: list.at(-1)?.startedAt ?? null,
    seatTests: loadSeatTests(db, since),
  };
}

/** The window's `seat-test` events, newest first, at most 50. */
function loadSeatTests(db: DatabaseSync, since: string | null): SeatTestRecord[] {
  const rows = db
    .prepare("SELECT ts, detail_json FROM events WHERE kind = 'seat-test' AND round_id IS NULL AND (? IS NULL OR ts >= ?) ORDER BY id DESC LIMIT 50")
    .all(since, since) as Row[];
  const out: SeatTestRecord[] = [];
  for (const r of rows) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(String(r['detail_json'])) as Record<string, unknown>;
    } catch {
      continue;
    }
    const o = (d['occupant'] ?? {}) as Record<string, unknown>;
    const defects = (d['defects'] ?? {}) as Record<string, unknown>;
    out.push({
      ts: String(r['ts']),
      seat: str(d['seat']),
      backend: String(o['backend'] ?? '?'),
      model: String(o['model'] ?? '?'),
      effort: str(o['effort']),
      ratified: d['ratified'] === true,
      status: String(d['status'] ?? '?'),
      failure_class: str(d['failure_class']),
      verdict: str(d['verdict']),
      defects_found: Array.isArray(defects['found']) ? defects['found'].map(String) : [],
      defects_total: num(defects['total']) ?? 0,
      cost_usd: num(d['cost_usd']),
      credits: num(d['credits']),
      duration_ms: num(d['duration_ms']),
    });
  }
  return out;
}
