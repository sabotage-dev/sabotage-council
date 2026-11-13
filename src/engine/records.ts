import { createHash } from 'node:crypto';
import type { DatabaseSync } from '../store/sqlite.js';
import type { SeatConfig } from '../config/schema.js';
import type { BackendId } from '../config/vocab.js';
import type { Transport } from '../adapters/types.js';
import type { Severity } from '../parse/severity.js';
import type { ResolvedTarget } from './target.js';

/*
 * Run-store reads and writes for plan and diff rounds (plan 8.1). Rows are written as the round goes, so `round show`
 * sees a running round's progress.
 */

export const ROUND_STATUSES = ['running', 'awaiting-adjudication', 'failed', 'adjudicated'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

/** Leg statuses (plan 8.1), plus `RUNNING` while a leg is out. */
export const LEG_STATUSES = ['RUNNING', 'PASS', 'FAIL', 'REFUSED', 'CONTAMINATED', 'PREFLIGHT_FAIL'] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

/** The roster and the council settings a round ran under, snapshotted into `rounds.roster_json`. */
export interface RosterSnapshot {
  seats: SeatConfig[];
  council: { leg_timeout_minutes: number; high_only_from_round: number };
}

export const now = (): string => new Date().toISOString();

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type Row = Record<string, unknown>;

function get(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}

function all(db: DatabaseSync, sql: string, ...params: Array<string | number | null>): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

/** One row per target (plan 3.6): plan by repo + path, diff by repo + branch. */
export function upsertTarget(db: DatabaseSync, t: Pick<ResolvedTarget, 'mode' | 'repoKey' | 'planPath' | 'branch'>): number {
  const found =
    t.mode === 'plan'
      ? get(db, "SELECT id FROM targets WHERE kind = 'plan' AND coalesce(repo, '') = ? AND path = ?", t.repoKey, t.planPath ?? '')
      : get(db, "SELECT id FROM targets WHERE kind = 'diff' AND repo = ? AND branch = ?", t.repoKey, t.branch ?? '');
  if (found) return Number(found['id']);
  const r = db
    .prepare('INSERT INTO targets (kind, repo, path, branch) VALUES (?, ?, ?, ?)')
    .run(t.mode, t.repoKey, t.mode === 'plan' ? t.planPath : null, t.mode === 'diff' ? t.branch : null);
  return Number(r.lastInsertRowid);
}

export function upsertOccupant(db: DatabaseSync, o: { backend: BackendId; model: string; effort?: string | undefined }, transport: Transport): number {
  const effort = o.effort ?? null;
  const found = get(
    db,
    "SELECT id FROM occupants WHERE backend = ? AND model = ? AND coalesce(effort, '') = ? AND transport = ?",
    o.backend,
    o.model,
    effort ?? '',
    transport,
  );
  if (found) return Number(found['id']);
  const r = db.prepare('INSERT INTO occupants (backend, model, effort, transport) VALUES (?, ?, ?, ?)').run(o.backend, o.model, effort, transport);
  return Number(r.lastInsertRowid);
}

export interface RoundRow {
  id: number;
  target_id: number;
  round_no: number;
  mode: string;
  head_sha: string;
  base_sha: string | null;
  baseline_sha: string | null;
  full_round_reason: string | null;
  nonce: string | null;
  roster_json: string;
  started_at: string;
  finished_at: string | null;
  verdict: string | null;
  owed_count: number | null;
  approve: number | null;
  needs_ruling: number;
  status: string;
}

export function getRound(db: DatabaseSync, id: number): RoundRow | undefined {
  return get(db, 'SELECT * FROM rounds WHERE id = ?', id) as RoundRow | undefined;
}

export interface LegRow {
  id: number;
  round_id: number;
  seat_id: string;
  occupant_id: number;
  attempt: number;
  role: 'primary' | 'fallback';
  enforcement_label: string | null;
  cli_version: string | null;
  status: LegStatus;
  failure_class: string | null;
  verdict_raw: string | null;
  verdict_effective: string | null;
  model_observed: string | null;
  effort_observed: string | null;
  cwd_ok: number | null;
  tools_used_json: string | null;
  tools_offered_json: string | null;
  root_mutated: number | null;
  nonce_seen: number | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  credits: number | null;
  quota_used_pct: number | null;
  quota_note: string | null;
  record_path: string | null;
  backend: BackendId;
  model: string;
  effort: string | null;
  transport: string;
}

export function getLegs(db: DatabaseSync, roundId: number): LegRow[] {
  return all(
    db,
    `SELECT legs.*, occupants.backend, occupants.model, occupants.effort, occupants.transport
       FROM legs JOIN occupants ON occupants.id = legs.occupant_id
      WHERE legs.round_id = ? ORDER BY legs.id`,
    roundId,
  ) as unknown as LegRow[];
}

/** The ratified legs of a round, at most one per seat: the ones that count toward quorum (plan 3.1 step 8). */
export function countedLegs(db: DatabaseSync, roundId: number): LegRow[] {
  return getLegs(db, roundId).filter((l) => l.status === 'PASS');
}

export function insertEvent(db: DatabaseSync, kind: string, roundId: number | null, detail: unknown): void {
  db.prepare('INSERT INTO events (ts, kind, round_id, detail_json) VALUES (?, ?, ?, ?)').run(now(), kind, roundId, JSON.stringify(detail ?? null));
}

export function getEvents(db: DatabaseSync, roundId: number): Array<{ ts: string; kind: string; detail: unknown }> {
  return all(db, 'SELECT ts, kind, detail_json FROM events WHERE round_id = ? ORDER BY id', roundId).map((r) => ({
    ts: String(r['ts']),
    kind: String(r['kind']),
    detail: r['detail_json'] === null ? null : (JSON.parse(String(r['detail_json'])) as unknown),
  }));
}

/** A finding a later round carries as an earlier item (plan 3.5). */
export interface CarriedItem {
  /** The finding's stable id (plan 7.3), used as the item's source id. */
  id: string;
  severity: Severity;
  kind: 'finding' | 'human_ask';
  /** The outcome it last had: owed and rulings may be owed again; a follow-up stays one unless raised again. */
  origin: 'owed' | 'ruling' | 'follow-up';
  /** The item as the seats read it in PREVIOUS-REVIEWS.md. */
  text: string;
  /** Closed in an earlier round with this exact text: listed as closed context, no row asked (plan 3.5). */
  closedContext: boolean;
  /** The round the text comes from. */
  fromRound: number;
}

/** What plan 3.6 decides for a plan or diff target, from the store. */
export interface RoundNumbering {
  roundNo: number;
  /** The newest counted head other than this one; null in round 1 or when no other head was reviewed. */
  baseline: string | null;
  items: CarriedItem[];
}

/**
 * Plan 3.6 for plan and diff targets: a head counts once a council round on it (two or more counted legs) is
 * adjudicated. The round number is the number of distinct counted heads, plus 1 when this head has none. The
 * baseline is the newest counted head other than this one.
 */
export function numberRound(db: DatabaseSync, targetId: number, head: string, revision: string = head): RoundNumbering {
  const rounds = all(db, "SELECT id, head_sha, round_no FROM rounds WHERE target_id = ? AND status = 'adjudicated' ORDER BY id", targetId);
  // Only a head reviewed at council quorum counts (fold row 7): a solo review is never a reviewed baseline. Rounds
  // compare revisions (fold row 11): the head for diff targets, the plan's content for plan targets.
  const council = all(db, COUNCIL_ROUNDS, targetId);
  const revisions = new Set(council.map((r) => String(r['revision'])));
  const roundNo = revisions.size + (revisions.has(revision) ? 0 : 1);
  const other = [...council].reverse().find((r) => String(r['revision']) !== revision);
  const baseline = other === undefined ? null : String(other['head_sha']);
  // Earlier items come from every adjudicated round of the target, a same-head re-run and a solo round included.
  return { roundNo, baseline, items: carriedItems(db, rounds.map((r) => Number(r['id']))) };
}

/** The head of the newest council round of a target (the work a follow-up snapshot builds on, fold row 10). */
export function latestCouncilHead(db: DatabaseSync, targetId: number): string | null {
  const rows = all(db, COUNCIL_ROUNDS, targetId);
  const last = rows.at(-1);
  return last === undefined ? null : String(last['head_sha']);
}

/** Adjudicated rounds of a target that settled with two or more counted legs: council rounds, with their revision. */
const COUNCIL_ROUNDS = `SELECT rounds.id, rounds.head_sha, rounds.round_no,
    coalesce((SELECT json_extract(events.detail_json, '$.revision') FROM events
               WHERE events.round_id = rounds.id AND events.kind = 'round-prepared' ORDER BY events.id LIMIT 1), rounds.head_sha) AS revision
  FROM rounds
  WHERE rounds.target_id = ? AND rounds.status = 'adjudicated'
    AND (SELECT count(*) FROM legs WHERE legs.round_id = rounds.id AND legs.status = 'PASS') >= 2
  ORDER BY rounds.id`;

/** The text an earlier finding carries into PREVIOUS-REVIEWS.md. Deterministic, so its hash tracks the item. */
export function itemText(f: Row, roundNo: number): string {
  const where = f['path'] === null ? '(no file)' : f['line'] === null ? String(f['path']) : `${String(f['path'])}:${String(f['line'])}`;
  return [
    `${String(f['severity'] ?? 'LOW')} ${where} ${String(f['title'])}`,
    `Round ${roundNo} outcome: ${String(f['outcome'])}.`,
    `Proof: ${String(f['proof_ref'] ?? '')}`,
  ].join('\n');
}

/**
 * The earlier items of a round (plan 3.5), from the target's adjudicated rounds in order: a finding the adjudicator
 * made owed, a ruling or a follow-up opens an item (fold row 9); an `earlier_items` row closes it, keeping the hash of the text
 * it was closed on. An open item asks for a row; a closed one whose text is unchanged is closed context.
 */
export function carriedItems(db: DatabaseSync, roundIds: readonly number[]): CarriedItem[] {
  const items = new Map<string, CarriedItem & { closedSha: string | null }>();
  for (const roundId of roundIds) {
    const roundNo = Number(get(db, 'SELECT round_no FROM rounds WHERE id = ?', roundId)?.['round_no'] ?? 0);
    for (const e of all(db, 'SELECT source_id, status, body_sha256 FROM earlier_items WHERE round_id = ?', roundId)) {
      const item = items.get(String(e['source_id']));
      if (!item) continue;
      if (e['status'] === 'closed') item.closedSha = e['body_sha256'] === null ? sha256(item.text) : String(e['body_sha256']);
      else item.closedSha = null;
    }
    for (const f of all(db, "SELECT * FROM findings WHERE round_id = ? AND outcome IN ('owed', 'ruling', 'follow-up') ORDER BY id", roundId)) {
      const id = String(f['id']);
      items.set(id, {
        id,
        severity: (f['severity'] ?? 'LOW') as Severity,
        kind: f['kind'] === 'human_ask' ? 'human_ask' : 'finding',
        origin: f['outcome'] as CarriedItem['origin'],
        text: itemText(f, roundNo),
        closedContext: false,
        fromRound: roundNo,
        closedSha: null,
      });
    }
  }
  return [...items.values()].map(({ closedSha, ...item }) => ({ ...item, closedContext: closedSha !== null && closedSha === sha256(item.text) }));
}
