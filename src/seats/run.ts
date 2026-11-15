import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SeatAdapters } from '../adapters/index.js';
import type { FailureClass, LegHandle, LegText, Occupant, Preflight, Ratification, RoundCtx } from '../adapters/types.js';
import { renderBrief } from '../brief/index.js';
import { insertEvent, now } from '../engine/records.js';
import { parseLegReply, type LegReply } from '../parse/index.js';
import { requireGit } from '../root/git.js';
import { prepareRoot, sweepResidue } from '../root/index.js';
import type { Store } from '../store/open.js';
import { buildPlantedRepo, loadFixture, matchDefects, matchDefectsInText, type DefectMatch, type PlantedFixture } from './fixture.js';

/*
 * `seats test` (plan 8.4): one leg of one occupant on the shipped planted-defect fixture, on a root built the normal way
 * (the fixture's repository at its base and head, `git archive`d, symlinks neutralized, sanitized, a diff brief with a
 * fresh nonce, sealed and hashed), then preflight, launch, poll, collect and ratify exactly as a round's leg, and a
 * residue sweep. It qualifies a candidate before it is seated, so the occupant need not be in the config.
 *
 * Its result is recorded as a `seat-test` event with no round (`round_id` NULL). No `rounds`, `legs` or `occupants`
 * row is written, so no scorecard metric ever counts it; `stats` lists seat tests on their own.
 */

export interface SeatTestOptions {
  adapters: SeatAdapters;
  /** Where the fixture's repository and root are built (removed at the end). */
  rootsDir: string;
  /** Where the leg's records are kept: `<dataDir>/seat-tests/<id>/`. */
  dataDir: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv | undefined;
  pollMs?: number | undefined;
  /** Grace past the cap before the runner cancels the leg itself (the supervisor's cap is the first line). */
  capGraceMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fixture?: PlantedFixture | undefined;
}

export interface SeatTestResult {
  occupant: { backend: string; model: string; effort: string | null; auth_home: string | null; sandbox: string | null };
  /** The configured seat it was taken from, or null for a candidate given as backend:model[:effort]. */
  seat: string | null;
  role: 'primary' | 'fallback' | null;
  status: 'PASS' | 'FAIL' | 'CONTAMINATED' | 'PREFLIGHT_FAIL';
  failure_class: FailureClass | null;
  ratified: boolean;
  /** Ratification (or preflight) checks that failed. */
  failed_checks: string[];
  reason: string | null;
  enforcement: string | null;
  cli_version: string | null;
  verdict: string | null;
  findings_extracted_by: string | null;
  defects: { total: number; found: string[]; missed: string[]; matches: DefectMatch[]; other_findings: string[] };
  cost_usd: number | null;
  credits: number | null;
  quota_used_pct: number | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  root_unchanged: boolean | null;
  leg_dir: string;
  started_at: string;
  finished_at: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The seat test did not run: it was cancelled before the paid launch, or its fixture repository or root could not be
 * set up. Nothing was launched, and its leg dir is removed, so there is nothing to record.
 */
export class SeatTestNotRun extends Error {
  constructor(
    message: string,
    readonly why: 'cancelled' | 'setup',
  ) {
    super(message);
    this.name = 'SeatTestNotRun';
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function safeClassify(fn: () => FailureClass | null): FailureClass | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Runs the test leg; never throws for the leg's own failure (that is a result). Throws SeatTestNotRun when the signal
 * aborts before the paid launch (checked before setup, before preflight, and after preflight immediately before the
 * launch) or when the setup fails; either way nothing was launched and the leg dir is gone. A launch that returns after
 * an abort is cancelled at once.
 */
export async function runSeatTest(o: Occupant, who: { seat: string | null; role: 'primary' | 'fallback' | null }, options: SeatTestOptions): Promise<SeatTestResult> {
  const fixture = options.fixture ?? loadFixture();
  const aborted = (): boolean => options.signal?.aborted === true;
  const cancelled = new SeatTestNotRun('cancelled before the leg launched: nothing ran', 'cancelled');
  if (aborted()) throw cancelled;
  let work: string | undefined;
  let legDir: string | undefined;
  /** Not run: the leg dir goes too (the work dir goes in the finally below). */
  const notRun = (e: SeatTestNotRun): SeatTestNotRun => {
    if (legDir !== undefined) rmSync(legDir, { recursive: true, force: true });
    return e;
  };
  try {
    try {
      requireGit();
      mkdirSync(options.rootsDir, { recursive: true, mode: 0o700 });
      work = realpathSync(mkdtempSync(join(options.rootsDir, 'seat-test-')));
      legDir = join(options.dataDir, 'seat-tests', work.split('/').at(-1) ?? 'seat-test');
      mkdirSync(legDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw notRun(new SeatTestNotRun(`could not set up the seat test: ${errorText(error)}`, 'setup'));
    }
    return await runIn(o, who, options, fixture, work, legDir, aborted, () => notRun(cancelled), notRun);
  } finally {
    // The repository and the root go; the leg's records stay in the data dir.
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
  }
}

async function runIn(
  o: Occupant,
  who: { seat: string | null; role: 'primary' | 'fallback' | null },
  options: SeatTestOptions,
  fixture: PlantedFixture,
  work: string,
  legDir: string,
  aborted: () => boolean,
  cancelled: () => SeatTestNotRun,
  notRun: (e: SeatTestNotRun) => SeatTestNotRun,
): Promise<SeatTestResult> {
  const startedAt = now();
  const base: Omit<SeatTestResult, 'status' | 'failure_class' | 'ratified' | 'finished_at'> = {
    occupant: { backend: o.backend, model: o.model, effort: o.effort ?? null, auth_home: o.authHome ?? null, sandbox: o.sandbox ?? null },
    seat: who.seat,
    role: who.role,
    failed_checks: [],
    reason: null,
    enforcement: null,
    cli_version: null,
    verdict: null,
    findings_extracted_by: null,
    defects: { total: fixture.defects.length, found: [], missed: fixture.defects.map((d) => d.id), matches: [], other_findings: [] },
    cost_usd: null,
    credits: null,
    quota_used_pct: null,
    duration_ms: null,
    tokens_in: null,
    tokens_out: null,
    root_unchanged: null,
    leg_dir: legDir,
    started_at: startedAt,
  };
  const adapter = options.adapters(o.backend);
  if (!adapter) return { ...base, status: 'PREFLIGHT_FAIL', failure_class: 'setup', ratified: false, reason: `no adapter for ${o.backend} in this build`, finished_at: now() };

  const prepare = () => {
    const { repo, base: baseSha, head } = buildPlantedRepo(fixture, join(work, 'repo'));
    return prepareRoot(join(work, 'root'), { repo, name: fixture.repo, head, base: baseSha }, (layout) =>
      renderBrief({ mode: 'diff', target: `${fixture.repo}@${fixture.branch}`, round: 1, highOnlyFromRound: 4, layout }),
    );
  };
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare();
  } catch (error) {
    throw notRun(new SeatTestNotRun(`could not build the fixture's repository and root: ${errorText(error)}`, 'setup'));
  }
  const sealed = prepared.sealed;
  const ctx: RoundCtx = {
    root: sealed.root,
    legDir,
    nonce: prepared.brief.nonce,
    briefFile: join(sealed.root, 'BRIEF.md'),
    timeoutMs: options.timeoutMs,
    env: options.env,
    rootUnchanged: () => {
      try {
        const r = sweepResidue(sealed);
        return { unchanged: r.unchanged, changes: r.changes.map((c) => `${c.change} ${c.path}`) };
      } catch (error) {
        return { unchanged: false, changes: [`unreadable: ${error instanceof Error ? error.message : String(error)}`] };
      }
    },
  };

  if (aborted()) throw cancelled();
  let pre: Preflight;
  try {
    pre = await adapter.preflight(o, ctx);
  } catch (error) {
    return { ...base, status: 'PREFLIGHT_FAIL', failure_class: 'setup', ratified: false, reason: `preflight threw: ${error instanceof Error ? error.message : String(error)}`, finished_at: now() };
  }
  writeFileSync(join(legDir, 'preflight.json'), `${JSON.stringify(pre, null, 2)}\n`);
  const seen = { ...base, enforcement: pre.enforcement, cli_version: pre.cliVersion };
  if (!pre.ok) {
    return {
      ...seen,
      status: 'PREFLIGHT_FAIL',
      failure_class: pre.failureClass ?? 'setup',
      ratified: false,
      failed_checks: pre.checks.filter((c) => c.status === 'fail').map((c) => `${c.name}: ${c.detail}`),
      reason: pre.reason,
      finished_at: now(),
    };
  }

  // The paid launch: a cancel that arrived during preflight stops here, before anything is spent.
  if (aborted()) throw cancelled();
  let handle: LegHandle;
  try {
    handle = await adapter.launch(o, ctx, pre);
  } catch (error) {
    return { ...seen, status: 'FAIL', failure_class: 'setup', ratified: false, reason: `launch failed: ${error instanceof Error ? error.message : String(error)}`, finished_at: now() };
  }
  // A launch that raced the abort is cancelled at once, not at the first poll.
  if (aborted()) await adapter.cancel(handle).catch(() => undefined);
  const launchedAt = Date.now();
  const pollMs = options.pollMs ?? 1000;
  const capGraceMs = options.capGraceMs ?? 60_000;
  let settled = false;
  try {
    for (;;) {
      let state;
      try {
        state = await adapter.poll(handle);
      } catch {
        await adapter.cancel(handle).catch(() => undefined);
        break;
      }
      if (state.status === 'done') break;
      if (options.signal?.aborted === true || Date.now() > launchedAt + options.timeoutMs + capGraceMs) {
        await adapter.cancel(handle).catch(() => undefined);
      }
      await sleep(pollMs);
    }
    settled = true;
  } finally {
    // Nothing the test started is left running, whatever happened above.
    if (!settled || options.signal?.aborted === true) await adapter.cancel(handle).catch(() => undefined);
  }

  let text: LegText = { text: null, fromNonce: false, source: 'none' };
  try {
    text = await adapter.collect(handle);
  } catch {
    // No answer: ratification decides what it means.
  }
  let r: Ratification | null = null;
  try {
    r = await adapter.ratify(handle, ctx);
  } catch (error) {
    seen.reason = `ratify threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (text.text !== null) writeFileSync(join(legDir, 'answer.md'), text.text);
  if (r) writeFileSync(join(legDir, 'ratification.json'), `${JSON.stringify(r, null, 2)}\n`);
  const residue = ctx.rootUnchanged?.() ?? { unchanged: false, changes: [] };
  const measured = {
    ...seen,
    cost_usd: r?.costUsd ?? null,
    credits: r?.credits ?? null,
    quota_used_pct: r?.quotaUsedPct ?? null,
    duration_ms: r?.durationMs ?? Date.now() - launchedAt,
    tokens_in: r?.tokensIn ?? null,
    tokens_out: r?.tokensOut ?? null,
    root_unchanged: residue.unchanged,
    failed_checks: (r?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
  };

  if (r?.ok !== true || !residue.unchanged) {
    const cls = r?.failureClass ?? safeClassify(() => adapter.classify(handle)) ?? (residue.unchanged ? 'setup' : 'contaminated');
    const contaminated = r?.status === 'CONTAMINATED' || cls === 'contaminated' || !residue.unchanged;
    return {
      ...measured,
      status: contaminated ? 'CONTAMINATED' : 'FAIL',
      failure_class: contaminated ? 'contaminated' : cls,
      ratified: false,
      failed_checks: residue.unchanged ? measured.failed_checks : [...measured.failed_checks, `residue: ${residue.changes.slice(0, 5).join(', ')}`],
      finished_at: now(),
    };
  }

  const reply: LegReply = parseLegReply(text.text ?? '', ctx.nonce);
  writeFileSync(join(legDir, 'reply.json'), `${JSON.stringify(reply, null, 2)}\n`);
  const empty = text.text === null || (reply.verdict.verdict === 'none' && reply.findings.findings.length === 0);
  const matched =
    reply.findings.extracted_by === 'leg' ? matchDefects(fixture, reply.findings.findings) : { matches: matchDefectsInText(fixture, text.text ?? ''), other: [] };
  const found = fixture.defects.map((d) => d.id).filter((id) => matched.matches.some((m) => m.defect === id));
  return {
    ...measured,
    status: empty ? 'FAIL' : 'PASS',
    failure_class: empty ? 'empty' : null,
    ratified: !empty,
    verdict: reply.verdict.verdict,
    findings_extracted_by: reply.findings.extracted_by,
    defects: { total: fixture.defects.length, found, missed: fixture.defects.map((d) => d.id).filter((id) => !found.includes(id)), matches: matched.matches, other_findings: matched.other },
    finished_at: now(),
  };
}

/** Records the result as a `seat-test` event with no round: the store keeps it, and no round metric reads it. */
export function recordSeatTest(store: Store, result: SeatTestResult): void {
  insertEvent(store.db, 'seat-test', null, {
    seat: result.seat,
    role: result.role,
    occupant: { backend: result.occupant.backend, model: result.occupant.model, effort: result.occupant.effort },
    ratified: result.ratified,
    status: result.status,
    failure_class: result.failure_class,
    verdict: result.verdict,
    defects: { found: result.defects.found, missed: result.defects.missed, total: result.defects.total, other_findings: result.defects.other_findings.length },
    cost_usd: result.cost_usd,
    credits: result.credits,
    quota_used_pct: result.quota_used_pct,
    duration_ms: result.duration_ms,
    enforcement: result.enforcement,
    cli_version: result.cli_version,
    leg_dir: result.leg_dir,
  });
}

/** 0 qualified (ratified, every planted defect found), 2 ratified but some defect missed, 1 not ratified. */
export function exitCodeOf(result: SeatTestResult): 0 | 1 | 2 {
  if (!result.ratified) return 1;
  return result.defects.missed.length === 0 ? 0 : 2;
}
