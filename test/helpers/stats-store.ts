import { join } from 'node:path';
import { openStore, type Store } from '../../src/store/index.js';
import { scratch } from './fixtures.js';

/*
 * The synthetic-store fixture writer for the scorecard tests (P9): rounds, legs, findings and their sources are
 * described as data and written through one place, so each test states what happened and the known answer, never
 * SQL. Occupants are `backend:model[:effort]`.
 */

export type V = 'SHIP' | 'SHIP-WITH-FIXES' | 'NEEDS-WORK';
export type Sev = 'HIGH' | 'MEDIUM' | 'LOW' | 'NIT';

export interface LegSpec {
  seat: string;
  occ: string;
  /** Default PASS. */
  status?: 'PASS' | 'FAIL' | 'REFUSED' | 'CONTAMINATED' | 'PREFLIGHT_FAIL' | 'RUNNING';
  failure?: string;
  /** The raw verdict of a PASS leg; default SHIP. 'none' for a leg whose verdict did not parse. */
  verdict?: V | 'none';
  role?: 'primary' | 'fallback';
  attempt?: number;
  durationMs?: number;
  usd?: number;
  credits?: number;
  quota?: number;
  /** Leg findings the adjudicator left unmapped. */
  unmapped?: number;
}

export interface FindingSpec {
  title?: string;
  path?: string | null;
  line?: number | null;
  /** The adjudicator's final severity; default MEDIUM. */
  severity?: Sev;
  outcome: 'owed' | 'follow-up' | 'nit' | 'refuted' | 'ruling' | 'noted';
  ruling?: 'upheld' | 'overturned';
  kind?: 'finding' | 'human_ask';
  /** The seats whose ratified leg raised it. */
  by: string[];
  /** Each raiser's own severity; default the final severity. */
  bySeverity?: Record<string, Sev>;
}

export interface RoundSpec {
  /** started_at; default a minute after the previous round, from 2026-11-01. */
  at?: string;
  kind?: 'council' | 'identity';
  dryRun?: boolean;
  /** Default: adjudicated when a verdict is given (or findings), else awaiting-adjudication. */
  status?: string;
  /** Default: from the findings (NEEDS-WORK when something blocks, else SHIP) when the round is adjudicated. */
  verdict?: V | null;
  target?: string;
  adjudicatorUsd?: number;
  legs?: LegSpec[];
  findings?: FindingSpec[];
}

export interface StatsStore {
  store: Store;
  dbPath: string;
  dir: string;
  round(spec: RoundSpec): number;
  /** A `seats test` record (an event with no round). */
  seatTest(detail: Record<string, unknown>, ts?: string): void;
  occupantId(occ: string): number;
  close(): void;
}

let clock = Date.parse('2026-11-01T00:00:00.000Z');

export function statsStore(): StatsStore {
  const dir = scratch('sc-stats-');
  const dbPath = join(dir, 'data', 'council.db');
  const store = openStore(dbPath);
  const { db } = store;
  const targets = new Map<string, number>();
  let findingSeq = 0;

  const occupantId = (occ: string): number => {
    const [backend, model, effort] = occ.split(':');
    const found = db.prepare("SELECT id FROM occupants WHERE backend = ? AND model = ? AND coalesce(effort, '') = ?").get(backend ?? '', model ?? '', effort ?? '') as { id: number } | undefined;
    if (found) return found.id;
    const transport = backend === 'kiro' || backend === 'antigravity' || backend === 'opencode' ? 'acp' : 'headless';
    return Number(db.prepare('INSERT INTO occupants (backend, model, effort, transport) VALUES (?, ?, ?, ?)').run(backend ?? '', model ?? '', effort ?? null, transport).lastInsertRowid);
  };

  const targetId = (name: string): number => {
    const known = targets.get(name);
    if (known !== undefined) return known;
    const id = Number(db.prepare("INSERT INTO targets (kind, repo, number) VALUES ('pr', ?, ?)").run(`github.com/acme/${name}`, targets.size + 1).lastInsertRowid);
    targets.set(name, id);
    return id;
  };

  const round = (spec: RoundSpec): number => {
    clock += 60_000;
    const at = spec.at ?? new Date(clock).toISOString();
    const findings = spec.findings ?? [];
    const blocking = findings.some((f) => f.outcome === 'owed' || (f.outcome === 'ruling' && f.ruling !== 'overturned'));
    const adjudicatedByDefault = spec.verdict !== undefined ? spec.verdict !== null : findings.length > 0 || (spec.legs ?? []).some((l) => (l.status ?? 'PASS') === 'PASS');
    const status = spec.status ?? (spec.kind === 'identity' ? 'identity' : adjudicatedByDefault ? 'adjudicated' : 'awaiting-adjudication');
    const adjudicated = status === 'adjudicated' || (status === 'superseded' && spec.verdict !== undefined && spec.verdict !== null);
    const verdict = adjudicated ? (spec.verdict ?? (blocking ? 'NEEDS-WORK' : 'SHIP')) : null;
    const owed = findings.filter((f) => f.outcome === 'owed').length;
    const tid = targetId(spec.target ?? 'widget');
    const roundNo = Number((db.prepare('SELECT count(*) AS n FROM rounds WHERE target_id = ?').get(tid) as { n: number }).n) + 1;
    const roundId = Number(
      db
        .prepare(
          `INSERT INTO rounds (target_id, round_no, mode, head_sha, roster_json, started_at, finished_at, verdict, owed_count, approve, needs_ruling, status, kind, dry_run, adjudicator_cost_usd)
           VALUES (?, ?, 'pr', ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tid,
          roundNo,
          'a'.repeat(40),
          at,
          at,
          verdict,
          adjudicated ? owed : null,
          adjudicated ? (blocking ? 0 : 1) : null,
          findings.some((f) => f.outcome === 'ruling') ? 1 : 0,
          status,
          spec.kind ?? 'council',
          spec.dryRun === true ? 1 : 0,
          spec.adjudicatorUsd ?? null,
        ).lastInsertRowid,
    );
    const passLeg = new Map<string, number>();
    const local = new Map<number, number>();
    for (const l of spec.legs ?? []) {
      const st = l.status ?? 'PASS';
      const legId = Number(
        db
          .prepare(
            `INSERT INTO legs (round_id, seat_id, occupant_id, attempt, role, status, failure_class, verdict_raw, verdict_effective, duration_ms, cost_usd, credits, quota_used_pct, started_at, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            roundId,
            l.seat,
            occupantId(l.occ),
            l.attempt ?? 1,
            l.role ?? 'primary',
            st,
            st === 'PASS' ? null : (l.failure ?? (st === 'CONTAMINATED' ? 'contaminated' : st === 'REFUSED' ? 'setup' : st === 'RUNNING' ? null : 'setup')),
            st === 'PASS' ? (l.verdict ?? 'SHIP') : null,
            st === 'PASS' && adjudicated ? (l.verdict ?? 'SHIP') : null,
            l.durationMs ?? null,
            l.usd ?? null,
            l.credits ?? null,
            l.quota ?? null,
            at,
            st === 'RUNNING' ? null : at,
          ).lastInsertRowid,
      );
      if (st === 'PASS') passLeg.set(l.seat, legId);
      for (let i = 0; i < (l.unmapped ?? 0); i++) {
        const n = (local.get(legId) ?? 0) + 1;
        local.set(legId, n);
        db.prepare("INSERT INTO leg_findings (leg_id, local_id, severity, title, extracted_by, unmapped_reason) VALUES (?, ?, 'LOW', 'not a finding', 'leg', 'out of scope')").run(legId, `U${n}`);
      }
    }
    for (const f of findings) {
      findingSeq += 1;
      const id = `f_${findingSeq.toString(16).padStart(12, '0')}`;
      const severity = f.severity ?? 'MEDIUM';
      const title = f.title ?? `finding ${findingSeq}`;
      db.prepare(
        `INSERT INTO findings (round_id, id, kind, title, path, line, severity, outcome, owner, ruling_result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'this', ?)`,
      ).run(roundId, id, f.kind ?? 'finding', title, f.path === undefined ? 'src/x.ts' : f.path, f.line === undefined ? 1 : f.line, severity, f.outcome, f.outcome === 'ruling' ? (f.ruling ?? null) : null);
      for (const seat of f.by) {
        const legId = passLeg.get(seat);
        if (legId === undefined) throw new Error(`seat ${seat} has no ratified leg in this round`);
        const n = (local.get(legId) ?? 0) + 1;
        local.set(legId, n);
        const lf = Number(
          db
            .prepare("INSERT INTO leg_findings (leg_id, local_id, severity, title, extracted_by, mapped_round_id, mapped_finding_id) VALUES (?, ?, ?, ?, 'leg', ?, ?)")
            .run(legId, `F${n}`, f.bySeverity?.[seat] ?? severity, title, roundId, id).lastInsertRowid,
        );
        db.prepare('INSERT INTO finding_sources (round_id, finding_id, leg_finding_id) VALUES (?, ?, ?)').run(roundId, id, lf);
      }
    }
    return roundId;
  };

  const seatTest = (detail: Record<string, unknown>, ts: string = new Date(clock).toISOString()): void => {
    db.prepare("INSERT INTO events (ts, kind, round_id, detail_json) VALUES (?, 'seat-test', NULL, ?)").run(ts, JSON.stringify(detail));
  };

  return { store, dbPath, dir, round, seatTest, occupantId, close: () => store.close() };
}

/** Three seats on three occupants: the roster most tests use. */
export const OCC = { a: 'codex:gpt-6.1-sol:high', b: 'claude:claude-sonnet-5-5:high', c: 'grok:grok-4.7:high', af: 'kiro:gpt-5.6-sol:high' } as const;

/** Three ratified legs with the given verdicts (default SHIP). */
export function three(v: { a?: V | 'none'; b?: V | 'none'; c?: V | 'none' } = {}, extra: Partial<Record<'a' | 'b' | 'c', Partial<LegSpec>>> = {}): LegSpec[] {
  return (['a', 'b', 'c'] as const).map((seat) => ({ seat, occ: OCC[seat], verdict: v[seat] ?? 'SHIP', ...extra[seat] }));
}
