import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, writeFileSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { SeatAdapters } from '../adapters/index.js';
import type { Store } from '../store/open.js';
import { roundDirOf, type DataLayout } from './prepare.js';
import { getRound, insertEvent, now } from './records.js';
import { runLegs, type RunOptions, type RunResult } from './run.js';
import { roundSummary, type RoundSummary } from './summary.js';

/*
 * The background side of `round start` (plan 7.1 step 1: a round can outlast a foreground shell call). `round start`
 * prepares the round, then starts a detached worker (`round run <id>`) that runs the legs and records them; `round
 * wait` watches the store until the legs settle, and notices a worker that died.
 */

export interface RunnerRecord {
  pid: number;
  started_at: string;
}

export function runnerFile(roundDir: string): string {
  return join(roundDir, 'runner.json');
}

/** Runs a prepared round's legs in this process: the body of `round run <id>`. */
export async function runWorker(store: Store, layout: DataLayout, roundId: number, options: RunOptions): Promise<RunResult> {
  const roundDir = roundDirOf(layout, roundId);
  const round = getRound(store.db, roundId);
  if (!round) throw new Error(`no round ${roundId} in the store`);
  if (round.status !== 'running') throw new Error(`round ${roundId} is ${round.status}, not running`);
  if (existsSync(runnerFile(roundDir))) throw new Error(`round ${roundId} already has a worker (${runnerFile(roundDir)})`);
  writeFileSync(runnerFile(roundDir), `${JSON.stringify({ pid: process.pid, started_at: now() } satisfies RunnerRecord)}\n`, { flag: 'wx' });
  try {
    const result = await runLegs(store, roundDir, options);
    writeFileSync(join(roundDir, 'summary.json'), `${JSON.stringify(roundSummary(store, layout, roundId), null, 2)}\n`);
    return result;
  } catch (error) {
    failRound(store, roundId, 'worker', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export function failRound(store: Store, roundId: number, stage: string, why: string): void {
  const { db } = store;
  db.prepare("UPDATE legs SET status = 'FAIL', failure_class = coalesce(failure_class, 'transport'), finished_at = coalesce(finished_at, ?) WHERE round_id = ? AND status = 'RUNNING'").run(now(), roundId);
  db.prepare("UPDATE rounds SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'running'").run(now(), roundId);
  insertEvent(db, 'round-failed', roundId, { stage, error: why });
}

/** Starts `round run <id>` detached, its output in the round dir. */
export function spawnWorker(entry: string, args: readonly string[], roundDir: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const log = openSync(join(roundDir, 'runner.log'), 'a');
  try {
    const child = spawn(process.execPath, [entry, ...args], { cwd: roundDir, env, detached: true, stdio: ['ignore', log, log] });
    child.unref();
    return child.pid ?? null;
  } finally {
    closeSync(log);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface WaitOptions {
  /** Give up after this long and report the round as still running. Absent: wait until it settles. */
  timeoutMs?: number | undefined;
  pollMs?: number | undefined;
  /** How long a round may show no worker record before it counts as dead. Default 60 s. */
  startGraceMs?: number | undefined;
}

/**
 * Blocks until the round's legs settle (any status but `running`) and returns its summary. A worker that died with
 * the round still running fails the round visibly (event `round-failed`, stage `worker-died`).
 */
export async function waitRound(store: Store, layout: DataLayout, roundId: number, options: WaitOptions = {}): Promise<{ settled: boolean; summary: RoundSummary }> {
  const pollMs = options.pollMs ?? 2000;
  const start = Date.now();
  const roundDir = roundDirOf(layout, roundId);
  for (;;) {
    const round = getRound(store.db, roundId);
    if (!round) throw new Error(`no round ${roundId} in the store`);
    if (round.status !== 'running') return { settled: true, summary: roundSummary(store, layout, roundId) };
    const file = runnerFile(roundDir);
    if (existsSync(file)) {
      const rec = JSON.parse(readFileSync(file, 'utf8')) as RunnerRecord;
      if (!alive(rec.pid)) {
        const again = getRound(store.db, roundId);
        if (again?.status === 'running') failRound(store, roundId, 'worker-died', `the worker (pid ${rec.pid}) is gone`);
        continue;
      }
    } else if (Date.now() - Date.parse(round.started_at) > (options.startGraceMs ?? 60_000)) {
      failRound(store, roundId, 'worker-died', 'no worker started for this round');
      continue;
    }
    if (options.timeoutMs !== undefined && Date.now() - start >= options.timeoutMs) {
      return { settled: false, summary: roundSummary(store, layout, roundId) };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export type { SeatAdapters, RoundSummary };
