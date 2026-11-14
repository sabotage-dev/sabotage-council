import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeatAdapters } from '../adapters/index.js';
import { adjudicate, AdjudicateError, adjudicateHeadless, HeadlessError, type HeadlessResult } from '../adjudicate/index.js';
import { loadConfig, type AdapterRegistry, type ConfigIssue } from '../config/index.js';
import {
  failRound,
  prepareRound,
  removeRoundRoots,
  resolveDiffTarget,
  resolvePlanTarget,
  roundSummary,
  runWorker,
  spawnWorker,
  waitRound,
  type DataLayout,
  type ResolvedTarget,
  type RoundSummary,
} from '../engine/index.js';
import { openStore, type Store } from '../store/index.js';

/*
 * `round start | wait | show | run` and `adjudicate` (plan 7.1). `round start` prepares the round in the foreground
 * (target, number, root, brief) and hands the legs to a detached worker, so it returns at once with the round id.
 */

export interface RoundIo {
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
  setExitCode: (code: number) => void;
  adapters?: SeatAdapters | undefined;
  /** Model-id validation at config load. Default: the adapters' own `listModels()`. */
  registry?: AdapterRegistry | undefined;
  /** Where target paths resolve. Default: the process's cwd. */
  cwd?: string | undefined;
  /**
   * Starts the worker for a prepared round. Default: a detached `round run <id>` of this binary. Tests run it in
   * process instead.
   */
  startWorker?: ((roundId: number, paths: StorePaths) => void) | undefined;
}

export interface StorePaths {
  configPath: string;
  dbPath: string;
  rootsPath: string;
}

export function layoutOf(paths: Pick<StorePaths, 'dbPath' | 'rootsPath'>): DataLayout {
  return { dbPath: paths.dbPath, roundsDir: join(dirname(paths.dbPath), 'rounds'), rootsDir: paths.rootsPath };
}

/** Exit codes: 0 done, 1 an error or a failed round, 3 `round wait --timeout` ran out with the round still running. */
export const EXIT_STILL_RUNNING = 3;

function registryOf(adapters: SeatAdapters | undefined): AdapterRegistry | undefined {
  if (!adapters) return undefined;
  return { lister: (backend) => adapters(backend) };
}

function formatIssue(issue: ConfigIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

const CLI_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

export function defaultStartWorker(env: NodeJS.ProcessEnv) {
  return (roundId: number, paths: StorePaths): void => {
    const layout = layoutOf(paths);
    spawnWorker(CLI_ENTRY, ['round', 'run', String(roundId), '--db', paths.dbPath, '--roots', paths.rootsPath], join(layout.roundsDir, String(roundId)), env);
  };
}

export interface StartArgs {
  mode: 'plan' | 'diff';
  /** plan: the file; diff: the optional `<base>..<head>` range. */
  target: string | undefined;
  context: string[];
  facts: string[];
  questions: string[];
  json: boolean;
  /** diff with an explicit range: include the uncommitted work tree (fold row 10). */
  uncommitted?: boolean | undefined;
  /** diff: `--series <name>`, the series the target is keyed by (round 2 row 1). */
  series?: string | undefined;
  /** Tests pin the nonce. */
  nonce?: string | undefined;
}

export async function roundStart(io: RoundIo, paths: StorePaths, args: StartArgs): Promise<number | null> {
  const config = await loadConfig(paths.configPath, { registry: io.registry ?? registryOf(io.adapters) });
  for (const w of config.warnings) io.write(`warn  ${formatIssue(w)}`);
  if (!config.ok) {
    io.write(`config ${paths.configPath} has ${config.errors.length} error(s):`);
    for (const e of config.errors) io.write(`  ${formatIssue(e)}`);
    io.setExitCode(1);
    return null;
  }
  const cwd = io.cwd ?? process.cwd();
  let target: ResolvedTarget;
  try {
    if (args.mode === 'plan') {
      if (args.target === undefined) throw new Error('plan needs a file');
      target = resolvePlanTarget(cwd, args.target, args.context, { env: io.env });
    } else {
      if (args.context.length > 0) throw new Error('--context is a plan-mode option');
      target = resolveDiffTarget(cwd, args.target, { env: io.env, uncommitted: args.uncommitted, series: args.series });
    }
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
    return null;
  }
  for (const w of target.warnings) io.write(`warn  ${w}`);
  const store = openStore(paths.dbPath);
  try {
    const prepared = prepareRound(store, {
      config: config.config,
      configPath: paths.configPath,
      layout: layoutOf(paths),
      target,
      facts: args.facts,
      questions: args.questions,
      nonce: args.nonce,
    });
    const i = prepared.inputs;
    try {
      (io.startWorker ?? defaultStartWorker(io.env))(i.roundId, paths);
    } catch (error) {
      // The round is prepared but no worker runs it: fail it, remove only its own roots, and name it (fold row 13).
      failRound(store, i.roundId, 'worker-start', error instanceof Error ? error.message : String(error));
      removeRoundRoots(layoutOf(paths), i.roundId);
      io.write(`error: round ${i.roundId} failed: its worker did not start (${error instanceof Error ? error.message : String(error)})`);
      io.setExitCode(1);
      return null;
    }
    if (args.json) {
      io.write(
        JSON.stringify({
          round_id: i.roundId,
          round_no: i.roundNo,
          mode: i.mode,
          target: i.label,
          head_sha: i.head,
          snapshot: i.snapshot,
          rule: i.rule,
          scope: i.scope,
          baseline_sha: i.baseline,
          round_dir: dirname(i.briefFile),
          brief_path: i.briefFile,
          next: `sabotage-council round wait ${i.roundId}`,
        }),
      );
    } else {
      io.write(String(i.roundId));
    }
    return i.roundId;
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
    return null;
  } finally {
    store.close();
  }
}

function withStore<T>(paths: StorePaths, fn: (store: Store) => T): T {
  const store = openStore(paths.dbPath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

/** `round run <id>`: the worker. SIGTERM or SIGINT cancels every running leg and fails the round. */
export async function roundRun(io: RoundIo, paths: StorePaths, roundId: number): Promise<void> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  const store = openStore(paths.dbPath);
  try {
    const result = await runWorker(store, layoutOf(paths), roundId, { adapters: io.adapters ?? (() => undefined), env: io.env, signal: controller.signal });
    io.write(`round ${roundId}: ${result.status}, quorum ${result.quorum} (${result.ratified} ratified)`);
    io.setExitCode(result.status === 'failed' ? 1 : 0);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    store.close();
  }
}

/** `round wait <id>`: blocks until the legs settle, then prints the JSON summary for the main loop. */
export async function roundWait(io: RoundIo, paths: StorePaths, roundId: number, timeoutMinutes: number | undefined, pollMs?: number): Promise<void> {
  const store = openStore(paths.dbPath);
  try {
    const { settled, summary } = await waitRound(store, layoutOf(paths), roundId, {
      timeoutMs: timeoutMinutes === undefined ? undefined : timeoutMinutes * 60_000,
      pollMs,
    });
    io.write(JSON.stringify(summary, null, 2));
    io.setExitCode(!settled ? EXIT_STILL_RUNNING : summary.status === 'failed' ? 1 : 0);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  } finally {
    store.close();
  }
}

/** `round show <id>`: the summary, as text or (`--json`) the same JSON `round wait` prints. */
export function roundShow(io: RoundIo, paths: StorePaths, roundId: number, json: boolean): void {
  try {
    const summary = withStore(paths, (store) => roundSummary(store, layoutOf(paths), roundId));
    if (json) io.write(JSON.stringify(summary, null, 2));
    else for (const line of renderSummary(summary)) io.write(line);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  }
}

/** A record's detail on one line, cut to `max` characters: a failed check may quote a multi-line output. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

const occupant = (l: { backend: string; model: string; effort: string | null }): string => [l.backend, l.model, l.effort].filter((p) => p !== null).join(' / ');

export function renderSummary(s: RoundSummary): string[] {
  const out: string[] = [];
  out.push(`round ${s.round_id}: ${s.mode} ${s.target}, round ${s.round_no} (rule ${s.rule}, ${s.scope} review)`);
  out.push(`head ${s.head_sha}${s.snapshot !== null ? ` (snapshot: ${s.snapshot})` : ''}`);
  if (s.baseline_sha !== null) out.push(`baseline ${s.baseline_sha}${s.full_round_reason !== null ? `: full review because ${s.full_round_reason}` : ''}`);
  out.push(`status ${s.status}`);
  out.push(`quorum ${s.quorum.label}: ${s.quorum.note}`);
  out.push('legs:');
  for (const l of s.legs) {
    const cost = l.cost_usd !== null ? ` $${l.cost_usd.toFixed(4)}` : l.credits !== null ? ` ${l.credits} credits` : '';
    const time = l.duration_ms !== null ? ` ${Math.round(l.duration_ms / 1000)} s` : '';
    const verdict = l.verdict_raw !== null ? ` verdict ${l.verdict_raw}${l.verdict_effective !== null && l.verdict_effective !== l.verdict_raw ? ` (effective ${l.verdict_effective})` : ''}` : '';
    const found = l.counted ? ` ${l.findings_extracted_by === 'adjudicator-needed' ? 'findings block needs extraction' : `${l.findings.length} finding(s)`}` : '';
    out.push(`  ${l.seat}  ${l.role} ${l.attempt}  ${occupant(l)}  ${l.status}${l.failure_class !== null ? ` (${l.failure_class})` : ''}${verdict}${found}${cost}${time}`);
    for (const c of l.ratification?.failed_checks ?? []) out.push(`        failed ${c.name}: ${oneLine(c.detail, 160)}`);
    for (const n of l.ratification?.notes ?? []) out.push(`        note ${oneLine(n, 200)}`);
  }
  if (s.earlier_items.length > 0) {
    out.push('earlier items:');
    for (const i of s.earlier_items) out.push(`  ${i.id} ${i.severity}${i.closed_context ? ' (closed context)' : ''}`);
  }
  if (s.pr !== undefined) {
    const p = s.pr;
    out.push(`pr: ${p.kind} round${p.dry_run ? ', dry run (never posts)' : ''}; marker "${String(p.marker)}"`);
    out.push(`posted: ${p.event_posted === null ? 'nothing yet' : `${p.event_posted}, review ${String(p.review_id)} at ${String(p.posted_at)}`}; next: ${p.next}`);
  }
  if (s.adjudication !== null) {
    const a = s.adjudication;
    out.push(`adjudication: verdict ${String(a.verdict)}, owed ${String(a.owed)}, approve ${a.approve === true ? 'yes' : 'no'}, needs ruling ${a.needs_ruling ? 'yes' : 'no'}`);
  }
  if (s.held !== null) out.push(`HELD for your ruling (${s.held.reason ?? 'no reason recorded'}): adjudicate it yourself`);
  if (s.adjudicator !== null) {
    const h = s.adjudicator;
    out.push(
      `headless adjudicator: model ${String(h.model_observed)}, effort ${String(h.effort_observed)}, $${(h.cost_usd ?? 0).toFixed(4)}, ${Math.round((h.duration_ms ?? 0) / 1000)} s, transcript ${String(h.transcript)}`,
    );
  }
  const adjCost = s.adjudicator?.cost_usd ?? 0;
  const parts = adjCost > 0 ? ` (legs $${(s.cost.usd - adjCost).toFixed(4)}, headless adjudicator $${adjCost.toFixed(4)})` : '';
  out.push(`cost $${s.cost.usd.toFixed(4)}${parts}${s.cost.credits > 0 ? `, ${s.cost.credits} credits` : ''}; wall ${s.wall_ms === null ? 'running' : `${Math.round(s.wall_ms / 1000)} s`}`);
  out.push(`round dir ${s.round_dir}`);
  return out;
}

/** `adjudicate <id> <ADJUDICATION.json>` (plan 7.1 step 4): validate, store, print the effective verdict. */
export function adjudicateCommand(io: RoundIo, paths: StorePaths, roundId: number, file: string, json: boolean, check = false): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    io.write(`error: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
    return;
  }
  try {
    withStore(paths, (store) => {
      const r = adjudicate(store, layoutOf(paths), roundId, text, { check });
      if (!r.outcome.ok) {
        if (json) io.write(JSON.stringify({ ok: false, round_id: roundId, errors: r.outcome.errors }, null, 2));
        else {
          io.write(`${check ? 'check failed' : 'rejected'}: ${r.outcome.errors.length} problem(s); nothing was stored`);
          for (const e of r.outcome.errors) io.write(`  ${e}`);
        }
        io.setExitCode(1);
        return;
      }
      const { adjudication: a, effective: e, warnings } = r.outcome;
      const solo = Object.keys(e.legVerdicts).length < 2;
      if (json) {
        io.write(
          JSON.stringify(
            {
              ok: true,
              stored: r.stored,
              round_id: roundId,
              verdict: e.verdict,
              verdict_given: a.verdict,
              owed: e.owed,
              approve: a.approve,
              needs_ruling: a.needs_ruling,
              quorum: solo ? 'solo' : 'council',
              legs_clear: e.legsClear,
              leg_verdicts: e.legVerdicts,
              majority_overrides: e.majorityOverrides,
              warnings,
            },
            null,
            2,
          ),
        );
      } else {
        io.write(`${check ? 'check passed (nothing stored): would store' : 'stored:'} round ${roundId} verdict ${e.verdict}${e.verdict !== a.verdict ? ` (given ${a.verdict}; 0 owed reads as SHIP)` : ''}, owed ${e.owed}, approve ${a.approve ? 'yes' : 'no'}, needs ruling ${a.needs_ruling ? 'yes' : 'no'}`);
        if (solo) io.write('SOLO REVIEW: one ratified leg; this is not a council verdict');
        io.write(`legs clear: ${e.legsClear ? 'yes' : 'no'}; leg verdicts: ${Object.entries(e.legVerdicts).map(([seat, v]) => `${seat} ${v}`).join(', ')}`);
        for (const w of warnings) io.write(`warn  ${w}`);
        // The proof of every majority override, for the user to see before the storing call (plan 3.4 rule 3).
        for (const o of e.majorityOverrides) io.write(`override ${o.id}: ${o.seats} seats up to ${o.seatSeverity} -> ${o.outcome} at ${o.severity}; proof: ${o.proof}`);
      }
    });
  } catch (error) {
    io.write(`error: ${error instanceof AdjudicateError || error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  }
}

/** Exit code of `adjudicate --headless` when the round is held for the user's ruling (plan 3.8). */
export const EXIT_NEEDS_RULING = 4;

export interface HeadlessIo extends RoundIo {
  claudeBin?: string | undefined;
  pollMs?: number | undefined;
}

function headlessJson(r: HeadlessResult): Record<string, unknown> {
  const e = r.stored?.outcome.ok === true ? r.stored.outcome : null;
  return {
    round_id: r.roundId,
    outcome: r.outcome,
    reason: r.reason,
    run_dir: r.runDir,
    bare: r.bare,
    preflight: r.preflight ? { ok: r.preflight.ok, cli_version: r.preflight.cliVersion, reason: r.preflight.reason } : null,
    launches: r.launches.map((l) => ({
      launch: l.n,
      dir: l.dir,
      status: l.ratification.status,
      failure_class: l.ratification.failureClass,
      failed_checks: l.ratification.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
      init_gate: l.initGate,
      model_observed: l.ratification.modelObserved,
      effort_observed: l.ratification.effortObserved,
      tools_offered: l.ratification.toolsOffered,
      tools_used: l.ratification.toolsUsed,
      permission_denials: l.ratification.permissionDenials,
      cost_usd: l.ratification.costUsd,
      duration_ms: l.exit.durationMs,
      transcript: l.ratification.recordPath,
      validation: l.validation,
    })),
    adjudication: e
      ? {
          verdict: e.effective.verdict,
          verdict_given: e.adjudication.verdict,
          owed: e.effective.owed,
          approve: e.adjudication.approve,
          needs_ruling: e.adjudication.needs_ruling,
          legs_clear: e.effective.legsClear,
          leg_verdicts: e.effective.legVerdicts,
        }
      : null,
  };
}

async function withStoreAsync<T>(paths: StorePaths, fn: (store: Store) => Promise<T>): Promise<T> {
  const store = openStore(paths.dbPath);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * `adjudicate <id> --headless` (P7, plan 6.4, 7.2): runs the restricted headless adjudicator on a settled round and
 * stores its result through the same store as `adjudicate <id> <file>`. The model and effort are `[adjudicator]`
 * in the config. Exit 0 adjudicated, 1 failed or refused, 4 held for the user's ruling.
 */
export async function adjudicateHeadlessCommand(io: HeadlessIo, paths: StorePaths, roundId: number, json: boolean): Promise<void> {
  const config = await loadConfig(paths.configPath, { registry: io.registry ?? registryOf(io.adapters) });
  // --json prints one document: the config's warnings go only to the text output.
  if (!json) for (const w of config.warnings) io.write(`warn  ${formatIssue(w)}`);
  if (!config.ok) {
    io.write(`config ${paths.configPath} has ${config.errors.length} error(s):`);
    for (const e of config.errors) io.write(`  ${formatIssue(e)}`);
    io.setExitCode(1);
    return;
  }
  const a = config.config.adjudicator;
  const model = a.model;
  if (model === undefined) {
    io.write(`error: [adjudicator] model is not set in ${paths.configPath}: the headless adjudicator needs a claude model (plan 5.2 example: claude-opus-5-5)`);
    io.setExitCode(1);
    return;
  }
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  try {
    const r = await withStoreAsync(paths, (store) =>
      adjudicateHeadless(store, layoutOf(paths), roundId, {
        settings: { model, effort: a.effort, maxTurns: a.max_turns, timeoutMs: a.timeout_minutes * 60_000 },
        bin: io.claudeBin,
        env: io.env,
        pollMs: io.pollMs,
        signal: controller.signal,
      }),
    );
    if (json) io.write(JSON.stringify(headlessJson(r), null, 2));
    else {
      io.write(`round ${roundId}: ${r.outcome}: ${r.reason}`);
      for (const l of r.launches) {
        const x = l.ratification;
        const cost = x.costUsd !== null ? `, $${x.costUsd.toFixed(4)}` : '';
        io.write(
          `  launch ${l.n}: ${x.status}${x.failureClass !== null ? ` (${x.failureClass})` : ''}, model ${String(x.modelObserved)}, effort ${String(x.effortObserved)}, tools ${x.toolsUsed.join(', ') || 'none'}, ${x.permissionDenials.length} denial(s)${cost}, ${Math.round(l.exit.durationMs / 1000)} s`,
        );
        if (l.initGate !== null) io.write(`        init gate: ${l.initGate}`);
        for (const c of x.checks.filter((k) => !k.ok)) io.write(`        failed ${c.name}: ${oneLine(c.detail, 160)}`);
        for (const e of l.validation?.errors ?? []) io.write(`        rejected ${oneLine(e, 200)}`);
        if (x.recordPath !== null) io.write(`        transcript ${x.recordPath}`);
      }
      const e = r.stored?.outcome.ok === true ? r.stored.outcome : null;
      if (e) {
        io.write(`stored: round ${roundId} verdict ${e.effective.verdict}, owed ${e.effective.owed}, approve ${e.adjudication.approve ? 'yes' : 'no'}, needs ruling ${e.adjudication.needs_ruling ? 'yes' : 'no'}`);
        if (Object.keys(e.effective.legVerdicts).length < 2) io.write('SOLO REVIEW: one ratified leg; this is not a council verdict');
      }
      io.write(`run dir ${r.runDir}`);
    }
    io.setExitCode(r.outcome === 'adjudicated' ? 0 : r.outcome === 'needs-ruling' ? EXIT_NEEDS_RULING : 1);
  } catch (error) {
    io.write(`error: ${error instanceof HeadlessError || error instanceof AdjudicateError || error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
  }
}
