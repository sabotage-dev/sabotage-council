import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CLAUDE_DECLARED, CLAUDE_FLOOR, claudeDecl } from '../adapters/claude/known.js';
import { CLAUDE_ENV_ALLOW, CLAUDE_ENV_SET } from '../adapters/claude/launch.js';
import { claudePreflight } from '../adapters/claude/preflight.js';
import { claudeProjectsDir } from '../adapters/claude/records.js';
import type { Preflight } from '../adapters/types.js';
import { roundDirOf, type DataLayout } from '../engine/prepare.js';
import { countedLegs, getRound, insertEvent, now } from '../engine/records.js';
import type { Store } from '../store/open.js';
import { runCommand, scrubEnv, startHeadless, type CommandRunner, type HeadlessExit, type HeadlessProcess } from '../transport/headless.js';
import { writeHook } from './hook.js';
import { assignStableIds } from './ids.js';
import { adjudicatorArgs, adjudicatorInitProblem, adjudicatorSettings, StreamWatch } from './launch.js';
import { adjudicatePrompt, repromptText, type PromptInput } from './prompt.js';
import { ratifyAdjudicatorRun, type AdjudicatorRatification } from './ratify.js';
import { adjudicate, AdjudicateError, type AdjudicateResult } from './store.js';
import { buildWorkspace, copyTreeHash, inputsTreeHash, removeWorkspace, type Workspace } from './workspace.js';

/*
 * The headless adjudicator (plan 6.4, 7.2): the engine launches Claude Code itself, read-only but for one output file,
 * to adjudicate a settled round when no user is in the loop (`auto`, P8), and for testing with
 * `sabotage-council adjudicate <id> --headless`. It composes the pieces P2-P5 built: the claude preflight, the
 * headless supervisor, the claude record readers, the P5 validator and store.
 *
 * One call:
 *   1. checks the round (a council round awaiting adjudication, not held for a ruling) and takes the round's
 *      adjudicator lock;
 *   2. preflights claude for the configured model and effort (version, login, isolation; no model call);
 *   3. builds the working copy: the sealed root copied and proven by its tree hash, `_council/` inputs and the
 *      `_mainloop/ADJUDICATION.json` placeholder;
 *   4. launches `claude -p` (launch.ts) with the prompt on stdin, reads `system/init` before the first turn and kills
 *      the run there (recorded `setup`, no adjudication) when it was offered anything beyond Read, Glob, Grep and Edit
 *      or is not in `dontAsk`;
 *   5. ratifies the run from its records (ratify.ts): a run that read or edited outside its bounds is CONTAMINATED and
 *      holds the round for the user;
 *   6. reads the output, replaces the placeholder finding ids with stable ones, and stores it through the P5 store,
 *      validated with no user in the loop; a rejection re-prompts once with the validator's errors, in a fresh
 *      session on the same copy, and a second rejection holds the round (`needs-ruling`, plan 3.8);
 *   7. records the adjudicator's observed model, tools, permission denials, cost, duration and transcript path on the
 *      round, and every launch as an `adjudicator-run` event.
 */

export class HeadlessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadlessError';
  }
}

/** `[adjudicator]` in the config (plan 5.2). */
export interface HeadlessSettings {
  model: string;
  effort: string;
  maxTurns: number;
  timeoutMs: number;
}

export interface HeadlessOptions {
  settings: HeadlessSettings;
  /** The claude binary. Default `claude` on PATH. */
  bin?: string | undefined;
  /** Runs the preflight commands. Default: the supervisor's command runner. */
  runner?: CommandRunner | undefined;
  /** The engine's environment, which the launch scrubs. Default `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /** How often the run's stream is read; the init gate is checked on every read. Default 25 ms. */
  pollMs?: number | undefined;
  /** Cancels the running launch; the call then reports `failed`. */
  signal?: AbortSignal | undefined;
  /** The Node binary that runs the PreToolUse hook. Default: the engine's own. */
  node?: string | undefined;
  /** Tests only: keep the working copy after the call. */
  keepWorkspace?: boolean | undefined;
  /** Tests only: runs on the working copy right after it is copied, before it is proven against the sealed tree. */
  afterCopy?: ((root: string) => void) | undefined;
}

export type HeadlessOutcome = 'adjudicated' | 'needs-ruling' | 'failed';

export interface LaunchRecord {
  n: number;
  dir: string;
  sessionId: string;
  /** Why the init gate stopped the run, or null when it passed. */
  initGate: string | null;
  exit: HeadlessExit;
  ratification: AdjudicatorRatification;
  /** The validator's verdict on what the launch wrote; null when nothing was read (the run did not ratify). */
  validation: { ok: boolean; errors: string[] } | null;
}

export interface HeadlessResult {
  roundId: number;
  outcome: HeadlessOutcome;
  reason: string;
  runDir: string;
  preflight: Preflight | null;
  launches: LaunchRecord[];
  /** The stored adjudication, when the outcome is `adjudicated`. */
  stored: AdjudicateResult | null;
  bare: boolean;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function pidIn(text: string): number {
  try {
    const pid = Number((JSON.parse(text) as { pid?: unknown }).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** Creates a file exclusively; false when it already exists. */
function createExclusive(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * One headless call per round at a time: `adjudicator/running.json` holds the owner's pid, created exclusively. A
 * lock whose process is gone is taken over exclusively (P7 round 1 row 10): the taker first creates
 * `running.json.takeover` exclusively, so takers run one at a time; it then re-reads the lock and replaces it (unlink,
 * then create exclusively) only while it still holds the stale content it judged. A taker that finds the lock changed
 * judges it again, so two callers that both saw the same dead owner never both run. `afterStaleRead` is for tests: it
 * runs between judging the lock stale and taking it over.
 */
export function takeAdjudicatorLock(adjDir: string, hooks: { afterStaleRead?: (() => void) | undefined } = {}): () => void {
  const file = join(adjDir, 'running.json');
  const takeover = `${file}.takeover`;
  const record = `${JSON.stringify({ pid: process.pid, started_at: now() })}\n`;
  const release = (): void => {
    if (readOrNull(file) === record) rmSync(file, { force: true });
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    if (createExclusive(file, record)) return release;
    const seen = readOrNull(file);
    if (seen === null) continue;
    const pid = pidIn(seen);
    if (pid > 0 && alive(pid)) throw new HeadlessError(`a headless adjudication of this round is already running (pid ${pid})`);
    hooks.afterStaleRead?.();
    if (!createExclusive(takeover, record)) {
      const holder = pidIn(readOrNull(takeover) ?? '');
      throw new HeadlessError(
        `another caller (pid ${holder}${holder > 0 && !alive(holder) ? ', no longer running' : ''}) is taking over a stale adjudicator lock of this round; if no headless run of this round is alive, remove ${takeover}`,
      );
    }
    try {
      // Still the stale lock judged above: replace it. Anything else (a new owner, or none): judge again.
      if (readOrNull(file) !== seen) continue;
      rmSync(file, { force: true });
      if (createExclusive(file, record)) return release;
    } finally {
      rmSync(takeover, { force: true });
    }
  }
  throw new HeadlessError('could not take the adjudicator lock of this round: it kept changing');
}

/** The next run dir, `adjudicator/h<n>`, created exclusively. */
function nextRunDir(adjDir: string): string {
  const used = readdirSync(adjDir)
    .map((n) => /^h([1-9][0-9]*)$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const dir = join(adjDir, `h${used.length === 0 ? 1 : Math.max(...used) + 1}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

function nonNeg(n: number | null | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * Records one launch on the round (plan 6.4): the observed model and effort and the transcript of the latest launch;
 * the tools and permission denials merged with what earlier launches, of this call or an earlier one, recorded (P7
 * round 1 row 7: a later clean launch never erases an earlier one's denials); and the cost, turns and time summed.
 */
function recordOnRound(store: Store, roundId: number, l: Omit<LaunchRecord, 'validation'>): void {
  const r = l.ratification;
  const row = store.db.prepare('SELECT adjudicator_tools_json, adjudicator_denials_json FROM rounds WHERE id = ?').get(roundId) as
    | { adjudicator_tools_json: string | null; adjudicator_denials_json: string | null }
    | undefined;
  let prior: { offered?: unknown; used?: unknown } = {};
  let priorDenials: unknown[] = [];
  try {
    prior = row?.adjudicator_tools_json ? (JSON.parse(row.adjudicator_tools_json) as typeof prior) : {};
  } catch {
    prior = {};
  }
  try {
    const parsed = row?.adjudicator_denials_json ? (JSON.parse(row.adjudicator_denials_json) as unknown) : [];
    priorDenials = Array.isArray(parsed) ? parsed : [];
  } catch {
    priorDenials = [];
  }
  const tools = {
    offered: [...new Set([...stringList(prior.offered), ...r.toolsOffered])].sort(),
    used: [...new Set([...stringList(prior.used), ...r.toolsUsed])].sort(),
  };
  const denials = [...priorDenials, ...r.permissionDenials];
  store.db
    .prepare(
      `UPDATE rounds SET adjudicator_model_observed = ?, adjudicator_effort_observed = ?, adjudicator_tools_json = ?, adjudicator_denials_json = ?,
         adjudicator_cost_usd = coalesce(adjudicator_cost_usd, 0) + ?, adjudicator_turns = coalesce(adjudicator_turns, 0) + ?,
         adjudicator_ms = coalesce(adjudicator_ms, 0) + ?, adjudicator_record_path = ?
       WHERE id = ?`,
    )
    .run(r.modelObserved, r.effortObserved, JSON.stringify(tools), JSON.stringify(denials), nonNeg(r.costUsd), Math.round(nonNeg(r.turns)), Math.round(nonNeg(l.exit.durationMs)), r.recordPath, roundId);
}

/** Holds the round for the user (plan 3.8): `needs_ruling` set, the round still awaiting adjudication. */
function hold(store: Store, roundId: number, detail: Record<string, unknown>): void {
  store.db.prepare("UPDATE rounds SET needs_ruling = 1 WHERE id = ? AND status = 'awaiting-adjudication'").run(roundId);
  insertEvent(store.db, 'needs-ruling', roundId, detail);
}

interface LaunchContext {
  ws: Workspace;
  runDir: string;
  bin: string;
  env: Record<string, string>;
  settings: HeadlessSettings;
  preflight: Preflight & { cliVersion: string };
  bare: boolean;
  projectsDir: string;
  pollMs: number;
  node: string;
  signal: AbortSignal | undefined;
}

/** One `claude -p` launch, from the prompt to its ratification. */
async function launchOnce(c: LaunchContext, n: number, prompt: string): Promise<Omit<LaunchRecord, 'validation'>> {
  const dir = join(c.runDir, `launch-${n}`);
  mkdirSync(dir, { mode: 0o700 });
  const sessionId = randomUUID();
  const files = {
    prompt: join(dir, 'prompt.md'),
    settings: join(dir, 'settings.json'),
    stream: join(dir, 'stream.jsonl'),
    stderr: join(dir, 'stderr.log'),
    process: join(dir, 'process.json'),
  };
  writeFileSync(files.prompt, prompt);
  // The hook and its log live in the launch dir, outside the working copy; `--bare` skips hooks, so it has none.
  const hook = c.bare ? null : writeHook(dir, c.ws.root, c.node);
  writeFileSync(files.settings, `${JSON.stringify(adjudicatorSettings(hook), null, 2)}\n`);
  const decl = claudeDecl(c.preflight.cliVersion) ?? (CLAUDE_DECLARED[CLAUDE_FLOOR] as NonNullable<ReturnType<typeof claudeDecl>>);
  const watch = new StreamWatch(files.stream);
  let initGate: string | null = null;
  let gateChecked = false;
  let proc: HeadlessProcess | null = null;
  proc = startHeadless({
    command: c.bin,
    args: adjudicatorArgs({ model: c.settings.model, effort: c.settings.effort, sessionId, settingsFile: files.settings, decl, bare: c.bare, maxTurns: c.settings.maxTurns }),
    cwd: c.ws.root,
    env: c.env,
    stdinFile: files.prompt,
    stdoutFile: files.stream,
    stderrFile: files.stderr,
    timeoutMs: c.settings.timeoutMs,
    pollMs: c.pollMs,
    recordFile: files.process,
    isDone: () => {
      const s = watch.poll();
      if (!gateChecked && s.init !== null) {
        gateChecked = true;
        const problem = adjudicatorInitProblem(s.init);
        if (problem !== null) {
          initGate = problem;
          // SIGKILL at once: a SIGTERM grace would give the first turn time to run a tool.
          void proc?.cancel({ hard: true });
        }
      }
      return s.result;
    },
  });
  const onAbort = (): void => void proc?.cancel();
  c.signal?.addEventListener('abort', onAbort, { once: true });
  let exit: HeadlessExit;
  try {
    exit = await proc.exited;
  } finally {
    c.signal?.removeEventListener('abort', onAbort);
  }
  const ratification = ratifyAdjudicatorRun({
    root: c.ws.root,
    model: c.settings.model,
    effort: c.settings.effort,
    sessionId,
    cliVersion: c.preflight.cliVersion,
    streamFile: files.stream,
    stderrFile: files.stderr,
    projectsDir: c.projectsDir,
    hookLog: hook?.log ?? null,
    timedOut: exit.timedOut,
    initGate,
    output: c.ws.output,
    copyUnchanged: () => {
      try {
        const tree = copyTreeHash(c.ws.root);
        const inputs = inputsTreeHash(c.ws.root);
        const changes = [...(tree !== c.ws.treeHash ? ['the reviewed tree'] : []), ...(inputs !== c.ws.inputsHash ? ['_council/'] : [])];
        return { unchanged: changes.length === 0, changes };
      } catch (error) {
        return { unchanged: false, changes: [`unreadable: ${error instanceof Error ? error.message : String(error)}`] };
      }
    },
  });
  writeFileSync(join(dir, 'ratification.json'), `${JSON.stringify(ratification, null, 2)}\n`);
  return { n, dir, sessionId, initGate, exit, ratification };
}

function launchEvent(l: LaunchRecord): Record<string, unknown> {
  const r = l.ratification;
  return {
    launch: l.n,
    dir: l.dir,
    session_id: l.sessionId,
    status: r.status,
    failure_class: r.failureClass,
    failed_checks: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
    init_gate: l.initGate,
    model_observed: r.modelObserved,
    effort_observed: r.effortObserved,
    tools_offered: r.toolsOffered,
    tools_used: r.toolsUsed,
    permission_denials: r.permissionDenials,
    cost_usd: r.costUsd,
    duration_ms: l.exit.durationMs,
    turns: r.turns,
    transcript: r.recordPath,
    done_by: l.exit.doneBy,
    validation: l.validation,
  };
}

/**
 * Runs the headless adjudicator on a settled round and stores its result through the P5 store. Throws HeadlessError
 * when the round cannot be adjudicated headless at all (missing, not awaiting adjudication, held, or already being
 * adjudicated); every other outcome, a failed launch included, is in the result and the store.
 */
export async function adjudicateHeadless(store: Store, layout: DataLayout, roundId: number, options: HeadlessOptions): Promise<HeadlessResult> {
  const round = getRound(store.db, roundId);
  if (!round) throw new HeadlessError(`no round ${roundId} in the store`);
  if (round.kind !== 'council') throw new HeadlessError(`round ${roundId} is an identity round: there is nothing to adjudicate`);
  if (round.status !== 'awaiting-adjudication') throw new HeadlessError(`round ${roundId} is ${round.status}; only a round awaiting adjudication can be adjudicated`);
  if (round.needs_ruling === 1) throw new HeadlessError(`round ${roundId} is held for your ruling (needs-ruling): adjudicate it yourself, or release it`);
  if (countedLegs(store.db, roundId).length === 0) throw new HeadlessError(`round ${roundId} has no ratified leg to adjudicate`);
  const adjDir = join(roundDirOf(layout, roundId), 'adjudicator');
  mkdirSync(adjDir, { recursive: true, mode: 0o700 });
  const release = takeAdjudicatorLock(adjDir);
  try {
    const runDir = nextRunDir(adjDir);
    const run = basename(runDir);
    const env = options.env ?? process.env;
    const settings = options.settings;
    const preflight = await claudePreflight(
      { backend: 'claude', model: settings.model, effort: settings.effort },
      { bin: options.bin ?? 'claude', runner: options.runner ?? runCommand, env, root: runDir },
    );
    writeFileSync(join(runDir, 'preflight.json'), `${JSON.stringify(preflight, null, 2)}\n`);
    const base = { roundId, runDir, preflight, launches: [] as LaunchRecord[], stored: null, bare: preflight.data['bare'] === true };
    if (!preflight.ok || preflight.cliVersion === null) {
      insertEvent(store.db, 'adjudicator-preflight-fail', roundId, { run, failure_class: preflight.failureClass, reason: preflight.reason });
      return { ...base, outcome: 'failed', reason: `preflight failed: ${preflight.reason ?? 'unknown'}` };
    }
    let ws: Workspace;
    try {
      ws = buildWorkspace(store, layout, roundId, runDir, options.afterCopy);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // A partial copy of the reviewed tree never stays behind (P7 round 1 row 9).
      removeWorkspace({ root: join(runDir, 'work') });
      insertEvent(store.db, 'adjudicator-workspace-fail', roundId, { run, error: why });
      return { ...base, outcome: 'failed', reason: `the working copy could not be built: ${why}` };
    }
    const projectsDir = typeof preflight.data['projectsDir'] === 'string' ? preflight.data['projectsDir'] : claudeProjectsDir(env);
    insertEvent(store.db, 'adjudicator-started', roundId, { run, model: settings.model, effort: settings.effort, bare: base.bare, source_root: ws.source, cli_version: preflight.cliVersion });
    const c: LaunchContext = {
      ws,
      runDir,
      bin: options.bin ?? 'claude',
      env: scrubEnv(env, CLAUDE_ENV_ALLOW, CLAUDE_ENV_SET),
      settings,
      preflight: preflight as Preflight & { cliVersion: string },
      bare: base.bare,
      projectsDir,
      pollMs: options.pollMs ?? 25,
      node: options.node ?? process.execPath,
      signal: options.signal,
    };
    const p: PromptInput = { roundId, mode: ws.summary.mode, target: ws.summary.target, roundNo: ws.summary.round_no, rule: ws.summary.rule };
    const launches: LaunchRecord[] = [];
    try {
      let prompt = adjudicatePrompt(p);
      for (let n = 1; n <= 2; n++) {
        const l: LaunchRecord = { ...(await launchOnce(c, n, prompt)), validation: null };
        launches.push(l);
        recordOnRound(store, roundId, l);
        const r = l.ratification;
        if (!r.ok) {
          insertEvent(store.db, 'adjudicator-run', roundId, { run, ...launchEvent(l) });
          if (r.status === 'CONTAMINATED') {
            // Like a contaminated leg (plan 4.4): not an adjudication, and never re-run on this content unattended.
            hold(store, roundId, { reason: 'adjudicator-contaminated', run, launch: n, failed_checks: r.checks.filter((x) => !x.ok).map((x) => x.name) });
            return { ...base, launches, outcome: 'needs-ruling', reason: `the adjudicator run was contaminated (${r.checks.filter((x) => !x.ok).map((x) => x.name).join(', ')}): the round is held for your ruling` };
          }
          return { ...base, launches, outcome: 'failed', reason: `the adjudicator run did not ratify: ${r.failureClass ?? 'setup'} (${r.checks.filter((x) => !x.ok).map((x) => x.name).join(', ')})` };
        }
        const raw = readFileSync(ws.output, 'utf8');
        writeFileSync(join(l.dir, 'ADJUDICATION.raw.json'), raw);
        const assigned = assignStableIds(raw, ws.facts.targetKey);
        writeFileSync(join(l.dir, 'ADJUDICATION.json'), assigned.text);
        let stored: AdjudicateResult;
        try {
          stored = adjudicate(store, layout, roundId, assigned.text, { headless: true });
        } catch (error) {
          // The store refused before validating (P7 round 1 row 8): the round was adjudicated or superseded while the
          // launch ran. Nothing is stored over it; the launch is still recorded.
          if (!(error instanceof AdjudicateError)) throw error;
          insertEvent(store.db, 'adjudicator-run', roundId, { run, ...launchEvent(l), ids_assigned: assigned.changed, store_error: error.message });
          return { ...base, launches, outcome: 'failed', reason: `the store refused the adjudication, so nothing was stored: ${error.message}` };
        }
        l.validation = stored.outcome.ok ? { ok: true, errors: [] } : { ok: false, errors: stored.outcome.errors };
        insertEvent(store.db, 'adjudicator-run', roundId, { run, ...launchEvent(l), ids_assigned: assigned.changed });
        if (stored.stored) return { ...base, launches, stored, outcome: 'adjudicated', reason: n === 1 ? 'adjudicated' : 'adjudicated after one re-prompt' };
        if (n === 2) {
          hold(store, roundId, { reason: 'adjudication-invalid', run, errors: l.validation.errors });
          return { ...base, launches, outcome: 'needs-ruling', reason: 'the adjudication failed validation twice (one re-prompt): the round is held for your ruling (plan 3.8)' };
        }
        // The re-prompt reads the document as validated (stable ids), so every error names what is in the file.
        writeFileSync(ws.output, assigned.text);
        prompt = repromptText(p, l.validation.errors);
      }
      return { ...base, launches, outcome: 'failed', reason: 'no launch ran' };
    } finally {
      if (options.keepWorkspace !== true) removeWorkspace(ws);
    }
  } finally {
    release();
  }
}

