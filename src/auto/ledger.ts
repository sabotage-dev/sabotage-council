import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { insertEvent, now } from '../engine/records.js';
import type { DatabaseSync } from '../store/sqlite.js';

/*
 * The auto daemon's ledger (plan 9.4): one row per (repo, PR, head). The row says where the daemon is with that head,
 * and a claim on it says which process is working on it.
 *
 * States:
 *   running       claimed: the round is being prepared, run, adjudicated, or about to post
 *   posting       the post is under way: records_sha, the intended event and its review sha256 are recorded first
 *   posted        a review was posted (COMMENT or REQUEST_CHANGES, or an approval later withdrawn) and its guards ran
 *   approved      an APPROVE was posted and kept (the approval race found nothing)
 *   failed        the attempt failed; with attempts left (2 per head) the next pass tries again, else it is final
 *   needs-ruling  held for the user (plan 3.8): only a `ruling` releases it, and never into an APPROVE without one
 *   superseded    the head moved before anything posted, or a new head arrived while the row was held
 *   skipped       nothing to do at this head (already reviewed at it, the PR closed, a ruling of skip)
 *   retired       a terminal row of a closed PR (pruning)
 *   rendered      an `auto --dry-run` row that rendered its review; nothing was posted
 *
 * Claim fencing: a claim records the owner (host, pid, token), its start and a heartbeat. It is live while its
 * heartbeat is fresh and, on this host, its pid runs; a dead pid frees it at once, a reused pid or another host's
 * claim once the heartbeat goes stale. Every write a claimed row makes names its token, so an owner whose claim was
 * taken over writes nothing more.
 */

export const LEDGER_STATES = ['running', 'posting', 'posted', 'approved', 'failed', 'needs-ruling', 'superseded', 'skipped', 'retired', 'rendered'] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

/** States in which the row is done at its head: a pass never claims it again. */
export const FINAL_STATES: ReadonlySet<LedgerState> = new Set(['posted', 'approved', 'superseded', 'skipped', 'retired', 'rendered']);

/** Two attempts per head (plan 9.4). */
export const MAX_ATTEMPTS = 2;
/** How often a working owner refreshes its heartbeat. */
export const HEARTBEAT_MS = 30_000;
/** A claim whose heartbeat is older than this is free, whatever its pid looks like (a reused pid, another host). */
export const CLAIM_STALE_MS = 10 * 60_000;

export interface LedgerKey {
  /** The run store's repo key: `github.com/<owner>/<repo>`, lower case (P6 round 1 row 6). */
  repo: string;
  num: number;
  head: string;
}

export interface LedgerRow extends LedgerKey {
  state: LedgerState;
  attempts: number;
  claim_pid: number | null;
  claim_started: string | null;
  heartbeat_at: string | null;
  claim_owner: string | null;
  round_id: number | null;
  round_no: number | null;
  records_sha: string | null;
  review_id: number | null;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT' | null;
  review_sha256: string | null;
  dry_run: number;
  reason: string | null;
  created_at: string | null;
  checked_at: string | null;
  updated_at: string;
}

interface Owner {
  host: string;
  pid: number;
  token: string;
}

export function isState(s: string): s is LedgerState {
  return (LEDGER_STATES as readonly string[]).includes(s);
}

/** Runs `fn` inside one IMMEDIATE transaction: committed when it returns, rolled back when it throws. */
export function immediate<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  let value: T;
  try {
    value = fn();
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('COMMIT');
  return value;
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseOwner(text: string | null): Partial<Owner> | null {
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as unknown;
    return o !== null && typeof o === 'object' ? (o as Partial<Owner>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a row's claim is live at `nowMs`: an owner is recorded, its heartbeat is fresh, and on this host its pid
 * runs. A dead pid frees the row at once; a reused pid (alive, but no heartbeat) and another host's claim free it once
 * the heartbeat is older than CLAIM_STALE_MS.
 */
export function claimLive(row: Pick<LedgerRow, 'claim_owner' | 'heartbeat_at'>, nowMs: number = Date.now(), host: string = hostname()): boolean {
  const owner = parseOwner(row.claim_owner);
  if (owner === null) return false;
  const beat = row.heartbeat_at === null ? Number.NaN : Date.parse(row.heartbeat_at);
  if (!(nowMs - beat < CLAIM_STALE_MS)) return false;
  if (owner.host === host) return typeof owner.pid === 'number' && pidAlive(owner.pid);
  return true;
}

export function getRow(db: DatabaseSync, key: LedgerKey): LedgerRow | undefined {
  return db.prepare('SELECT * FROM ledger WHERE repo = ? AND num = ? AND head = ?').get(key.repo, key.num, key.head) as LedgerRow | undefined;
}

/** Every row of one PR, newest first. */
export function rowsOfPr(db: DatabaseSync, repo: string, num: number): LedgerRow[] {
  return db.prepare('SELECT * FROM ledger WHERE repo = ? AND num = ? ORDER BY coalesce(created_at, updated_at) DESC, rowid DESC').all(repo, num) as unknown as LedgerRow[];
}

export function rowOfRound(db: DatabaseSync, roundId: number): LedgerRow | undefined {
  return db.prepare('SELECT * FROM ledger WHERE round_id = ? ORDER BY rowid DESC LIMIT 1').get(roundId) as LedgerRow | undefined;
}

export function allRows(db: DatabaseSync): LedgerRow[] {
  return db.prepare('SELECT * FROM ledger ORDER BY updated_at DESC, rowid DESC').all() as unknown as LedgerRow[];
}

const label = (k: LedgerKey): string => `${k.repo.replace(/^github\.com\//, '')}#${k.num}@${k.head.slice(0, 7)}`;

/** One audit event per ledger change, on the row's round when it has one. */
function ledgerEvent(db: DatabaseSync, row: Pick<LedgerRow, 'repo' | 'num' | 'head' | 'round_id'>, detail: Record<string, unknown>): void {
  insertEvent(db, 'ledger', row.round_id, { row: label(row), repo: row.repo, num: row.num, head: row.head, ...detail });
}

export interface Claim {
  key: LedgerKey;
  /** The owner JSON every fenced write names. */
  owner: string;
}

export type ClaimResult = { ok: true; claim: Claim; row: LedgerRow; takenOver: boolean } | { ok: false; why: string; row: LedgerRow | undefined };

export interface ClaimOptions {
  /** This claim starts a new attempt (attempts + 1). A claim that only finishes a held or posting row does not. */
  attempt: boolean;
  /** The state the row takes under the claim; default: keep a posting row posting, else running. */
  state?: LedgerState | undefined;
  dryRun: boolean;
  /**
   * Start the head over: attempts, round, records and event cleared. A real pass takes over a dry run's row this way
   * (a dry-run round can never post, so the real pass prepares its own).
   */
  reset?: boolean | undefined;
  nowMs?: number | undefined;
}

/**
 * Claims a row for this process, creating it when the head is new, in one IMMEDIATE transaction. Refuses a row
 * whose claim is live. A claim found stale is taken over (an event says so).
 */
export function claimRow(db: DatabaseSync, key: LedgerKey, o: ClaimOptions): ClaimResult {
  return immediate(db, () => {
    const at = new Date(o.nowMs ?? Date.now()).toISOString();
    const row = getRow(db, key);
    if (row !== undefined && claimLive(row, o.nowMs)) {
      const owner = parseOwner(row.claim_owner);
      return { ok: false, why: `claimed by pid ${String(owner?.pid ?? '?')} on ${String(owner?.host ?? '?')} (heartbeat ${String(row.heartbeat_at)})`, row };
    }
    const owner = JSON.stringify({ host: hostname(), pid: process.pid, token: randomUUID() } satisfies Owner);
    const takenOver = row !== undefined && row.claim_owner !== null;
    if (row === undefined) {
      db.prepare(
        `INSERT INTO ledger (repo, num, head, state, attempts, claim_pid, claim_started, heartbeat_at, claim_owner, dry_run, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(key.repo, key.num, key.head, o.state ?? 'running', o.attempt ? 1 : 0, process.pid, at, at, owner, o.dryRun ? 1 : 0, at, at);
    } else {
      const state = o.state ?? (row.state === 'posting' && o.reset !== true ? 'posting' : 'running');
      if (o.reset === true) {
        db.prepare(
          `UPDATE ledger SET attempts = 0, round_id = NULL, round_no = NULL, records_sha = NULL, event = NULL, review_sha256 = NULL, review_id = NULL, reason = NULL
            WHERE repo = ? AND num = ? AND head = ?`,
        ).run(key.repo, key.num, key.head);
      }
      db.prepare(
        `UPDATE ledger SET state = ?, attempts = attempts + ?, claim_pid = ?, claim_started = ?, heartbeat_at = ?, claim_owner = ?, dry_run = ?, updated_at = ?
          WHERE repo = ? AND num = ? AND head = ?`,
      ).run(state, o.attempt ? 1 : 0, process.pid, at, at, owner, o.dryRun ? 1 : 0, at, key.repo, key.num, key.head);
    }
    const now2 = getRow(db, key) as LedgerRow;
    if (takenOver) ledgerEvent(db, now2, { change: 'claim-taken-over', previous: row?.claim_owner, previous_heartbeat: row?.heartbeat_at, state: now2.state });
    ledgerEvent(db, now2, { change: 'claimed', from: row?.state ?? null, to: now2.state, attempt: now2.attempts });
    return { ok: true, claim: { key, owner }, row: now2, takenOver };
  });
}

/** Refreshes the heartbeat; false when the claim is no longer this owner's (fenced). */
export function heartbeat(db: DatabaseSync, claim: Claim, nowMs: number = Date.now()): boolean {
  const r = db
    .prepare('UPDATE ledger SET heartbeat_at = ? WHERE repo = ? AND num = ? AND head = ? AND claim_owner = ?')
    .run(new Date(nowMs).toISOString(), claim.key.repo, claim.key.num, claim.key.head, claim.owner);
  return Number(r.changes) === 1;
}

export interface RowPatch {
  state?: LedgerState | undefined;
  round_id?: number | null | undefined;
  round_no?: number | null | undefined;
  records_sha?: string | null | undefined;
  event?: LedgerRow['event'] | undefined;
  review_sha256?: string | null | undefined;
  review_id?: number | null | undefined;
  reason?: string | null | undefined;
}

const PATCH_COLUMNS = ['state', 'round_id', 'round_no', 'records_sha', 'event', 'review_sha256', 'review_id', 'reason'] as const;

function applyPatch(db: DatabaseSync, key: LedgerKey, patch: RowPatch, extraWhere: string, extraArgs: Array<string | number>): number {
  if (patch.state !== undefined && !isState(patch.state)) throw new Error(`unknown ledger state ${String(patch.state)}`);
  const sets: string[] = [];
  const args: Array<string | number | null> = [];
  for (const c of PATCH_COLUMNS) {
    if (patch[c] === undefined) continue;
    sets.push(`${c} = ?`);
    args.push(patch[c] as string | number | null);
  }
  sets.push('updated_at = ?');
  args.push(now());
  const r = db.prepare(`UPDATE ledger SET ${sets.join(', ')} WHERE repo = ? AND num = ? AND head = ?${extraWhere}`).run(...args, key.repo, key.num, key.head, ...extraArgs);
  return Number(r.changes);
}

/**
 * Updates a claimed row, fenced: only while the claim is still this owner's. Returns false (and writes nothing) for an
 * owner whose claim was taken over.
 */
export function update(db: DatabaseSync, claim: Claim, patch: RowPatch): boolean {
  return immediate(db, () => {
    const before = getRow(db, claim.key);
    const n = applyPatch(db, claim.key, patch, ' AND claim_owner = ?', [claim.owner]);
    if (n !== 1) return false;
    const after = getRow(db, claim.key) as LedgerRow;
    if (patch.state !== undefined && before?.state !== patch.state) ledgerEvent(db, after, { change: 'state', from: before?.state ?? null, to: patch.state, reason: patch.reason ?? after.reason });
    return true;
  });
}

/** Releases a claim (the row keeps its state); a no-op for an owner whose claim was taken over. */
export function release(db: DatabaseSync, claim: Claim): void {
  db.prepare('UPDATE ledger SET claim_owner = NULL, claim_pid = NULL, claim_started = NULL, heartbeat_at = NULL, updated_at = ? WHERE repo = ? AND num = ? AND head = ? AND claim_owner = ?').run(
    now(),
    claim.key.repo,
    claim.key.num,
    claim.key.head,
    claim.owner,
  );
}

/**
 * Updates a row that nobody may hold (a ruling, a superseding head, the prune): refused, returning false, while a
 * live claim holds it.
 */
export function updateUnclaimed(db: DatabaseSync, key: LedgerKey, patch: RowPatch, nowMs: number = Date.now()): boolean {
  return immediate(db, () => patchUnclaimed(db, key, patch, nowMs));
}

/** updateUnclaimed's body, for a caller already inside a transaction. */
export function patchUnclaimed(db: DatabaseSync, key: LedgerKey, patch: RowPatch, nowMs: number = Date.now()): boolean {
  const before = getRow(db, key);
  if (before === undefined || claimLive(before, nowMs)) return false;
  applyPatch(db, key, patch, '', []);
  db.prepare('UPDATE ledger SET claim_owner = NULL, claim_pid = NULL, claim_started = NULL, heartbeat_at = NULL WHERE repo = ? AND num = ? AND head = ?').run(key.repo, key.num, key.head);
  const after = getRow(db, key) as LedgerRow;
  if (patch.state !== undefined && before.state !== patch.state) ledgerEvent(db, after, { change: 'state', from: before.state, to: patch.state, reason: patch.reason ?? after.reason });
  return true;
}

/** Stamps when a pass last read the PR of a row (the prune's rotation). */
export function markChecked(db: DatabaseSync, repo: string, num: number, nowMs: number = Date.now()): void {
  db.prepare('UPDATE ledger SET checked_at = ? WHERE repo = ? AND num = ?').run(new Date(nowMs).toISOString(), repo, num);
}

/** Whether a pass may claim a row of its own mode: a new head, a failed row with attempts left, or a row whose work stopped. */
export function claimable(row: LedgerRow | undefined): boolean {
  if (row === undefined) return true;
  if (FINAL_STATES.has(row.state)) return false;
  if (row.state === 'failed') return row.attempts < MAX_ATTEMPTS;
  return true; // running, posting, needs-ruling: the caller decides what they still need
}
