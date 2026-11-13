import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeatAdapter, SeatAdapters } from '../adapters/index.js';
import type { FailureClass, LegHandle, LegText, Occupant, Preflight, Ratification, RoundCtx } from '../adapters/types.js';
import type { FallbackConfig, SeatConfig } from '../config/schema.js';
import { parseLegReply, type LegReply } from '../parse/index.js';
import { sweepResidue } from '../root/seal.js';
import type { Store } from '../store/open.js';
import { readRoundInputs, readSealed, type RoundInputs } from './prepare.js';
import { getLegs, insertEvent, now, upsertOccupant, type LegStatus } from './records.js';

/*
 * The round runner (plan 3.1 steps 4-8): preflight every seat serially (auth refresh is serial, plan 4.3), launch
 * the legs in parallel, poll each on its record-based done signal under the wall-clock caps, classify failures
 * (4.4), move a seat to its fallback within the round on `usage_limit` or `auth` (or when its primary fails
 * preflight), relaunch a leg once on `capacity`, `transport`, `empty` or `timeout` (time permitting), ratify every
 * leg (4.5), run the residue sweep, parse each ratified reply (P1), and settle quorum. Everything goes to the run
 * store as it happens (8.1).
 */

/** What decides the next step after a leg that did not ratify (plan 3.1 step 6, 4.4). */
export type NextStep = { kind: 'fallback' } | { kind: 'relaunch' } | { kind: 'out'; why: string };

export interface StepInput {
  failureClass: FailureClass;
  role: 'primary' | 'fallback';
  attempt: number;
  fallback: FallbackConfig | undefined;
  /** Milliseconds left in the round's budget. */
  timeLeftMs: number;
  /** The smallest leg worth launching. */
  minLegMs: number;
  /** The root still hashes to its sealed value. */
  rootClean: boolean;
}

/** Plan 4.4's effect column, with the fallback rule of 3.1 step 6 and D10. */
export function nextStep(s: StepInput): NextStep {
  switch (s.failureClass) {
    case 'usage_limit':
    case 'auth':
      if (s.role === 'primary' && s.fallback !== undefined && (s.fallback.on as readonly string[]).includes(s.failureClass)) return { kind: 'fallback' };
      return { kind: 'out', why: s.role === 'fallback' ? `the fallback leg failed: ${s.failureClass}` : `${s.failureClass} and no fallback configured for it` };
    case 'capacity':
    case 'transport':
    case 'empty':
    case 'timeout':
      if (s.attempt > 1) return { kind: 'out', why: `${s.failureClass} again after one relaunch` };
      if (!s.rootClean) return { kind: 'out', why: `${s.failureClass}, but the root changed, so no relaunch into it` };
      if (s.timeLeftMs < s.minLegMs) return { kind: 'out', why: `${s.failureClass}, and no time remains in the round for a relaunch` };
      return { kind: 'relaunch' };
    case 'model':
    case 'contaminated':
    case 'setup':
      return { kind: 'out', why: `${s.failureClass}: not a review, no relaunch` };
  }
}

/** Quorum (plan 3.1 step 8, 3.4 rule 6): 2+ ratified legs is a council, 1 is a labelled solo review, 0 fails. */
export type QuorumLabel = 'council' | 'solo' | 'none';

export function quorumOf(ratified: number): QuorumLabel {
  return ratified >= 2 ? 'council' : ratified === 1 ? 'solo' : 'none';
}

export interface RunOptions {
  adapters: SeatAdapters;
  /** The environment the legs' adapters scrub. Default: `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** How often each leg is polled. Default 1000 ms. */
  pollMs?: number | undefined;
  /** Overrides the leg cap from the roster snapshot (`council.leg_timeout_minutes`); tests use seconds. */
  legTimeoutMs?: number | undefined;
  /** The round's wall-clock budget for all its legs, relaunches and fallbacks. Default: twice the leg cap. */
  roundBudgetMs?: number | undefined;
  /** Grace past a leg's cap before the runner cancels it itself (the supervisor's cap is the first line). */
  capGraceMs?: number | undefined;
  /** Cancels every running leg; the round fails. */
  signal?: AbortSignal | undefined;
}

export interface LegResult {
  legId: number;
  seat: string;
  role: 'primary' | 'fallback';
  attempt: number;
  status: LegStatus;
  failureClass: FailureClass | null;
  reply: LegReply | null;
  legDir: string;
  startedAt: string;
  finishedAt: string;
  /** When the leg's process was last known alive (ms): the end of its poll loop, or launch time if never launched. */
  endedAtMs: number;
  /** The leg's own ratification saw the root changed. */
  rootMutated: boolean;
}

export interface RunResult {
  roundId: number;
  status: 'awaiting-adjudication' | 'failed';
  quorum: QuorumLabel;
  ratified: number;
  legs: LegResult[];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function occupantOf(seat: SeatConfig | FallbackConfig): Occupant {
  const o: Occupant = { backend: seat.backend, model: seat.model, effort: seat.effort, authHome: seat.auth_home };
  if ('sandbox' in seat && seat.sandbox !== undefined) o.sandbox = seat.sandbox;
  return o;
}

function nonNeg(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

const bit = (b: boolean | null | undefined): number | null => (b === null || b === undefined ? null : b ? 1 : 0);

/**
 * Runs the legs of a prepared round to settlement and records everything. Never throws for a leg's failure: a leg
 * that cannot run is a recorded leg with its failure class.
 */
export async function runLegs(store: Store, roundDir: string, options: RunOptions): Promise<RunResult> {
  const { db } = store;
  const inputs = readRoundInputs(roundDir);
  const sealed = readSealed(roundDir);
  const pollMs = options.pollMs ?? 1000;
  const legTimeoutMs = options.legTimeoutMs ?? inputs.legTimeoutMs;
  const budgetMs = options.roundBudgetMs ?? legTimeoutMs * 2;
  const deadline = Date.now() + budgetMs;
  const minLegMs = Math.min(60_000, Math.max(1, Math.floor(legTimeoutMs / 5)));
  const capGraceMs = options.capGraceMs ?? 60_000;
  const env = options.env ?? process.env;
  const results: LegResult[] = [];
  const running = new Map<string, { adapter: SeatAdapter; handle: LegHandle }>();

  // The residue sweep (plan 3.1 step 7). `lastClean` is when the root was last seen unchanged: a leg that ended
  // before it cannot have made a later change.
  let lastClean = Date.now();
  const sweep = (): { unchanged: boolean; changes: string[] } => {
    const at = Date.now();
    try {
      const r = sweepResidue(sealed);
      if (r.unchanged) lastClean = at;
      return { unchanged: r.unchanged, changes: r.changes.map((c) => `${c.change} ${c.path}`) };
    } catch (error) {
      // A root that cannot be read is not the sealed root: fail closed.
      return { unchanged: false, changes: [`unreadable: ${error instanceof Error ? error.message : String(error)}`] };
    }
  };

  const onAbort = (): void => {
    for (const { adapter, handle } of running.values()) void adapter.cancel(handle).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const ctxFor = (legDir: string, timeoutMs: number): RoundCtx => ({
    root: inputs.root,
    legDir,
    nonce: inputs.nonce,
    briefFile: inputs.briefFile,
    timeoutMs,
    env,
    rootUnchanged: sweep,
  });

  const preflight = async (adapter: SeatAdapter, o: Occupant, legDir: string): Promise<Preflight> => {
    try {
      return await adapter.preflight(o, ctxFor(legDir, legTimeoutMs));
    } catch (error) {
      return {
        ok: false,
        backend: o.backend,
        cliVersion: null,
        enforcement: adapter.enforcement(null),
        checks: [{ name: 'preflight', status: 'fail', detail: error instanceof Error ? error.message : String(error) }],
        userOwned: [],
        failureClass: 'setup',
        reason: `preflight threw: ${error instanceof Error ? error.message : String(error)}`,
        data: {},
      };
    }
  };

  const legDirFor = (seat: string, role: string, attempt: number): string => {
    const dir = join(roundDir, 'legs', `${seat}-${role}-${attempt}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };

  const insertLeg = (seat: string, role: 'primary' | 'fallback', attempt: number, adapter: SeatAdapter | undefined, o: Occupant, status: LegStatus, legDir: string): number => {
    const occupantId = upsertOccupant(db, o, adapter?.transport ?? 'headless');
    const r = db
      .prepare('INSERT INTO legs (round_id, seat_id, occupant_id, attempt, role, status, started_at, record_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(inputs.roundId, seat, occupantId, attempt, role, status, now(), legDir);
    return Number(r.lastInsertRowid);
  };

  const finishLeg = (
    legId: number,
    fields: {
      status: LegStatus;
      failureClass: FailureClass | null;
      enforcement?: string | null;
      cliVersion?: string | null;
      reply?: LegReply | null;
      r?: Ratification | null;
    },
  ): string => {
    const r = fields.r ?? null;
    const finishedAt = now();
    db.prepare(
      `UPDATE legs SET status = ?, failure_class = ?, enforcement_label = ?, cli_version = ?, verdict_raw = ?, model_observed = ?,
        effort_observed = ?, cwd_ok = ?, tools_used_json = ?, tools_offered_json = ?, root_mutated = ?, nonce_seen = ?,
        finished_at = ?, duration_ms = ?, tokens_in = ?, tokens_out = ?, cost_usd = ?, credits = ?, quota_used_pct = ?,
        quota_note = ?, record_path = coalesce(?, record_path)
       WHERE id = ?`,
    ).run(
      fields.status,
      fields.failureClass,
      fields.enforcement ?? r?.enforcement ?? null,
      r?.cliVersion ?? fields.cliVersion ?? null,
      fields.reply ? fields.reply.verdict.verdict : null,
      r?.modelObserved ?? null,
      r?.effortObserved ?? null,
      r ? bit(r.cwdOk) : null,
      r ? JSON.stringify(r.toolsUsed) : null,
      r ? JSON.stringify(r.toolsOffered) : null,
      r ? bit(r.rootMutated) : null,
      r ? bit(r.nonceSeen) : null,
      finishedAt,
      nonNeg(r?.durationMs),
      nonNeg(r?.tokensIn),
      nonNeg(r?.tokensOut),
      nonNeg(r?.costUsd),
      nonNeg(r?.credits),
      nonNeg(r?.quotaUsedPct),
      r?.quotaNote ?? null,
      r?.recordPath ?? null,
      legId,
    );
    return finishedAt;
  };

  /** One leg from preflight to ratification. */
  const runOne = async (
    seat: SeatConfig,
    role: 'primary' | 'fallback',
    attempt: number,
    o: Occupant,
    pre: Preflight | undefined,
  ): Promise<LegResult> => {
    const adapter = options.adapters(o.backend);
    const legDir = legDirFor(seat.id, role, attempt);
    const startedAt = now();
    const base = { seat: seat.id, role, attempt, legDir, startedAt, endedAtMs: Date.now(), rootMutated: false };
    if (!adapter) {
      const legId = insertLeg(seat.id, role, attempt, undefined, o, 'PREFLIGHT_FAIL', legDir);
      const finishedAt = finishLeg(legId, { status: 'PREFLIGHT_FAIL', failureClass: 'setup' });
      insertEvent(db, 'preflight-fail', inputs.roundId, { seat: seat.id, role, attempt, reason: `no adapter for ${o.backend}` });
      return { ...base, legId, status: 'PREFLIGHT_FAIL', failureClass: 'setup', reply: null, finishedAt };
    }
    const p = pre ?? (await preflight(adapter, o, legDir));
    writeFileSync(join(legDir, 'preflight.json'), `${JSON.stringify(p, null, 2)}\n`);
    if (!p.ok) {
      const legId = insertLeg(seat.id, role, attempt, adapter, o, 'PREFLIGHT_FAIL', legDir);
      const cls = p.failureClass ?? 'setup';
      const finishedAt = finishLeg(legId, { status: 'PREFLIGHT_FAIL', failureClass: cls, enforcement: p.enforcement, cliVersion: p.cliVersion });
      insertEvent(db, 'preflight-fail', inputs.roundId, { seat: seat.id, role, attempt, failure_class: cls, reason: p.reason });
      return { ...base, legId, status: 'PREFLIGHT_FAIL', failureClass: cls, reply: null, finishedAt };
    }
    const timeoutMs = Math.min(legTimeoutMs, Math.max(1, deadline - Date.now()));
    const ctx = ctxFor(legDir, timeoutMs);
    const legId = insertLeg(seat.id, role, attempt, adapter, o, 'RUNNING', legDir);
    let handle: LegHandle;
    try {
      handle = await adapter.launch(o, ctx, p);
    } catch (error) {
      const finishedAt = finishLeg(legId, { status: 'FAIL', failureClass: 'setup', enforcement: p.enforcement, cliVersion: p.cliVersion });
      insertEvent(db, 'launch-fail', inputs.roundId, { seat: seat.id, role, attempt, error: error instanceof Error ? error.message : String(error) });
      return { ...base, legId, status: 'FAIL', failureClass: 'setup', reply: null, finishedAt };
    }
    const key = `${seat.id}-${role}-${attempt}`;
    running.set(key, { adapter, handle });
    const launchedAt = Date.now();
    try {
      for (;;) {
        const state = await adapter.poll(handle);
        if (state.status === 'done') break;
        if (options.signal?.aborted === true || Date.now() > launchedAt + timeoutMs + capGraceMs) {
          await adapter.cancel(handle).catch(() => undefined);
        }
        await sleep(pollMs);
      }
    } finally {
      running.delete(key);
    }
    const endedAtMs = Date.now();
    let text: LegText = { text: null, fromNonce: false, source: 'none' };
    try {
      text = await adapter.collect(handle);
    } catch (error) {
      insertEvent(db, 'collect-fail', inputs.roundId, { seat: seat.id, role, attempt, error: error instanceof Error ? error.message : String(error) });
    }
    let r: Ratification | null = null;
    try {
      r = await adapter.ratify(handle, ctx);
    } catch (error) {
      insertEvent(db, 'ratify-fail', inputs.roundId, { seat: seat.id, role, attempt, error: error instanceof Error ? error.message : String(error) });
    }
    if (text.text !== null) writeFileSync(join(legDir, 'answer.md'), text.text);
    if (r) writeFileSync(join(legDir, 'ratification.json'), `${JSON.stringify(r, null, 2)}\n`);
    let cls: FailureClass | null;
    let status: LegStatus;
    let reply: LegReply | null = null;
    if (r?.ok === true) {
      reply = parseLegReply(text.text ?? '', inputs.nonce);
      writeFileSync(join(legDir, 'reply.json'), `${JSON.stringify(reply, null, 2)}\n`);
      // Plan 4.4 `empty`: ratified, but no answer, or no verdict and no findings. Not a review.
      const empty = text.text === null || (reply.verdict.verdict === 'none' && reply.findings.findings.length === 0);
      cls = empty ? 'empty' : null;
      status = empty ? 'FAIL' : 'PASS';
    } else {
      cls = r?.failureClass ?? safeClassify(adapter, handle) ?? 'setup';
      status = r?.status === 'CONTAMINATED' || cls === 'contaminated' ? 'CONTAMINATED' : 'FAIL';
    }
    const finishedAt = finishLeg(legId, { status, failureClass: cls, enforcement: p.enforcement, cliVersion: p.cliVersion, reply, r });
    return { ...base, legId, status, failureClass: cls, reply, finishedAt, endedAtMs, rootMutated: r?.rootMutated === true };
  };

  /** A seat's chain: its primary, then a relaunch or its fallback as plan 4.4 allows. */
  const runSeat = async (seat: SeatConfig, firstPre: Preflight | undefined): Promise<void> => {
    let role: 'primary' | 'fallback' = 'primary';
    let o = occupantOf(seat);
    let attempt = 1;
    let pre = firstPre;
    for (;;) {
      if (options.signal?.aborted === true) return;
      if (Date.now() + minLegMs > deadline) {
        insertEvent(db, 'seat-out', inputs.roundId, { seat: seat.id, role, attempt, why: 'no time remains in the round for this leg' });
        return;
      }
      const leg = await runOne(seat, role, attempt, o, pre);
      pre = undefined;
      results.push(leg);
      if (leg.status === 'PASS') return;
      const cls = leg.failureClass ?? 'setup';
      // Plan 3.1 step 4: a primary that fails preflight goes straight to its fallback, whatever the class.
      const step: NextStep =
        leg.status === 'PREFLIGHT_FAIL'
          ? role === 'primary' && seat.fallback !== undefined
            ? { kind: 'fallback' }
            : { kind: 'out', why: `preflight failed: ${cls}` }
          : nextStep({
              failureClass: cls,
              role,
              attempt,
              fallback: seat.fallback,
              timeLeftMs: deadline - Date.now(),
              minLegMs,
              rootClean: cls === 'contaminated' ? false : sweep().unchanged,
            });
      if (step.kind === 'out') {
        insertEvent(db, 'seat-out', inputs.roundId, { seat: seat.id, role, attempt, failure_class: cls, why: step.why });
        return;
      }
      if (step.kind === 'fallback' && seat.fallback !== undefined) {
        insertEvent(db, 'fallback', inputs.roundId, { seat: seat.id, failure_class: cls, from: o, to: occupantOf(seat.fallback), preflight: leg.status === 'PREFLIGHT_FAIL' });
        role = 'fallback';
        o = occupantOf(seat.fallback);
        attempt = 1;
      } else {
        insertEvent(db, 'relaunch', inputs.roundId, { seat: seat.id, role, attempt: attempt + 1, failure_class: cls });
        attempt += 1;
      }
    }
  };

  try {
    // Preflight every primary serially, before any launch: parallel legs racing a token refresh was a measured
    // failure (plan 4.3).
    const firstPre: Array<Preflight | undefined> = [];
    for (const seat of inputs.roster.seats) {
      const o = occupantOf(seat);
      const adapter = options.adapters(o.backend);
      // In the first leg's own dir: some backends warm per-leg state at preflight that the launch then uses.
      firstPre.push(adapter ? await preflight(adapter, o, legDirFor(seat.id, 'primary', 1)) : undefined);
    }
    await Promise.all(inputs.roster.seats.map((seat, i) => runSeat(seat, firstPre[i])));

    // Final residue sweep: a change fails every leg that was running after the root was last seen unchanged.
    const final = sweep();
    if (!final.unchanged) {
      const suspects = residueSuspects(results, lastClean);
      for (const leg of suspects) {
        db.prepare("UPDATE legs SET status = 'CONTAMINATED', failure_class = 'contaminated', root_mutated = 1 WHERE id = ?").run(leg.legId);
        leg.status = 'CONTAMINATED';
        leg.failureClass = 'contaminated';
      }
      insertEvent(db, 'residue', inputs.roundId, { changes: final.changes.slice(0, 50), failed_legs: suspects.map((l) => l.legId) });
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
  }

  return settle(store, inputs, results, options.signal?.aborted === true);
}

/**
 * Which ratified legs a change found by the final residue sweep fails (plan 3.1 step 7: "every leg that could have
 * made it"): a leg whose process was alive after the root was last seen unchanged. When no such leg exists and no
 * leg's own ratification caught the change, it came from outside every leg's window (a process that escaped its
 * group, or an outside writer), so no ratified leg is trusted: all of them fail.
 */
export function residueSuspects<T extends Pick<LegResult, 'status' | 'endedAtMs' | 'rootMutated'>>(legs: readonly T[], lastCleanMs: number): T[] {
  const pass = legs.filter((l) => l.status === 'PASS');
  const alive = pass.filter((l) => l.endedAtMs > lastCleanMs);
  if (alive.length > 0) return alive;
  return legs.some((l) => l.rootMutated) ? [] : pass;
}

function safeClassify(adapter: SeatAdapter, handle: LegHandle): FailureClass | null {
  try {
    return adapter.classify(handle);
  } catch {
    return null;
  }
}

/** Records the parsed findings of every ratified leg and settles the round's quorum and status. */
function settle(store: Store, inputs: RoundInputs, results: LegResult[], aborted: boolean): RunResult {
  const { db } = store;
  const ratified = results.filter((l) => l.status === 'PASS');
  const insert = db.prepare(
    `INSERT INTO leg_findings (leg_id, local_id, severity_raw, severity, path, line, title, extracted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'leg')`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const leg of ratified) {
      const f = leg.reply?.findings;
      if (f?.extracted_by !== 'leg') continue;
      for (const x of f.findings) insert.run(leg.legId, x.id, x.severity_raw, x.severity, x.path, x.line !== null && x.line >= 1 ? x.line : null, x.title);
    }
    const quorum = aborted ? 'none' : quorumOf(ratified.length);
    const status = quorum === 'none' ? 'failed' : 'awaiting-adjudication';
    db.prepare(`UPDATE rounds SET status = ?, finished_at = CASE WHEN ? = 'failed' THEN ? ELSE finished_at END WHERE id = ?`).run(status, status, now(), inputs.roundId);
    insertEvent(db, 'legs-settled', inputs.roundId, {
      quorum,
      ratified: ratified.map((l) => l.seat),
      aborted,
      legs: getLegs(db, inputs.roundId).map((l) => ({ id: l.id, seat: l.seat_id, role: l.role, attempt: l.attempt, status: l.status, failure_class: l.failure_class })),
    });
    db.exec('COMMIT');
    return { roundId: inputs.roundId, status, quorum, ratified: ratified.length, legs: results };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** True when a leg dir holds a ratified answer (for summaries). */
export function hasAnswer(legDir: string): boolean {
  return existsSync(join(legDir, 'answer.md'));
}
