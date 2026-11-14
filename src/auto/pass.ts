import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { SeatAdapters } from '../adapters/index.js';
import { onSyncBeat } from '../beat.js';
import { adjudicateHeadless, HeadlessError, type HeadlessResult } from '../adjudicate/index.js';
import type { CouncilConfig } from '../config/schema.js';
import { failRound, removeRoundRoots, roundDirOf, runWorker, type DataLayout } from '../engine/index.js';
import { ALREADY_ON_HEAD, holdPost, IS_DRAFT, pendingGuards, postRound, releasePost, type HeldPost, type PostResult } from '../engine/post.js';
import { autoOf, creditsOf, ensureIdentityFile, HeadMovedError, markerConfig, preparePrRound } from '../engine/pr.js';
import { countRounds } from '../forge/count.js';
import { getEvents, getRound, insertEvent, type RoundRow } from '../engine/records.js';
import { preparedDetail } from '../engine/facts.js';
import { latestRelease, roundHeld } from '../engine/ruling.js';
import type { GitHubApi } from '../forge/github.js';
import { ensureMirror, mirrorPath, type MirrorSource } from '../forge/mirror.js';
import { loginMismatch, prLabel, sameLogin, type PrRef } from '../forge/pr.js';
import type { Store } from '../store/open.js';
import type { DatabaseSync } from '../store/sqlite.js';
import {
  claimable,
  CLAIM_STALE_MS,
  claimLive,
  claimRow,
  FINAL_STATES,
  getRow,
  heartbeat,
  HEARTBEAT_MS,
  immediate,
  linkRound,
  markChecked,
  MAX_ATTEMPTS,
  pidAlive,
  release,
  rowsOfPr,
  update,
  updateUnclaimed,
  type Claim,
  type LedgerKey,
  type LedgerRow,
  type LedgerState,
} from './ledger.js';
import { commandDeliver, desktopDeliver, notify, type Deliver, type NoticeKind } from './notify.js';
import { candidateOf, inScope, latestOurs, readReviews, refOfKey, reviewedAt, searchQueue, CONTINUING, type Candidate } from './queue.js';
import { recordTests, runTests, testGate, testsFor, testsMarkdown, type TestRun } from './tests.js';

/*
 * One pass of the auto daemon (plan 9.4): queue, ledger, a council round per new head, the headless adjudicator,
 * and one review per round, under the [auto] rules. `auto run-once` is one pass; `auto run` loops passes every
 * `interval_minutes`. A pass composes what P5-P7 built and reimplements none of it: `preparePrRound` (P6) numbers and
 * prepares the round, `runWorker` (P5) runs the legs, `adjudicateHeadless` (P7) adjudicates, and `postRound` (P6)
 * renders, claims and posts, with its guards.
 *
 * `--dry-run` runs everything but the POST and the dismissals: its rounds are started dry (P6: they can render but
 * never post), its rows end `rendered`, and it never resumes a real row into a post.
 */

export class PassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PassError';
  }
}

/** The adjudication step: by default the headless adjudicator with `[adjudicator]`. */
export type AdjudicateStep = (store: Store, layout: DataLayout, roundId: number, tests: { markdown: string; result: unknown } | undefined, signal: AbortSignal) => Promise<Pick<HeadlessResult, 'outcome' | 'reason'>>;

export interface PassOptions {
  config: CouncilConfig;
  configPath: string;
  layout: DataLayout;
  api: GitHubApi;
  dryRun: boolean;
  adapters: SeatAdapters;
  /** The environment the legs, the adjudicator and the tests are scrubbed from. */
  env: NodeJS.ProcessEnv;
  ghBin?: string | undefined;
  mirrorSource?: ((ref: PrRef) => MirrorSource) | undefined;
  claudeBin?: string | undefined;
  headlessPollMs?: number | undefined;
  legPollMs?: number | undefined;
  legTimeoutMs?: number | undefined;
  adjudicate?: AdjudicateStep | undefined;
  deliver?: Deliver | undefined;
  /** `caffeinate` (macOS): rounds run under `caffeinate -i`. null: none. Default /usr/bin/caffeinate on macOS. */
  caffeinate?: string | null | undefined;
  /** The pass's clock (tests). */
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
  /** Tests only: stand-ins for a crash or a race at a fixed point. */
  hooks?:
    | {
        afterPost?: ((roundId: number) => void) | undefined;
        /** After P6's post claim, before its intent and POST. */
        afterPostClaim?: ((roundId: number) => void) | undefined;
        /** After P6's render under its claim, before its last read of the pull request and its intent. */
        beforePostRead?: ((roundId: number) => void) | undefined;
        afterLegs?: ((roundId: number) => void) | undefined;
        afterPrepare?: ((roundId: number) => void) | undefined;
        /** After a ledger claim, before the row is worked. */
        afterRowClaim?: ((key: LedgerKey) => void) | undefined;
        /** Inside the transaction that inserts the round and links it to the row. */
        roundInserted?: ((roundId: number) => void) | undefined;
        /**
         * In a resumed post, once the reconciliation found nothing landed: under the post claim the resume holds,
         * before its records check and its re-post.
         */
        afterReconcile?: ((roundId: number) => void) | undefined;
      }
    | undefined;
  log?: ((line: string) => void) | undefined;
  /**
   * How many PRs a pass reads for continuation beyond its search results (plan 9.4: bounded per pass, so a long
   * history cannot starve a pass): the ones read longest ago first, newest first among equals. Default 20.
   */
  continuationReads?: number | undefined;
}

export interface CandidateReport {
  pr: string;
  head: string | null;
  source: string;
  action: 'queued' | 'skipped' | 'held' | 'busy' | 'deferred' | 'done' | 'error';
  why: string;
}

export interface RowReport {
  pr: string;
  head: string;
  round_id: number | null;
  from: string | null;
  to: string;
  why: string;
}

export interface PassReport {
  started_at: string;
  finished_at: string | null;
  dry_run: boolean;
  outcome: 'done' | 'paused' | 'busy' | 'failed';
  login: string | null;
  queries: string[];
  /** Search results outside repos_allow or on repos_skip, dropped unread. */
  dropped: number;
  candidates: CandidateReport[];
  rows: RowReport[];
  rounds_last_24h: number;
  max_rounds_per_day: number;
  pruned: { retired: number; round_dirs: number; roots: number; orphans: number };
  /** PRs read for continuation (and the prune) this pass, of how many in the ledger. */
  continuation: { read: number; of: number };
  notifications: Array<{ kind: string; key: string; outcome: string }>;
  errors: string[];
}

/* ---------- small helpers ---------- */

const DAY_MS = 24 * 60 * 60 * 1000;
export const ROUND_DIR_DAYS = 90;
export const FAILED_ROOT_DAYS = 2;

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const prOf = (k: Pick<LedgerKey, 'repo' | 'num'>): string => `${k.repo.replace(/^github\.com\//, '')}#${k.num}`;

/** The run store's data dir (beside council.db): the daemon's log lives in `auto/` there (its lock is in the store). */
export function autoDir(layout: Pick<DataLayout, 'dbPath'>): string {
  return join(dirname(layout.dbPath), 'auto');
}

/** A pass lock whose heartbeat is older than this is free, whatever its pid or host (P8 round 1 row 6). */
export const PASS_LOCK_STALE_MS = CLAIM_STALE_MS;
/** Busy passes in a row before the user is told another pass keeps the lock. */
export const BUSY_NOTIFY_AFTER = 3;
/** The pass lock's row in auto_state (P8 round 2 row 2). */
export const PASS_LOCK_KEY = 'pass_lock';

export interface PassLock {
  /**
   * Refreshes the heartbeat at `nowMs`; false when the lock is no longer this pass's (it was taken over). A store that
   * stays busy past its timeout is not a loss: true, and the next beat tries again.
   */
  beat: (nowMs: number) => boolean;
  release: () => void;
}

/** SQLite's "database is locked" (SQLITE_BUSY) or "table is locked" (SQLITE_LOCKED), past the store's busy timeout. */
export function storeBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return code === 5 || code === 6 || /database is locked|database table is locked/.test(errText(error));
}

/**
 * One pass at a time per store (P8 round 1 row 6, round 2 row 2): an owner-checked lease, the `pass_lock` row of
 * auto_state, holding the owner's pid, host and a token, with its heartbeat in `updated_at`. It is held while the
 * heartbeat is fresh and, on this host, the pid runs: a dead pid frees it at once, and a lease older than
 * PASS_LOCK_STALE_MS is free whatever its pid or host (a reused pid, a host name that changed). Taking it reads and
 * writes the row in one BEGIN IMMEDIATE transaction, so of two takers of one stale lease the second reads the
 * first's fresh lease and is busy, and a takeover never removes a fresh owner's lease; a beat and a release name the
 * owner, so a pass whose lease was taken over refreshes and removes nothing.
 */
export function takePassLock(db: DatabaseSync, o: { nowMs?: number | undefined; beforeTake?: (() => void) | undefined } = {}): PassLock | { busy: string } {
  const at = o.nowMs ?? Date.now();
  const owner = JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID(), started_at: new Date(at).toISOString() });
  let busy: string | null;
  try {
    busy = immediate(db, () => {
      const held = db.prepare('SELECT value, updated_at FROM auto_state WHERE key = ?').get(PASS_LOCK_KEY) as { value: string; updated_at: string } | undefined;
      if (held !== undefined) {
        let h: { pid?: unknown; host?: unknown } = {};
        try {
          h = JSON.parse(held.value) as typeof h;
        } catch {
          h = {};
        }
        const age = at - Date.parse(held.updated_at);
        const sameHost = h.host === hostname();
        const live = age < PASS_LOCK_STALE_MS && (sameHost ? typeof h.pid === 'number' && pidAlive(h.pid) : typeof h.host === 'string');
        if (live) return `another pass holds the pass lock (pid ${String(h.pid)} on ${String(h.host)}, heartbeat ${Math.round(age / 1000)} s ago)`;
      }
      o.beforeTake?.();
      db.prepare('INSERT INTO auto_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
        PASS_LOCK_KEY,
        owner,
        new Date(at).toISOString(),
      );
      if (held !== undefined) insertEvent(db, 'auto-pass-lock-taken-over', null, { previous: held.value, previous_heartbeat: held.updated_at });
      return null;
    });
  } catch (error) {
    if (storeBusy(error)) return { busy: `another pass is taking the pass lock right now (the store stayed busy: ${errText(error)})` };
    throw error;
  }
  if (busy !== null) return { busy };
  return {
    beat: (nowMs) => {
      try {
        return Number(db.prepare('UPDATE auto_state SET updated_at = ? WHERE key = ? AND value = ?').run(new Date(nowMs).toISOString(), PASS_LOCK_KEY, owner).changes) === 1;
      } catch (error) {
        if (storeBusy(error)) return true;
        throw error;
      }
    },
    release: () => {
      db.prepare('DELETE FROM auto_state WHERE key = ? AND value = ?').run(PASS_LOCK_KEY, owner);
    },
  };
}

/** Consecutive busy passes (auto_state `busy`): counted up on busy, cleared when a pass takes the lock. */
function busyStreak(store: Store, busy: boolean, at: string): { count: number; since: string | null } {
  const row = store.db.prepare("SELECT value FROM auto_state WHERE key = 'busy'").get() as { value: string } | undefined;
  let prev: { count: number; since: string | null } = { count: 0, since: null };
  try {
    if (row) prev = JSON.parse(row.value) as typeof prev;
  } catch {
    prev = { count: 0, since: null };
  }
  const next = busy ? { count: prev.count + 1, since: prev.since ?? at } : { count: 0, since: null };
  store.db.prepare("INSERT INTO auto_state (key, value, updated_at) VALUES ('busy', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(JSON.stringify(next), at);
  return next;
}

/** `auto pause` / `auto resume`: the paused flag lives in the store (auto_state). */
export interface PauseState {
  paused: boolean;
  reason: string | null;
  at: string | null;
}

export function pauseState(store: Store): PauseState {
  const row = store.db.prepare("SELECT value FROM auto_state WHERE key = 'paused'").get() as { value: string } | undefined;
  if (!row) return { paused: false, reason: null, at: null };
  try {
    const v = JSON.parse(row.value) as Partial<PauseState>;
    return { paused: v.paused === true, reason: typeof v.reason === 'string' ? v.reason : null, at: typeof v.at === 'string' ? v.at : null };
  } catch {
    return { paused: true, reason: 'unreadable pause state', at: null };
  }
}

export function setPaused(store: Store, paused: boolean, reason: string | null): void {
  const value = JSON.stringify({ paused, reason, at: new Date().toISOString() });
  store.db.prepare("INSERT INTO auto_state (key, value, updated_at) VALUES ('paused', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(value, new Date().toISOString());
  insertEvent(store.db, paused ? 'auto-paused' : 'auto-resumed', null, { reason });
}

function saveReport(store: Store, report: PassReport): void {
  store.db
    .prepare("INSERT INTO auto_state (key, value, updated_at) VALUES ('last_pass', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(JSON.stringify(report), new Date().toISOString());
}

export function lastReport(store: Store): PassReport | null {
  const row = store.db.prepare("SELECT value FROM auto_state WHERE key = 'last_pass'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as PassReport;
  } catch {
    return null;
  }
}

/** Council rounds the daemon started in the 24 hours before `nowMs` (Q8's daily cap counts these). */
export function roundsSince(store: Store, nowMs: number): number {
  const since = new Date(nowMs - DAY_MS).toISOString();
  return (store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'auto-round' AND ts > ?").get(since) as { n: number }).n;
}

/**
 * `records_sha` (plan 9.4): a hash over the round's records that a post rests on: ADJUDICATION.json (an identity
 * round: identity.json), the rendered body the daemon means to post (AUTO-POST.md), and every leg's answer,
 * ratification and parsed reply. A resume re-posts only while they still hash the same.
 */
export function recordsSha(roundDir: string, kind: 'council' | 'identity'): string {
  const files: string[] = [kind === 'identity' ? 'identity.json' : 'ADJUDICATION.json', 'AUTO-POST.md'];
  const legs = join(roundDir, 'legs');
  if (existsSync(legs)) {
    for (const d of readdirSync(legs).sort()) {
      for (const f of ['answer.md', 'ratification.json', 'reply.json']) if (existsSync(join(legs, d, f))) files.push(relative(roundDir, join(legs, d, f)));
    }
  }
  const h = createHash('sha256');
  for (const rel of files.sort()) {
    const abs = join(roundDir, rel);
    const digest = existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex') : 'missing';
    h.update(`${rel}\0${digest}\n`);
  }
  return h.digest('hex');
}

/** `caffeinate -i -w <pid>` while a round runs (macOS), so idle sleep does not stop it; it ends with the round or the daemon. */
function keepAwake(bin: string | null): () => void {
  if (bin === null) return () => undefined;
  try {
    const child = spawn(bin, ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    child.on('error', () => undefined);
    return () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };
  } catch {
    return () => undefined;
  }
}

/* ---------- the pass ---------- */

interface Ctx {
  store: Store;
  o: PassOptions;
  login: string;
  auto: ReturnType<typeof autoOf>;
  deliver: Deliver;
  report: PassReport;
  nowMs: () => number;
  log: (line: string) => void;
  /** The pass lock, refreshed before every claim (and on a timer). */
  lock: PassLock | null;
  /** Why the pass stopped claiming rows, once it did (the lock taken over). */
  stopped: string | null;
  /** `auto pause` was found before a claim: the pass stops there (P8 round 1 row 8). */
  paused: boolean;
  /** The row the pass is working on: its claim's heartbeat, and whether that claim was found taken over. */
  row: RowBeat | null;
  /** When the beat across synchronous work last refreshed the lock and the claim (the pass's clock). */
  lastBeat: number | null;
}

interface RowBeat {
  claim: Claim;
  fenced: boolean;
  controller: AbortController;
}

const LOCK_LOST = 'the pass lock was taken over (its heartbeat had gone stale): this pass claims nothing more';

/** The beat across synchronous work refreshes the lock and the claim at most this often (P8 round 2 row 2). */
export const SYNC_BEAT_MS = 5_000;

/** Refreshes the pass lock; a lock taken over stops the pass's claims. A store that failed once is tried again later. */
function beatLock(ctx: Ctx): void {
  if (ctx.lock === null || ctx.stopped !== null) return;
  try {
    if (!ctx.lock.beat(ctx.nowMs())) ctx.stopped = LOCK_LOST;
  } catch {
    // the store failed this once: the next beat tries again
  }
}

/** Refreshes the claim of the row being worked; a claim taken over fences the row and aborts its legs and adjudicator. */
function beatRow(ctx: Ctx): void {
  const r = ctx.row;
  if (r === null || r.fenced) return;
  try {
    if (!heartbeat(ctx.store.db, r.claim, ctx.nowMs())) {
      r.fenced = true;
      r.controller.abort();
    }
  } catch {
    // the store failed this once: the next beat tries again
  }
}

/**
 * P8 round 2 row 2: the beat across synchronous work. Registered for the whole pass (src/beat.ts), it runs before and
 * after every git, gh and tar process the engine starts while the pass's `prepare`, `fetchPr`, root build and
 * `postRound` hold the event loop, so the lock and the claim stay fresh where no timer can fire; throttled to
 * SYNC_BEAT_MS. Forced around the prepare, so a claim lost during it is seen before the round goes on.
 */
function beatAll(ctx: Ctx, force: boolean): void {
  const at = ctx.nowMs();
  if (!force && ctx.lastBeat !== null && at - ctx.lastBeat >= 0 && at - ctx.lastBeat < SYNC_BEAT_MS) return;
  ctx.lastBeat = at;
  beatLock(ctx);
  beatRow(ctx);
}

/**
 * Whether the pass may claim another row: not aborted, not paused since it started (`auto pause` stops a running pass
 * at its next round, P8 round 1 row 8), and its lock is still its own (the heartbeat refreshed here, at every claim,
 * since synchronous steps hold the timer back). Once false, the pass claims nothing more.
 */
function mayClaim(ctx: Ctx): boolean {
  if (ctx.o.signal?.aborted === true) return false;
  if (ctx.stopped !== null || ctx.paused) return false;
  if (pauseState(ctx.store).paused) {
    ctx.paused = true;
    return false;
  }
  if (ctx.lock !== null && !ctx.lock.beat(ctx.nowMs())) {
    ctx.stopped = LOCK_LOST;
    ctx.report.errors.push(ctx.stopped);
    return false;
  }
  return true;
}

function defaultAdjudicate(o: PassOptions): AdjudicateStep {
  return async (store, layout, roundId, tests, signal) => {
    const model = o.config.adjudicator.model;
    if (model === undefined) return { outcome: 'failed', reason: '[adjudicator] model is not set' };
    try {
      return await adjudicateHeadless(store, layout, roundId, {
        settings: { model, effort: o.config.adjudicator.effort, maxTurns: o.config.adjudicator.max_turns, timeoutMs: o.config.adjudicator.timeout_minutes * 60_000 },
        bin: o.claudeBin,
        env: o.env,
        pollMs: o.headlessPollMs,
        signal,
        tests,
      });
    } catch (error) {
      if (error instanceof HeadlessError) return { outcome: 'failed', reason: error.message };
      throw error;
    }
  };
}

function notifyRow(ctx: Ctx, kind: NoticeKind, row: Pick<LedgerRow, 'repo' | 'num' | 'head' | 'round_id'>, message: string): void {
  const pr = prOf(row);
  // P8 round 1 row 7: a dry pass's notice has its own key, so it never suppresses the real one.
  const key = `${kind}:${ctx.o.dryRun ? 'dry:' : ''}${row.repo}#${row.num}@${row.head}`;
  const titles: Record<NoticeKind, string> = {
    'needs-ruling': 'sabotage-council: ruling needed',
    failure: 'sabotage-council: auto failed',
    'approval-held': 'sabotage-council: approval held',
    'approval-dismissed': 'sabotage-council: approval withdrawn',
  };
  const ref = refOfKey(row.repo, row.num);
  const outcome = notify(
    ctx.store.db,
    ctx.deliver,
    {
      kind,
      key,
      title: titles[kind],
      message: `${pr} at ${row.head.slice(0, 7)}: ${message}`,
      repo: ref === null ? null : `${ref.owner}/${ref.repo}`,
      number: row.num,
      head: row.head,
      round_id: row.round_id,
      url: ref === null ? null : `https://github.com/${ref.owner}/${ref.repo}/pull/${row.num}`,
      dry_run: ctx.o.dryRun,
    },
    ctx.nowMs(),
  );
  ctx.report.notifications.push({ kind, key, outcome });
}

function rowReport(ctx: Ctx, row: Pick<LedgerRow, 'repo' | 'num' | 'head' | 'round_id'>, from: string | null, to: string, why: string): void {
  ctx.report.rows.push({ pr: prOf(row), head: row.head, round_id: row.round_id, from, to, why });
  ctx.log(`${prOf(row)}@${row.head.slice(0, 7)}: ${from ?? 'new'} -> ${to}${why !== '' ? ` (${why})` : ''}`);
}

/** Runs one pass. Never throws for one PR's trouble: each is a row state and a report line. */
export async function runPass(store: Store, o: PassOptions): Promise<PassReport> {
  const nowMs = o.now ?? Date.now;
  const auto = autoOf(o.config);
  const report: PassReport = {
    started_at: new Date(nowMs()).toISOString(),
    finished_at: null,
    dry_run: o.dryRun,
    outcome: 'done',
    login: null,
    queries: [],
    dropped: 0,
    candidates: [],
    rows: [],
    rounds_last_24h: 0,
    max_rounds_per_day: auto.max_rounds_per_day,
    pruned: { retired: 0, round_dirs: 0, roots: 0, orphans: 0 },
    continuation: { read: 0, of: 0 },
    notifications: [],
    errors: [],
  };
  const log = o.log ?? (() => undefined);
  const finish = (outcome: PassReport['outcome']): PassReport => {
    report.outcome = outcome;
    report.finished_at = new Date(nowMs()).toISOString();
    saveReport(store, report);
    return report;
  };
  if (!o.config.github) throw new PassError('auto needs a [github] table with your login (plan 5.2)');
  if (!o.config.auto) throw new PassError('auto needs an [auto] table with repos_allow (plan 5.2): with none, no repository is in scope');
  if (o.config.adjudicator.model === undefined && o.adjudicate === undefined) throw new PassError('auto needs [adjudicator] model (plan 5.2, P7): the engine never picks a paid model for you');
  if (pauseState(store).paused) return finish('paused');
  const ctx: Ctx = {
    store,
    o,
    login: o.config.github.login,
    auto,
    deliver: o.deliver ?? (o.config.notify.command !== undefined ? commandDeliver(o.config.notify.command, o.env) : desktopDeliver()),
    report,
    nowMs,
    log,
    lock: null,
    stopped: null,
    paused: false,
    row: null,
    lastBeat: null,
  };
  const lock = takePassLock(store.db, { nowMs: nowMs() });
  if ('busy' in lock) {
    // P8 round 1 row 6: a busy pass is recorded as the last pass, and a lock that stays busy is notified.
    report.errors.push(lock.busy);
    const streak = busyStreak(store, true, report.started_at);
    if (streak.count >= BUSY_NOTIFY_AFTER) {
      notifyRow(ctx, 'failure', { repo: 'pass-lock', num: 0, head: 'busy', round_id: null }, `${streak.count} passes in a row found another pass holding the lock (since ${String(streak.since)}): ${lock.busy}`);
    }
    return finish('busy');
  }
  busyStreak(store, false, report.started_at);
  ctx.lock = lock;
  const beat = setInterval(() => beatLock(ctx), HEARTBEAT_MS);
  beat.unref();
  const offSyncBeat = onSyncBeat(() => beatAll(ctx, false));
  try {
    // The account check (P6 row 10, P8): every read and post is made as github.login.
    try {
      const wrong = loginMismatch(o.api, ctx.login);
      if (wrong !== null) throw new PassError(wrong);
      report.login = ctx.login;
    } catch (error) {
      report.errors.push(errText(error));
      notifyRow(ctx, 'failure', { repo: 'account', num: 0, head: 'none', round_id: null }, `the account check failed, so the pass did nothing: ${errText(error)}`);
      return finish('failed');
    }
    const candidates = queue(ctx);
    if (candidates === null) return finish('failed');
    supersedeOldHeads(ctx, candidates);
    await resumeRows(ctx);
    await reviewHeads(ctx, candidates);
    if (ctx.stopped !== null) return finish('failed');
    if (ctx.paused) return finish('paused');
    prune(ctx, candidates);
    report.rounds_last_24h = roundsSince(store, nowMs());
    return finish('done');
  } catch (error) {
    report.errors.push(errText(error));
    return finish('failed');
  } finally {
    offSyncBeat();
    clearInterval(beat);
    lock.release();
  }
}

/* ---------- queue (plan 9.4) ---------- */

function queue(ctx: Ctx): Candidate[] | null {
  const { store, o, report } = ctx;
  const cfg = { login: ctx.login, repos_allow: ctx.auto.repos_allow, repos_skip: ctx.auto.repos_skip, include_assigned: ctx.auto.include_assigned, include_team_requests: ctx.auto.include_team_requests };
  let search;
  try {
    search = searchQueue(o.api, cfg);
  } catch (error) {
    report.errors.push(`the search failed, so no PR was queued: ${errText(error)}`);
    return null;
  }
  report.queries = search.queries;
  report.dropped = search.dropped;
  const seen = new Set<string>();
  const out: Candidate[] = [];
  const add = (ref: PrRef, source: Candidate['source']): Candidate | null => {
    const k = `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
    if (seen.has(k)) return null;
    seen.add(k);
    try {
      const c = candidateOf(o.api, ref, source);
      markChecked(store.db, c.repoKey, ref.number, ctx.nowMs());
      return c;
    } catch (error) {
      report.candidates.push({ pr: prLabel(ref), head: null, source, action: 'error', why: errText(error) });
      return null;
    }
  };
  for (const hit of search.hits) {
    if (hit.draft) {
      report.candidates.push({ pr: prLabel(hit.ref), head: null, source: hit.source, action: 'skipped', why: 'a draft' });
      seen.add(`${hit.ref.owner.toLowerCase()}/${hit.ref.repo.toLowerCase()}#${hit.ref.number}`);
      continue;
    }
    if (sameLogin(hit.author, ctx.login)) {
      report.candidates.push({ pr: prLabel(hit.ref), head: null, source: hit.source, action: 'skipped', why: 'your own PR' });
      seen.add(`${hit.ref.owner.toLowerCase()}/${hit.ref.repo.toLowerCase()}#${hit.ref.number}`);
      continue;
    }
    const c = add(hit.ref, hit.source);
    if (c !== null) out.push(c);
  }
  // Continuation: PRs this store reviewed and has not retired, whose latest review of ours may keep them in scope.
  // Bounded per pass and rotated (the ones read longest ago first), so every PR is read in turn.
  const refs = continuationRefs(ctx).filter((r) => !seen.has(`${r.owner.toLowerCase()}/${r.repo.toLowerCase()}#${r.number}`));
  report.continuation.of = refs.length;
  for (const ref of refs.slice(0, o.continuationReads ?? 20)) {
    const c = add(ref, 'continuation');
    report.continuation.read++;
    if (c !== null) out.push(c);
  }
  return out;
}

/** PRs with a ledger row or a posted round of this store, in scope by the lists, not retired. */
function continuationRefs(ctx: Ctx): PrRef[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT repo, num, max(coalesce(checked_at, '')) AS checked, max(updated_at) AS at FROM ledger GROUP BY repo, num HAVING sum(state <> 'retired') > 0
       UNION
       SELECT targets.repo, targets.number AS num, '' AS checked, max(rounds.posted_at) AS at FROM rounds JOIN targets ON targets.id = rounds.target_id
        WHERE targets.kind = 'pr' AND rounds.review_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.repo = targets.repo AND l.num = targets.number)
        GROUP BY targets.repo, targets.number
       ORDER BY checked ASC, at DESC`,
    )
    .all() as Array<{ repo: string; num: number }>;
  const out: PrRef[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const ref = refOfKey(r.repo, r.num);
    if (ref === null || !inScope(ctx.auto, `${ref.owner}/${ref.repo}`)) continue;
    const k = `${r.repo}#${r.num}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(ref);
  }
  return out;
}

/* ---------- supersede ---------- */

/** A new head on a PR supersedes its older rows that are not done and not mid-post (plan 3.8, 9.4). */
function supersedeOldHeads(ctx: Ctx, candidates: readonly Candidate[]): void {
  const { db } = ctx.store;
  for (const c of candidates) {
    if (c.state !== 'open') continue;
    for (const row of rowsOfPr(db, c.repoKey, c.ref.number)) {
      if (row.head.toLowerCase() === c.head.toLowerCase()) continue;
      if (FINAL_STATES.has(row.state) || row.state === 'posting') continue;
      if (row.state === 'failed' && row.attempts >= MAX_ATTEMPTS) continue;
      if (claimLive(row, ctx.nowMs())) continue;
      if (Boolean(row.dry_run) !== ctx.o.dryRun) continue;
      if (row.round_id !== null) {
        db.prepare("UPDATE rounds SET status = 'superseded' WHERE id = ? AND status IN ('running', 'awaiting-adjudication', 'adjudicated') AND event_posted IS NULL").run(row.round_id);
      }
      const why = `a new head ${c.head.slice(0, 7)} arrived`;
      if (updateUnclaimed(db, row, { state: 'superseded', reason: why }, ctx.nowMs())) rowReport(ctx, row, row.state, 'superseded', why);
    }
  }
}

/* ---------- resume (plan 9.4) ---------- */

/**
 * Rows a pass of this mode picks up again: running or posting with no live claim (a daemon that died, or a ruling's
 * release), whatever the PR's search says. A posting row is never re-run from scratch.
 *
 * The PR is read again first (P8 round 1 row 3). A row whose post may have begun (posting, or records_sha set) is
 * always worked, since a review that landed must be reconciled; its post then refuses a draft or a closed PR. Any
 * other row waits while the PR is a draft, and is skipped once the PR is closed.
 */
async function resumeRows(ctx: Ctx): Promise<void> {
  const { db } = ctx.store;
  const rows = db.prepare("SELECT * FROM ledger WHERE state IN ('running', 'posting') ORDER BY updated_at").all() as unknown as LedgerRow[];
  for (const row of rows) {
    if (!mayClaim(ctx)) {
      if (ctx.paused) ctx.report.candidates.push({ pr: prOf(row), head: row.head, source: 'resume', action: 'deferred', why: 'auto is paused: the pass stopped before this row' });
      return;
    }
    if (Boolean(row.dry_run) !== ctx.o.dryRun) continue;
    if (claimLive(row, ctx.nowMs())) continue;
    const ref = refOfKey(row.repo, row.num);
    if (ref === null) continue;
    if (!inScope(ctx.auto, `${ref.owner}/${ref.repo}`)) {
      // P8 round 1 row 11: a post that may have begun is still reconciled after its repository left the lists (a review
      // that landed is adopted and its owed guards run); nothing new ever posts there. Any other row is left alone.
      if (row.state !== 'posting' && row.records_sha === null) continue;
      const claim = claimRow(db, row, { attempt: false, dryRun: ctx.o.dryRun, nowMs: ctx.nowMs() });
      if (!claim.ok) continue;
      ctx.report.candidates.push({ pr: prLabel(ref), head: row.head, source: 'resume', action: 'queued', why: 'out of scope now (repos_allow, repos_skip): reconcile only' });
      await work(ctx, claim.claim, ref, false, true);
      continue;
    }
    const cand = (action: CandidateReport['action'], why: string): void => {
      ctx.report.candidates.push({ pr: prLabel(ref), head: row.head, source: 'resume', action, why });
    };
    let pull: Candidate;
    try {
      pull = candidateOf(ctx.o.api, ref, 'continuation');
      markChecked(db, row.repo, row.num, ctx.nowMs());
    } catch (error) {
      cand('error', `the PR could not be read before the resume: ${errText(error)}`);
      continue;
    }
    if (row.state !== 'posting' && row.records_sha === null) {
      if (pull.state === 'closed') {
        if (row.round_id !== null) db.prepare("UPDATE rounds SET status = 'superseded' WHERE id = ? AND status IN ('running', 'awaiting-adjudication', 'adjudicated') AND event_posted IS NULL").run(row.round_id);
        const why = 'the PR closed before its round posted';
        if (updateUnclaimed(db, row, { state: 'skipped', reason: why }, ctx.nowMs())) rowReport(ctx, row, row.state, 'skipped', why);
        cand('skipped', why);
        continue;
      }
      if (pull.draft) {
        cand('skipped', `a draft: the ${row.state} row resumes once it is ready for review`);
        continue;
      }
    }
    const claim = claimRow(db, row, { attempt: false, dryRun: ctx.o.dryRun, nowMs: ctx.nowMs() });
    if (!claim.ok) continue;
    if (claim.takenOver) rowReport(ctx, row, row.state, claim.row.state, 'a stale claim taken over');
    await work(ctx, claim.claim, ref, false);
  }
}

/* ---------- new heads ---------- */

async function reviewHeads(ctx: Ctx, candidates: readonly Candidate[]): Promise<void> {
  const { store, o, report } = ctx;
  for (const c of candidates) {
    if (!mayClaim(ctx)) {
      if (ctx.paused) report.candidates.push({ pr: `${c.fullName}#${c.ref.number}`, head: c.head, source: c.source, action: 'deferred', why: 'auto is paused: the pass stopped before this round' });
      return;
    }
    const pr = `${c.fullName}#${c.ref.number}`;
    const cand = (action: CandidateReport['action'], why: string): void => {
      report.candidates.push({ pr, head: c.head, source: c.source, action, why });
    };
    if (c.state !== 'open') {
      cand('skipped', 'closed');
      continue;
    }
    if (c.draft) {
      cand('skipped', 'a draft');
      continue;
    }
    if (sameLogin(c.author, ctx.login)) {
      cand('skipped', 'your own PR');
      continue;
    }
    const key: LedgerKey = { repo: c.repoKey, num: c.ref.number, head: c.head };
    const row = getRow(store.db, key);
    let reset = false;
    if (row !== undefined) {
      if (claimLive(row, ctx.nowMs())) {
        cand('busy', `the ledger row is ${row.state}, claimed`);
        continue;
      }
      if (Boolean(row.dry_run) !== o.dryRun) {
        // A dry pass never touches a real row; a real pass starts a dry row's head over (its rounds can never post).
        if (o.dryRun) {
          cand('done', `a real pass has this head (${row.state})`);
          continue;
        }
        reset = true;
      } else if (row.state === 'running' || row.state === 'posting') {
        cand('done', `the ledger row is ${row.state} (resumed above)`);
        continue;
      } else if (row.state === 'needs-ruling') {
        cand('held', `held for your ruling (sabotage-council ruling ${String(row.round_id)} ...)`);
        continue;
      } else if (!claimable(row)) {
        cand('done', `the ledger row is ${row.state}${row.state === 'failed' ? ` after ${row.attempts} attempts` : ''}`);
        continue;
      }
    }
    // A brand-new head: continuation needs our latest review in a continuing state, and a head we reviewed already
    // (an interactive round, another store) is not reviewed again.
    let reviews;
    try {
      reviews = readReviews(o.api, c.ref);
    } catch (error) {
      cand('error', errText(error));
      continue;
    }
    if (c.source === 'continuation' && (row === undefined || reset)) {
      const latest = latestOurs(reviews, ctx.login, c.ref);
      if (latest === null || !CONTINUING.has(latest.state)) {
        cand('skipped', latest === null ? 'no review of ours to continue from' : `our latest review is ${latest.state}: not continuing`);
        continue;
      }
    }
    const already = reviewedAt(reviews, ctx.login, c.ref, c.head);
    if (already !== null && (row === undefined || reset)) {
      if (o.dryRun) {
        cand('skipped', `already reviewed at this head (review ${already.id})`);
        continue;
      }
      const claimed = claimRow(store.db, key, { attempt: false, dryRun: o.dryRun, nowMs: ctx.nowMs(), reset });
      if (claimed.ok) {
        update(store.db, claimed.claim, { state: 'skipped', review_id: already.id, reason: `already reviewed at this head (review ${already.id})` });
        release(store.db, claimed.claim);
        rowReport(ctx, { ...key, round_id: null }, row?.state ?? null, 'skipped', `already reviewed at this head (review ${already.id})`);
      }
      cand('skipped', `already reviewed at this head (review ${already.id})`);
      continue;
    }
    const used = roundsSince(store, ctx.nowMs());
    if (used >= ctx.auto.max_rounds_per_day) {
      cand('deferred', `max_rounds_per_day (${ctx.auto.max_rounds_per_day}) reached: ${used} rounds in the last 24 h`);
      continue;
    }
    // Plan 9.4 (P8 round 1 row 5): the number is computed from the reviews read before the claim, and stored by it.
    const roundNo = countRounds({ ref: c.ref, head: c.head, reviews, credits: creditsOf(store.db, c.ref), cfg: markerConfig(o.config) }).roundNo;
    const claimed = claimRow(store.db, key, { attempt: true, dryRun: o.dryRun, nowMs: ctx.nowMs(), reset, roundNo });
    if (!claimed.ok) {
      cand('busy', claimed.why);
      continue;
    }
    cand('queued', row === undefined ? `${c.source}` : `${c.source}, attempt ${claimed.row.attempts}`);
    await work(ctx, claimed.claim, c.ref, true);
  }
}

/* ---------- one row's work ---------- */

/**
 * `newAttempt`: the claim started an attempt (a new head, or a retry of a failed one), not a resume. `reconcileOnly`:
 * only reconcile a post that may have begun, and post nothing new (a repository that left the lists).
 */
async function work(ctx: Ctx, claim: Claim, ref: PrRef, newAttempt: boolean, reconcileOnly = false): Promise<void> {
  const { db } = ctx.store;
  const controller = new AbortController();
  const outer = ctx.o.signal;
  const onOuter = (): void => controller.abort();
  outer?.addEventListener('abort', onOuter, { once: true });
  const rowBeat: RowBeat = { claim, fenced: false, controller };
  ctx.row = rowBeat;
  const timer = setInterval(() => beatRow(ctx), HEARTBEAT_MS);
  timer.unref();
  try {
    ctx.o.hooks?.afterRowClaim?.(claim.key);
    if (reconcileOnly) {
      const row = getRow(db, claim.key);
      if (row !== undefined && !ctx.o.dryRun && (row.state === 'posting' || row.records_sha !== null)) resumePost(ctx, claim, row, true);
    } else await step(ctx, claim, ref, newAttempt, controller.signal, () => rowBeat.fenced);
  } catch (error) {
    const row = getRow(db, claim.key);
    if (row !== undefined && (row.state === 'posting' || row.records_sha !== null)) {
      // A post may have been sent: the row stays posting, as it was, and the next pass reconciles it (plan 9.4 resume).
      postingNote(ctx, row, `interrupted while posting (the next pass reconciles it): ${errText(error)}`);
    } else if (row !== undefined) fail(ctx, claim, row, `unexpected: ${errText(error)}`);
  } finally {
    clearInterval(timer);
    if (ctx.row === rowBeat) ctx.row = null;
    outer?.removeEventListener('abort', onOuter);
    release(db, claim);
  }
}

/**
 * A note on a posting row that leaves the row as it is (its reason says what the post is, which the resume reads): a
 * report line and an event on its round.
 */
function postingNote(ctx: Ctx, row: Pick<LedgerRow, 'repo' | 'num' | 'head' | 'round_id'>, why: string): void {
  ctx.report.errors.push(`${prOf(row)}@${row.head.slice(0, 7)}: ${why}`);
  insertEvent(ctx.store.db, 'auto-posting-note', row.round_id, { row: `${prOf(row)}@${row.head.slice(0, 7)}`, why });
}

/** Moves a claimed row; false (and a report line) when the claim was taken over. */
function move(ctx: Ctx, claim: Claim, patch: Parameters<typeof update>[2], why = ''): boolean {
  const before = getRow(ctx.store.db, claim.key);
  if (!update(ctx.store.db, claim, patch)) {
    ctx.report.errors.push(`${prOf(claim.key)}@${claim.key.head.slice(0, 7)}: the claim was taken over; this pass stops working on it`);
    return false;
  }
  if (patch.state !== undefined && before !== undefined && before.state !== patch.state) rowReport(ctx, { ...claim.key, round_id: getRow(ctx.store.db, claim.key)?.round_id ?? null }, before.state, patch.state, why || (patch.reason ?? ''));
  return true;
}

/** An attempt failed: the row is failed; with attempts left the next pass tries again, else it is final and notifies. */
function fail(ctx: Ctx, claim: Claim, row: LedgerRow, why: string): void {
  if (!move(ctx, claim, { state: 'failed', reason: why }, why)) return;
  const now = getRow(ctx.store.db, claim.key) ?? row;
  if (now.attempts >= MAX_ATTEMPTS) notifyRow(ctx, 'failure', now, `failed after ${now.attempts} attempts: ${why}`);
}

/** Marks a row failed for good (a resume that cannot post safely), and notifies. */
function failFinal(ctx: Ctx, claim: Claim, why: string): void {
  ctx.store.db.prepare('UPDATE ledger SET attempts = max(attempts, ?) WHERE repo = ? AND num = ? AND head = ? AND claim_owner = ?').run(MAX_ATTEMPTS, claim.key.repo, claim.key.num, claim.key.head, claim.owner);
  const row = getRow(ctx.store.db, claim.key);
  if (row !== undefined) fail(ctx, claim, row, why);
}

async function step(ctx: Ctx, claim: Claim, ref: PrRef, newAttempt: boolean, signal: AbortSignal, fenced: () => boolean): Promise<void> {
  const { store, o } = ctx;
  const { db } = store;
  /** The round this call prepared: only its legs run here; a running round found otherwise belonged to a dead pass. */
  let preparedHere: number | null = null;
  for (let guard = 0; guard < 8; guard++) {
    if (fenced()) return;
    const row = getRow(db, claim.key);
    if (row === undefined) return;
    if (row.state === 'posting' || row.records_sha !== null) {
      if (o.dryRun) return; // a dry pass never resumes a post
      resumePost(ctx, claim, row);
      return;
    }
    if (row.round_id === null) {
      // The daily cap counts every round the daemon starts, a resumed row's too (P8 round 1 row 4; Q8).
      const used = roundsSince(store, ctx.nowMs());
      if (used >= ctx.auto.max_rounds_per_day) {
        const why = `max_rounds_per_day (${ctx.auto.max_rounds_per_day}) reached: ${used} rounds in the last 24 h; the row waits`;
        ctx.report.candidates.push({ pr: prLabel(ref), head: row.head, source: newAttempt ? 'retry' : 'resume', action: 'deferred', why });
        return;
      }
      // P8 round 2 row 2: the prepare holds the event loop (git and gh); the beat runs inside it at every process, and a
      // forced beat on each side makes a claim lost meanwhile stop this row before its round goes on.
      beatAll(ctx, true);
      const ok = prepare(ctx, claim, row, ref);
      beatAll(ctx, true);
      if (!ok) return;
      preparedHere = getRow(db, claim.key)?.round_id ?? null;
      continue;
    }
    const round = getRound(db, row.round_id);
    if (!round) {
      fail(ctx, claim, row, `round ${row.round_id} is missing from the store`);
      return;
    }
    switch (round.status) {
      case 'running': {
        const started = existsSync(join(roundDirOf(o.layout, round.id), 'runner.json'));
        const prepared = preparedHere === round.id || getEvents(db, round.id).some((e) => e.kind === 'round-prepared');
        const preparer = !started && !prepared ? livePreparer(ctx, round) : null;
        if (preparer !== null) {
          // P8 round 2 row 2: its prepare may still be running (a pass held in one long git or gh process past the stale
          // limit, whose claim was taken over): the round is never failed while that pass lives. The row is left to it,
          // unclaimed; the pass after it finishes runs the round's legs.
          ctx.report.candidates.push({ pr: prLabel(ref), head: row.head, source: newAttempt ? 'retry' : 'resume', action: 'busy', why: `round ${round.id} is still being prepared by ${preparer}: left alone until that pass ends` });
          return;
        }
        if (started || !prepared) {
          // The legs belonged to a process that is gone, or its preparation never finished: the round failed, and the
          // attempt with it.
          failRound(store, round.id, 'daemon-died', started ? 'the auto pass that ran these legs is gone' : 'the auto pass that prepared this round died before it finished');
          fail(ctx, claim, row, started ? 'the pass that ran the legs died' : 'the pass that prepared the round died');
          return;
        }
        // Prepared and linked, its legs never started (the pass that prepared it died first): they run now, on this
        // round, so a crash leaves no second round for the head (P8 round 1 row 4).
        await legsAndTests(ctx, round, signal);
        preparedHere = null;
        continue;
      }
      case 'awaiting-adjudication': {
        if (round.needs_ruling === 1) {
          hold(ctx, claim, row, 'the round holds for your ruling');
          return;
        }
        const r = await (o.adjudicate ?? defaultAdjudicate(o))(store, o.layout, round.id, testsInput(ctx, round), signal);
        if (fenced()) return;
        if (r.outcome === 'needs-ruling') {
          hold(ctx, claim, row, r.reason);
          return;
        }
        if (r.outcome === 'failed') {
          fail(ctx, claim, row, `the adjudicator: ${r.reason}`);
          return;
        }
        continue;
      }
      case 'adjudicated':
      case 'identity':
        // P8 round 2 row 4: an identity round whose file a crash left unwritten gets it back from its stored record
        // first (records_sha hashes it).
        if (round.status === 'identity') ensureIdentityFile(store, o.layout, round.id);
        await postStep(ctx, claim, round);
        return;
      case 'superseded':
        move(ctx, claim, { state: 'superseded', reason: 'the head moved before the post' });
        return;
      case 'failed':
        if (newAttempt && preparedHere === null && row.state === 'running' && guard === 0) {
          // A retry (plan 9.4: two attempts per head) after a round that failed: a new round, with the number fixed
          // at the first claim.
          if (!move(ctx, claim, { round_id: null })) return;
          continue;
        }
        fail(ctx, claim, row, `round ${round.id} failed (${failedWhy(ctx, round.id)})`);
        return;
      default:
        fail(ctx, claim, row, `round ${round.id} is ${round.status}`);
        return;
    }
  }
}

/**
 * P8 round 2 row 2: how long a live pid on this host is trusted as the preparer of a round that has not finished
 * preparing. A prepare is git and gh work; one still unfinished after this long is taken as dead, its pid reused.
 */
export const PREPARER_TRUST_MS = 6 * 60 * 60_000;

/**
 * The pass still preparing a round, when one may be: the round's `auto-round` event names its preparer, whose pid runs
 * on this host, and the round started less than PREPARER_TRUST_MS ago. Another host's preparer cannot be checked: its
 * claim, stale by then, is the only sign, as for any row.
 */
function livePreparer(ctx: Ctx, round: RoundRow): string | null {
  const e = getEvents(ctx.store.db, round.id).find((x) => x.kind === 'auto-round');
  const p = (e?.detail as { preparer?: { host?: unknown; pid?: unknown } } | undefined)?.preparer;
  if (p?.host !== hostname() || typeof p.pid !== 'number' || !pidAlive(p.pid)) return null;
  if (!(ctx.nowMs() - Date.parse(round.started_at) < PREPARER_TRUST_MS)) return null;
  return `pid ${p.pid} on this host`;
}

function failedWhy(ctx: Ctx, roundId: number): string {
  const e = getEvents(ctx.store.db, roundId).filter((x) => x.kind === 'round-failed' || x.kind === 'legs-settled').at(-1);
  const d = e?.detail as { error?: string; quorum?: string; stage?: string } | undefined;
  return d?.error ?? (d?.quorum !== undefined ? `quorum ${d.quorum}` : 'no ratified leg');
}

function hold(ctx: Ctx, claim: Claim, row: LedgerRow, why: string): void {
  if (!move(ctx, claim, { state: 'needs-ruling', reason: why }, why)) return;
  notifyRow(ctx, 'needs-ruling', { ...row, round_id: getRow(ctx.store.db, claim.key)?.round_id ?? row.round_id }, `held for your ruling: ${why} (sabotage-council ruling ${String(row.round_id)} ...)`);
}

/** Prepares the head's round (P6): the number fixed at the first claim, the head the ledger claimed, headless trust. */
function prepare(ctx: Ctx, claim: Claim, row: LedgerRow, ref: PrRef): boolean {
  const { store, o } = ctx;
  try {
    const r = preparePrRound(store, {
      config: o.config,
      configPath: o.configPath,
      layout: o.layout,
      ref,
      api: o.api,
      source: o.mirrorSource,
      env: o.env,
      ghBin: o.ghBin,
      dryRun: o.dryRun,
      identity: true,
      headless: true,
      roundNo: row.round_no ?? undefined,
      expectHead: row.head,
      // P8 round 1 row 4: the round is linked to this row, and counted for the daily cap, in the transaction that
      // inserts it. A claim taken over meanwhile rolls the round back: no round exists that no row knows.
      onRound: (db, roundId, roundNo, kind) => {
        if (!linkRound(db, claim, roundId, roundNo)) throw new PassError('the claim was taken over before the round was linked: no round is created');
        if (kind === 'council') {
          // P8 round 2 row 2: the event names the pass preparing the round (its claim's owner), so a pass that finds the
          // round unfinished can tell a prepare still running from one that died.
          db.prepare("INSERT INTO events (ts, kind, round_id, detail_json) VALUES (?, 'auto-round', ?, ?)").run(
            new Date(ctx.nowMs()).toISOString(),
            roundId,
            JSON.stringify({ row: claim.key, dry_run: o.dryRun, preparer: JSON.parse(claim.owner) as unknown }),
          );
        }
        o.hooks?.roundInserted?.(roundId);
      },
    });
    const roundId = r.kind === 'identity' ? r.roundId : r.prepared.inputs.roundId;
    const roundNo = r.kind === 'identity' ? r.roundNo : r.prepared.inputs.roundNo;
    insertEvent(store.db, 'auto-prepared', roundId, { kind: r.kind, round_no: roundNo, warnings: r.warnings });
    o.hooks?.afterPrepare?.(roundId);
    return true;
  } catch (error) {
    if (error instanceof HeadMovedError) {
      move(ctx, claim, { state: 'superseded', reason: error.message });
      return false;
    }
    fail(ctx, claim, row, `the round could not be prepared: ${errText(error)}`);
    return false;
  }
}

/** The legs (P5 worker, in this process) and, beside them, the repository's opt-in tests (D12). */
async function legsAndTests(ctx: Ctx, round: RoundRow, signal: AbortSignal): Promise<void> {
  const { store, o } = ctx;
  const awake = keepAwake(o.caffeinate === undefined ? (process.platform === 'darwin' ? '/usr/bin/caffeinate' : null) : o.caffeinate);
  try {
    const legs = runWorker(store, o.layout, round.id, { adapters: o.adapters, env: o.env, pollMs: o.legPollMs, legTimeoutMs: o.legTimeoutMs, signal }).catch((error: unknown) => {
      ctx.report.errors.push(`round ${round.id}: the legs failed: ${errText(error)}`);
    });
    await Promise.all([legs, maybeTests(ctx, round, signal)]);
    o.hooks?.afterLegs?.(round.id);
  } finally {
    awake();
  }
}

/** Runs the repository's opt-in tests when it has them, and records the result (or why none ran) on the round. */
async function maybeTests(ctx: Ctx, round: RoundRow, signal: AbortSignal): Promise<void> {
  const { store, o } = ctx;
  const detail = preparedDetail(store, round.id).pr;
  if (detail === undefined) return;
  const fullName = `${detail.owner}/${detail.repo}`;
  const spec = testsFor(ctx.auto.tests, fullName);
  if (spec === null) return;
  const roundDir = roundDirOf(o.layout, round.id);
  const gate = testGate({ trusted: detail.trusted, baseRepo: fullName, headRepo: detail.head_repo ?? null });
  let run: TestRun | null = null;
  if (gate.run) {
    const mirror = ensureMirror(mirrorPath(join(dirname(o.layout.dbPath), 'mirrors'), { owner: detail.owner, repo: detail.repo }));
    run = await runTests({ mirror, head: round.head_sha, roundDir, spec, env: o.env, signal });
  }
  recordTests(roundDir, run, gate.run ? null : gate.why);
  insertEvent(store.db, 'auto-tests', round.id, { result: run?.result ?? null, note: run?.note ?? null, gate: gate.run ? null : gate.why, exit_code: run?.exitCode ?? null, duration_ms: run?.durationMs ?? null, log: run?.log ?? null, err_log: run?.errLog ?? null });
}

function testsInput(ctx: Ctx, round: RoundRow): { markdown: string; result: unknown } | undefined {
  const e = getEvents(ctx.store.db, round.id)
    .filter((x) => x.kind === 'auto-tests')
    .at(-1)?.detail as { result: string | null; note: string | null; gate: string | null; exit_code: number | null; duration_ms: number | null; log: string | null; err_log?: string | null } | undefined;
  if (e === undefined) return undefined;
  const run: TestRun | null = e.result === null ? null : { result: e.result as TestRun['result'], note: e.note ?? '', exitCode: e.exit_code, durationMs: e.duration_ms ?? 0, log: e.log, errLog: e.err_log ?? null };
  return { markdown: testsMarkdown(run, e.gate, roundDirOf(ctx.o.layout, round.id)), result: e };
}

/* ---------- the post (P6 post step, under the ledger) ---------- */

const RULING_POST = 'posting the ruling COMMENT';

/** Renders, records the intent in the ledger (records_sha, event, review sha256), posts, and settles the row. */
async function postStep(ctx: Ctx, claim: Claim, round: RoundRow): Promise<void> {
  const { store, o } = ctx;
  const roundDir = roundDirOf(o.layout, round.id);
  for (let render = 1; render <= 3; render++) {
    const dry = postRound(store, { config: o.config, layout: o.layout, api: o.api, roundId: round.id, mode: 'dry-run' });
    if (dry.outcome === 'superseded') {
      move(ctx, claim, { state: 'superseded', reason: dry.problems.join('; ') });
      return;
    }
    if (dry.outcome === 'already-posted') {
      // Posted outside this row's post (by hand, or by a post the row did not record): resume its guards, settle.
      if (o.dryRun) {
        move(ctx, claim, { state: 'rendered', reason: dry.problems.join('; ') });
        return;
      }
      settle(ctx, claim, round, postRound(store, { config: o.config, layout: o.layout, api: o.api, roundId: round.id, mode: 'post', refuseDraft: true }), false);
      return;
    }
    if (dry.outcome !== 'rendered' || dry.body === null || dry.event === null || dry.reviewSha256 === null) {
      const row = getRow(store.db, claim.key);
      if (row !== undefined) fail(ctx, claim, row, `the review could not be rendered: ${dry.problems.join('; ')}`);
      return;
    }
    if (o.dryRun) {
      if (dry.ruling && latestRelease(store.db, round.id) === null) {
        // A dry round is never released (P8 round 1 row 1): the notice says what a real pass would hold for.
        move(ctx, claim, { state: 'needs-ruling', event: dry.event, review_sha256: dry.reviewSha256, reason: 'the review would need your ruling (dry run: nothing posted)' });
        notifyRow(ctx, 'needs-ruling', { ...claim.key, round_id: round.id }, `would hold for your ruling (dry run: nothing posted; round ${round.id} shows why, and a real pass reviews the head afresh)`);
        return;
      }
      move(ctx, claim, { state: 'rendered', event: dry.event, review_sha256: dry.reviewSha256, reason: `dry run: would post ${dry.event} (row ${String(dry.row)})` });
      if (dry.row === 4 || dry.row === 7 || dry.row === 8) notifyRow(ctx, 'approval-held', { ...claim.key, round_id: round.id }, `would post ${dry.event}: ${heldLine(dry)} (dry run)`);
      return;
    }
    writeFileSync(join(roundDir, 'AUTO-POST.md'), dry.body);
    const sha = recordsSha(roundDir, round.kind);
    if (!move(ctx, claim, { state: 'posting', records_sha: sha, event: dry.event, review_sha256: dry.reviewSha256, reason: dry.ruling ? RULING_POST : `posting ${dry.event} (row ${String(dry.row)})` })) return;
    const r = postRound(store, {
      config: o.config,
      layout: o.layout,
      api: o.api,
      roundId: round.id,
      mode: 'post',
      expect: dry.reviewSha256,
      refuseDraft: true,
      hooks: {
        afterPost: o.hooks?.afterPost === undefined ? undefined : () => o.hooks?.afterPost?.(round.id),
        afterClaim: o.hooks?.afterPostClaim === undefined ? undefined : () => o.hooks?.afterPostClaim?.(round.id),
        beforeFinalRead: o.hooks?.beforePostRead === undefined ? undefined : () => o.hooks?.beforePostRead?.(round.id),
      },
    });
    if (r.outcome === 'refused' && r.busy) {
      // P8 round 2 row 1: another post of the round holds its post claim (a post by hand, or another pass), and it may
      // land: the row stays posting with its records, and the next pass reconciles it.
      const row = getRow(store.db, claim.key);
      if (row !== undefined) postingNote(ctx, row, `another post of round ${round.id} holds its post claim, so nothing posted here (the next pass reconciles it): ${r.problems.join('; ')}`);
      return;
    }
    if (r.outcome === 'refused' && !intentRecorded(ctx, round.id)) {
      // Refused before any intent: no POST was sent, so the row may leave posting. A review that changed between the
      // render and the post (CI, a review) renders again; anything else ends the attempt.
      clearPost(ctx, claim);
      if (r.next !== null) continue;
      abandon(ctx, claim, r.problems.join('; '));
      return;
    }
    settle(ctx, claim, round, r, dry.ruling);
    return;
  }
  const row = getRow(store.db, claim.key);
  if (row !== undefined) fail(ctx, claim, row, 'the review kept changing between its render and its post');
}

/** The row leaves posting: its records hash, event and review are cleared (only when no POST can have been sent). */
function clearPost(ctx: Ctx, claim: Claim): void {
  ctx.store.db
    .prepare("UPDATE ledger SET state = 'running', records_sha = NULL, event = NULL, review_sha256 = NULL WHERE repo = ? AND num = ? AND head = ? AND claim_owner = ?")
    .run(claim.key.repo, claim.key.num, claim.key.head, claim.owner);
}

/**
 * A post that cannot go ahead and sent nothing: a closed PR is skipped, and so is a head that already has our review
 * with this round's marker (P8 round 1 row 2: one review per head); a draft keeps the row `running`, unclaimed, for
 * the pass that finds it ready (row 3); anything else is a failed attempt.
 */
function abandon(ctx: Ctx, claim: Claim, why: string): void {
  if (why.includes(` ${IS_DRAFT}: nothing posts`)) {
    move(ctx, claim, { reason: `the PR is a draft: the review posts once it is ready (${why})` });
    rowReport(ctx, { ...claim.key, round_id: getRow(ctx.store.db, claim.key)?.round_id ?? null }, 'posting', 'running', 'the PR is a draft: nothing posts until it is ready');
    return;
  }
  if (/ is closed: nothing posts| was closed since the post began/.test(why)) {
    move(ctx, claim, { state: 'skipped', reason: `the PR closed before the post: ${why}` });
    return;
  }
  if (why.includes(ALREADY_ON_HEAD)) {
    move(ctx, claim, { state: 'skipped', reason: `the head already has our review: ${why}` });
    return;
  }
  const row = getRow(ctx.store.db, claim.key);
  if (row !== undefined) fail(ctx, claim, row, `the post was refused: ${why}`);
}

/** Whether a post of the round recorded its intent since the round's release (so a POST may have been sent). */
function intentRecorded(ctx: Ctx, roundId: number): boolean {
  const events = getEvents(ctx.store.db, roundId);
  let cut = -1;
  events.forEach((e, i) => {
    if (e.kind === 'ruling-release') cut = i;
  });
  return events.slice(cut + 1).some((e) => e.kind === 'posting');
}

function heldLine(r: Pick<PostResult, 'body'>): string {
  const m = /^\*\*Verdict: [^*]*\*\* (.*)$/m.exec(r.body ?? '') ?? /^\*\*(Approval held[^*]*)\*\*$/m.exec(r.body ?? '');
  return (m?.[1] ?? 'approval held').slice(0, 300);
}

/** The row after a post (fresh or resumed): approved, posted, needs-ruling, superseded, or still posting. */
function settle(ctx: Ctx, claim: Claim, round: RoundRow, r: PostResult, ruling: boolean): void {
  const { store } = ctx;
  const { db } = store;
  const row = getRow(db, claim.key);
  if (row === undefined) return;
  if (r.outcome === 'superseded') {
    move(ctx, claim, { state: 'superseded', reason: r.problems.join('; ') });
    return;
  }
  if (r.outcome !== 'posted' && r.outcome !== 'already-posted') {
    // Refused with a post possibly begun (an intent recorded): the row stays posting, and the next pass resumes it.
    postingNote(ctx, row, `the post was refused (the next pass resumes it): ${r.problems.join('; ')}`);
    return;
  }
  const now = getRound(db, round.id) ?? round;
  const reviewId = r.reviewId ?? now.review_id;
  if (pendingGuards(db, round.id) > 0) {
    move(ctx, claim, { review_id: reviewId });
    postingNote(ctx, row, 'posted; a guard is still pending (the next pass resumes it)');
    return;
  }
  const event = (now.event_posted ?? r.event ?? row.event) as LedgerRow['event'];
  const withdrawn = r.guards.find((g) => (g.kind === 'approval-race' || g.kind === 'withdraw-off-head') && g.status === 'done' && g.outcome.startsWith('withdrawn'));
  const held = ruling || row.reason === RULING_POST || (latestRelease(db, round.id) === null && roundHeld(db, now));
  if (held) {
    move(ctx, claim, { state: 'needs-ruling', review_id: reviewId, event, reason: 'posted the ruling COMMENT; held for your ruling' });
    notifyRow(ctx, 'needs-ruling', { ...claim.key, round_id: round.id }, `held for your ruling (sabotage-council ruling ${round.id} ...)`);
    return;
  }
  if (event === 'APPROVE' && withdrawn === undefined) {
    move(ctx, claim, { state: 'approved', review_id: reviewId, event, reason: 'approved' });
    return;
  }
  move(ctx, claim, { state: 'posted', review_id: reviewId, event, reason: withdrawn !== undefined ? withdrawn.outcome : `posted ${String(event)}` });
  if (withdrawn !== undefined) notifyRow(ctx, 'approval-dismissed', { ...claim.key, round_id: round.id }, withdrawn.outcome);
  const rowNo = r.row ?? postedRow(ctx, round.id);
  if (event !== 'APPROVE' && (rowNo === 4 || rowNo === 7 || rowNo === 8)) notifyRow(ctx, 'approval-held', { ...claim.key, round_id: round.id }, heldLine(r));
}

function postedRow(ctx: Ctx, roundId: number): number | null {
  const e = getEvents(ctx.store.db, roundId)
    .filter((x) => x.kind === 'posting')
    .at(-1)?.detail as { row?: number } | undefined;
  return typeof e?.row === 'number' ? e.row : null;
}

/**
 * Plan 9.4 resume of a posting row: first a review of the round that landed is adopted (P6's reconciliation, with its
 * guards); with none, the stored review is re-posted only while the round's records still hash to records_sha, and
 * only that review (`--expect` its review sha256); otherwise the row fails visibly.
 *
 * P8 round 2 row 1: the resume holds one post claim from the reconciliation to the re-post and the row's cleanup, so
 * no other post of the round (a `post --post` by hand, another pass) can start between them. A claim another post
 * holds, or took over, leaves the row posting with its fields intact: that post may land, and the next pass reconciles.
 */
function resumePost(ctx: Ctx, claim: Claim, row: LedgerRow, reconcileOnly = false): void {
  const { store } = ctx;
  const round = row.round_id === null ? undefined : getRound(store.db, row.round_id);
  if (round === undefined) {
    failFinal(ctx, claim, 'a posting row with no round');
    return;
  }
  const held = holdPost(store.db, round.id);
  if ('why' in held) {
    postingNote(ctx, row, `another post of round ${round.id} holds its post claim, so the resume waits (the next pass reconciles it): ${held.why}`);
    return;
  }
  try {
    resumeHeld(ctx, claim, row, round, held, reconcileOnly);
  } finally {
    releasePost(store.db, held);
  }
}

function resumeHeld(ctx: Ctx, claim: Claim, row: LedgerRow, round: RoundRow, held: HeldPost, reconcileOnly: boolean): void {
  const { store, o } = ctx;
  const base = { config: o.config, layout: o.layout, api: o.api, roundId: round.id, mode: 'post' as const, refuseDraft: true, held };
  if (round.event_posted !== null) {
    settle(ctx, claim, round, postRound(store, base), false);
    return;
  }
  const rec = postRound(store, { ...base, reconcileOnly: true });
  if (rec.outcome === 'already-posted') {
    settle(ctx, claim, round, rec, false);
    return;
  }
  if (!rec.notLanded) {
    postingNote(ctx, row, `the resume could not reconcile (the next pass tries again): ${rec.problems.join('; ')}`);
    return;
  }
  o.hooks?.afterReconcile?.(round.id);
  if (reconcileOnly) {
    // P8 round 1 row 11: the repository left the lists, so nothing new posts there; nothing of this post landed.
    clearPost(ctx, claim);
    move(ctx, claim, { state: 'skipped', reason: 'its repository left repos_allow or is on repos_skip: reconciled, nothing of this post landed, and nothing new posts' });
    return;
  }
  // Nothing landed, and the post claim this resume holds keeps every other post of the round out: a row that fails here
  // for good leaves its post fields behind, since no POST can have been sent, and a ruling may release it.
  const sha = recordsSha(roundDirOf(o.layout, round.id), round.kind);
  if (row.records_sha === null || sha !== row.records_sha || row.review_sha256 === null) {
    clearPost(ctx, claim);
    failFinal(ctx, claim, `the round's records changed since the post began (records_sha ${String(row.records_sha).slice(0, 12)}, now ${sha.slice(0, 12)}): nothing posts; post it by hand after a dry run (sabotage-council post ${round.id} --dry-run)`);
    return;
  }
  const r = postRound(store, { ...base, expect: row.review_sha256 });
  if (r.outcome === 'refused') {
    const why = r.problems.join('; ');
    if (r.busy) {
      // P8 round 2 row 1: another post took over the claim this resume held (it was held over an hour), and it may land:
      // the row stays posting, its fields intact, and the next pass reconciles it.
      postingNote(ctx, row, `another post of round ${round.id} took its post claim over, so this re-post sent nothing (the next pass reconciles it): ${why}`);
      return;
    }
    // The reconciliation above found nothing of this post on GitHub, and a refusal sends nothing, so the row may leave
    // posting whatever intent an earlier attempt recorded (P8 round 1 row 12): a closed PR skips it, a head that has
    // another review with this round's marker skips it (row 2), and a draft keeps it for when it is ready (row 3).
    if (/ is closed: nothing posts| was closed since the post began/.test(why) || why.includes(ALREADY_ON_HEAD) || why.includes(` ${IS_DRAFT}: nothing posts`)) {
      clearPost(ctx, claim);
      abandon(ctx, claim, why);
      return;
    }
    clearPost(ctx, claim);
    failFinal(ctx, claim, `the stored review no longer renders the same (${r.problems.join('; ')}): nothing posts; post it by hand after a dry run (sabotage-council post ${round.id} --dry-run)`);
    return;
  }
  settle(ctx, claim, round, r, row.reason === RULING_POST);
}

/* ---------- prune (plan 9.4, 5.4) ---------- */

function prune(ctx: Ctx, candidates: readonly Candidate[]): void {
  const { store, o, report } = ctx;
  const { db } = store;
  // Terminal rows of the closed PRs this pass read (its search and its bounded continuation reads) retire.
  for (const c of candidates) {
    if (c.state !== 'closed') continue;
    for (const row of rowsOfPr(db, c.repoKey, c.ref.number)) {
      if (row.state === 'retired' || row.state === 'running' || row.state === 'posting') continue;
      if (updateUnclaimed(db, row, { state: 'retired', reason: `the PR is closed (was ${row.state})` }, ctx.nowMs())) {
        report.pruned.retired++;
        rowReport(ctx, row, row.state, 'retired', 'the PR is closed');
      }
    }
  }
  // A running round the daemon started (it carries an auto-round event) that no ledger row references: its pass died
  // before the round was linked (a store from before the link was atomic, or a row reset since). It never runs again,
  // so it fails and its roots go (P8 round 1 row 4). Rounds of `round start` carry no auto-round event.
  const orphans = db
    .prepare(
      `SELECT r.id FROM rounds r WHERE r.status = 'running'
         AND EXISTS (SELECT 1 FROM events e WHERE e.round_id = r.id AND e.kind = 'auto-round')
         AND NOT EXISTS (SELECT 1 FROM ledger l WHERE l.round_id = r.id)`,
    )
    .all() as Array<{ id: number }>;
  for (const { id } of orphans) {
    failRound(store, id, 'orphaned', 'no ledger row references this auto round: the pass that started it died before linking it');
    report.pruned.roots += removeRoundRoots(o.layout, id).filter((x) => x.removed).length;
    report.pruned.orphans++;
  }
  // Round dirs older than 90 days (the rows stay: the scorecard needs them), and failed rounds' roots after 2 days.
  const nowMs = ctx.nowMs();
  const old = db
    .prepare("SELECT id, status, started_at FROM rounds WHERE status IN ('adjudicated', 'identity', 'failed', 'superseded') AND started_at < ?")
    .all(new Date(nowMs - FAILED_ROOT_DAYS * DAY_MS).toISOString()) as Array<{ id: number; status: string; started_at: string }>;
  for (const r of old) {
    if (r.status === 'failed' || r.status === 'superseded') {
      const removed = removeRoundRoots(o.layout, r.id).filter((x) => x.removed).length;
      report.pruned.roots += removed;
    }
    if (Date.parse(r.started_at) < nowMs - ROUND_DIR_DAYS * DAY_MS) {
      const dir = roundDirOf(o.layout, r.id);
      if (dirname(dir) !== o.layout.roundsDir || !existsSync(dir)) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
        rmSync(dir, { recursive: true, force: true });
        report.pruned.round_dirs++;
        insertEvent(db, 'round-dir-pruned', r.id, { dir: relative(o.layout.roundsDir, dir), days: ROUND_DIR_DAYS });
      } catch (error) {
        report.errors.push(`round ${r.id}: its dir could not be pruned: ${errText(error)}`);
      }
    }
  }
}

/** The states a status line lists as open work. */
export const OPEN_STATES: readonly LedgerState[] = ['running', 'posting', 'needs-ruling', 'failed'];
