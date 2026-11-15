import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SeatAdapters } from '../adapters/index.js';
import type { Occupant, Preflight } from '../adapters/types.js';
import { BACKENDS, loadConfig, type AdapterRegistry, type BackendId, type ConfigIssue, type SeatConfig } from '../config/index.js';
import { applySeatEdit, SeatApplyError } from '../seats/apply.js';
import type { SeatEdit } from '../seats/edit.js';
import { loadFixture } from '../seats/fixture.js';
import { exitCodeOf, recordSeatTest, runSeatTest, type SeatTestResult } from '../seats/run.js';
import { loadStats, occupantKey } from '../stats/data.js';
import { buildReport, thresholdsOf, type SeatCard, type Recommendation } from '../stats/report.js';
import { durationText, money, pctText } from '../stats/text.js';
import { openStore } from '../store/index.js';
import type { StorePaths } from './round.js';

/*
 * `sabotage-council seats list | add | remove | swap | test` (plan 8.4). The editing commands change the user's config
 * file through src/seats (one seam, one block); `test` runs one paid leg on the shipped planted-defect fixture.
 */

export interface SeatsIo {
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
  setExitCode: (code: number) => void;
  adapters?: SeatAdapters | undefined;
  registry?: AdapterRegistry | undefined;
  /** `seats test`: how often the leg is polled (tests). Default 1000 ms. */
  pollMs?: number | undefined;
}

function registryOf(io: SeatsIo): AdapterRegistry | undefined {
  if (io.registry) return io.registry;
  const adapters = io.adapters;
  return adapters ? { lister: (backend) => adapters(backend) } : undefined;
}

function formatIssue(issue: ConfigIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

const describe = (o: { backend: string; model: string; effort?: string | null | undefined }): string => [o.backend, o.model, o.effort ?? undefined].filter((p) => p !== undefined).join(' / ');

function occupantOf(o: { backend: BackendId; model: string; effort?: string | undefined; auth_home?: string | undefined; sandbox?: 'read-only' | 'off' | undefined }): Occupant {
  const out: Occupant = { backend: o.backend, model: o.model, effort: o.effort, authHome: o.auth_home };
  if (o.sandbox !== undefined) out.sandbox = o.sandbox;
  return out;
}

// ---------- list ----------

interface Label {
  enforcement: string;
  cli_version: string | null;
  preflight_ok: boolean | null;
  reason: string | null;
}

/** The enforcement label as `doctor` shows it: the adapter's preflight, with no model call. */
async function labelOf(io: SeatsIo, o: Occupant, root: string, legDir: () => string): Promise<Label> {
  const adapter = io.adapters?.(o.backend);
  if (!adapter) return { enforcement: 'unknown', cli_version: null, preflight_ok: null, reason: `no adapter for ${o.backend} in this build` };
  let pre: Preflight;
  try {
    pre = await adapter.preflight(o, { root, legDir: legDir(), nonce: '000000000000', briefFile: '/dev/null', timeoutMs: 60_000, env: io.env });
  } catch (error) {
    return { enforcement: adapter.enforcement(null), cli_version: null, preflight_ok: false, reason: `preflight threw: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { enforcement: pre.enforcement, cli_version: pre.cliVersion, preflight_ok: pre.ok, reason: pre.ok ? null : pre.reason };
}

function labelText(backend: string, l: Label | null): string {
  if (l === null) return 'enforcement not checked (--no-preflight)';
  const version = l.cli_version !== null ? ` (${backend} ${l.cli_version})` : '';
  const failed = l.preflight_ok === false ? `; preflight failed: ${l.reason ?? 'unknown'}` : l.preflight_ok === null ? `; ${l.reason ?? ''}` : '';
  return `enforcement ${l.enforcement}${version}${failed}`;
}

/**
 * One line of the scorecard for a seat: the card covers all history (every occupant it had); the flag judges its
 * current occupant (the config's) over its rounds since it took the seat, as `stats` does.
 */
export function scorecardLine(card: SeatCard | undefined, rec: Recommendation | undefined): string {
  if (!card) return 'scorecard  no rounds recorded for this seat yet';
  const who = rec?.occupant ? ` ${rec.occupant.occupant}` : '';
  const since = rec?.occupant?.since_round != null ? ` since round #${rec.occupant.since_round}` : '';
  const flag =
    rec?.swap_candidate === true
      ? `SWAP CANDIDATE:${who}${since} (see \`sabotage-council stats\`)`
      : rec?.eligible === false
        ? `not enough rounds under${who || ' it'} for the swap flag yet`
        : `keep${who}`;
  return `scorecard  seated ${card.rounds_seated}, ratified ${pctText(card.ratified_rate)}, raised ${card.findings.raised}, precision ${pctText(card.findings.precision)}, unique owed ${card.unique.owed}, blocking lost without it ${card.drop_one.blocking_lost}: ${flag}`;
}

export async function seatsList(io: SeatsIo, paths: StorePaths, opts: { preflight: boolean; json: boolean }): Promise<void> {
  const config = await loadConfig(paths.configPath);
  if (!config.ok) {
    io.write(`config ${paths.configPath} has ${config.errors.length} error(s):`);
    for (const e of config.errors) io.write(`  ${formatIssue(e)}`);
    io.setExitCode(1);
    return;
  }
  const seats = config.config.seats;
  let cards: SeatCard[] = [];
  let recs: Recommendation[] = [];
  if (existsSync(paths.dbPath)) {
    const store = openStore(paths.dbPath);
    try {
      const current = new Map(seats.map((seat) => [seat.id, occupantKey(seat)]));
      const report = buildReport(loadStats(store.db, null), thresholdsOf(config.config.stats, 'config'), { seat: null, occupant: null }, undefined, current);
      cards = report.seats;
      recs = report.recommendations;
    } finally {
      store.close();
    }
  }
  const tmp = opts.preflight ? realpathSync(mkdtempSync(join(tmpdir(), 'sc-seats-'))) : null;
  const rows: Array<Record<string, unknown>> = [];
  try {
    let n = 0;
    const root = tmp === null ? '' : join(tmp, 'root');
    if (tmp !== null) mkdirSync(root);
    const legDir = (): string => {
      const d = join(tmp ?? '', `leg-${n++}`);
      mkdirSync(d);
      return d;
    };
    for (const seat of seats) {
      const primary = occupantOf(seat);
      const label = tmp === null ? null : await labelOf(io, primary, root, legDir);
      const fallback = seat.fallback ? occupantOf(seat.fallback) : null;
      const fallbackLabel = fallback === null || tmp === null ? null : await labelOf(io, fallback, root, legDir);
      const card = cards.find((c) => c.seat === seat.id);
      const rec = recs.find((r) => r.seat === seat.id);
      rows.push({ seat, label, fallbackLabel, card, rec });
    }
  } finally {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  }

  if (opts.json) {
    io.write(
      JSON.stringify(
        {
          config: paths.configPath,
          seats: rows.map(({ seat, label, fallbackLabel, card, rec }) => {
            const s = seat as SeatConfig;
            const c = card as SeatCard | undefined;
            const r = rec as Recommendation | undefined;
            return {
              id: s.id,
              occupant: { backend: s.backend, model: s.model, effort: s.effort ?? null, auth_home: s.auth_home ?? null, sandbox: s.sandbox ?? null },
              label: label ?? null,
              fallback: s.fallback ? { backend: s.fallback.backend, model: s.fallback.model, effort: s.fallback.effort ?? null, on: s.fallback.on, label: fallbackLabel ?? null } : null,
              scorecard: c
                ? {
                    rounds_seated: c.rounds_seated,
                    ratified_rate: c.ratified_rate,
                    raised: c.findings.raised,
                    precision: c.findings.precision,
                    unique_owed: c.unique.owed,
                    blocking_lost: c.drop_one.blocking_lost,
                    swap_candidate: r?.swap_candidate ?? false,
                    eligible: r?.eligible ?? false,
                    judged_occupant: r?.occupant ?? null,
                  }
                : null,
            };
          }),
        },
        null,
        2,
      ),
    );
    io.setExitCode(0);
    return;
  }
  io.write(`seats in ${paths.configPath}:`);
  for (const { seat, label, fallbackLabel, card, rec } of rows) {
    const s = seat as SeatConfig;
    io.write(`${s.id}  ${describe(s)}${s.auth_home !== undefined ? `, auth_home ${s.auth_home}` : ''}  ${labelText(s.backend, label as Label | null)}`);
    if (s.fallback) {
      io.write(`   fallback  ${describe(s.fallback)} on ${s.fallback.on.join(', ')}  ${labelText(s.fallback.backend, fallbackLabel as Label | null)}`);
    }
    io.write(`   ${scorecardLine(card as SeatCard | undefined, rec as Recommendation | undefined)}`);
  }
  io.setExitCode(0);
}

// ---------- add / remove / swap ----------

export interface EditArgs {
  dryRun: boolean;
  now?: Date | undefined;
}

export async function seatsEdit(io: SeatsIo, paths: StorePaths, op: SeatEdit, args: EditArgs): Promise<void> {
  try {
    const r = await applySeatEdit(paths.configPath, op, { registry: registryOf(io), dryRun: args.dryRun, now: args.now });
    if (r.unchanged) {
      io.write(`no change: ${r.path} already says that`);
      io.setExitCode(0);
      return;
    }
    for (const line of r.diff.replace(/\n$/, '').split('\n')) io.write(line);
    if (!r.written) {
      io.write(`dry run: the edit passes the config loader; nothing was written to ${r.path}`);
    } else {
      io.write(`backup: ${r.backup ?? ''}`);
      io.write(`wrote ${r.path}`);
      if (op.kind !== 'remove') {
        io.write(
          `seat ${op.seat} keeps its id: its history stays under seat ${op.seat}, and ${describe(op.occupant)} opens its own occupant row at its first leg. Qualify a candidate first with \`sabotage-council seats test ${op.occupant.backend}:${op.occupant.model}${op.occupant.effort !== undefined ? `:${op.occupant.effort}` : ''}\`.`,
        );
      }
    }
    io.setExitCode(0);
  } catch (error) {
    if (!(error instanceof SeatApplyError)) throw error;
    io.write(error.message);
    for (const d of error.details) io.write(`  ${d}`);
    io.setExitCode(1);
  }
}

// ---------- test ----------

export interface TestArgs {
  /** Use the seat's fallback instead of its primary (a seat id only). */
  fallback: boolean;
  authHome?: string | undefined;
  sandbox?: 'read-only' | 'off' | undefined;
  /** Minutes; default the config's leg_timeout_minutes, else 25. */
  timeoutMinutes?: number | undefined;
  json: boolean;
  signal?: AbortSignal | undefined;
}

/** `backend:model[:effort]`; the effort is the last `:` segment when there are three or more. */
export function parseOccupantSpec(spec: string): { backend: string; model: string; effort: string | undefined } | null {
  const at = spec.indexOf(':');
  if (at <= 0) return null;
  const backend = spec.slice(0, at);
  const rest = spec.slice(at + 1);
  const last = rest.lastIndexOf(':');
  const model = last > 0 ? rest.slice(0, last) : rest;
  const effort = last > 0 ? rest.slice(last + 1) : undefined;
  if (model === '' || effort === '') return null;
  return { backend, model, effort };
}

export async function seatsTest(io: SeatsIo, paths: StorePaths, target: string, args: TestArgs): Promise<void> {
  const fail = (message: string): void => {
    io.write(message);
    io.setExitCode(1);
  };
  const config = existsSync(paths.configPath) ? await loadConfig(paths.configPath) : null;
  let occupant: Occupant;
  let who: { seat: string | null; role: 'primary' | 'fallback' | null };
  if (target.includes(':')) {
    const spec = parseOccupantSpec(target);
    if (spec === null) return fail(`"${target}" is not backend:model[:effort]`);
    if (!(BACKENDS as readonly string[]).includes(spec.backend)) return fail(`unknown backend "${spec.backend}"; expected one of: ${BACKENDS.join(', ')}`);
    if (args.fallback) return fail('--fallback takes a seat id, not an occupant');
    const lister = registryOf(io)?.lister(spec.backend as BackendId);
    if (!lister) return fail(`no adapter is registered for backend "${spec.backend}"`);
    let models;
    try {
      models = await lister.listModels();
    } catch (error) {
      return fail(`could not list the models of backend "${spec.backend}": ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!models.some((m) => m.id === spec.model)) return fail(`backend "${spec.backend}" does not offer model "${spec.model}"`);
    if (args.authHome !== undefined && spec.backend !== 'kiro' && spec.backend !== 'grok') return fail('--auth-home applies only to kiro and grok');
    if (args.sandbox !== undefined && spec.backend !== 'grok') return fail('--sandbox applies only to grok');
    occupant = occupantOf({ backend: spec.backend as BackendId, model: spec.model, effort: spec.effort, auth_home: args.authHome, sandbox: args.sandbox });
    who = { seat: null, role: null };
  } else {
    if (config === null) return fail(`no config file at ${paths.configPath}: name the candidate as backend:model[:effort] instead`);
    if (!config.ok) {
      io.write(`config ${paths.configPath} has ${config.errors.length} error(s):`);
      for (const e of config.errors) io.write(`  ${formatIssue(e)}`);
      io.setExitCode(1);
      return;
    }
    if (args.authHome !== undefined || args.sandbox !== undefined) return fail('--auth-home and --sandbox go with backend:model[:effort]; a seat id uses its own config');
    const seat = config.config.seats.find((s) => s.id === target);
    if (!seat) return fail(`no seat "${target}" in ${paths.configPath} (seats: ${config.config.seats.map((s) => s.id).join(', ')})`);
    if (args.fallback && !seat.fallback) return fail(`seat "${target}" has no fallback`);
    occupant = args.fallback && seat.fallback ? occupantOf(seat.fallback) : occupantOf(seat);
    who = { seat: seat.id, role: args.fallback ? 'fallback' : 'primary' };
  }
  if (!io.adapters) return fail('no seat adapters in this build');

  const minutes = args.timeoutMinutes ?? (config?.ok === true ? config.config.council.leg_timeout_minutes : 25);
  const fixture = loadFixture();
  // It spends money: say exactly what runs before anything launches.
  io.write(
    `seats test: about to run one paid leg: backend ${occupant.backend}, model ${occupant.model}, effort ${occupant.effort ?? '(the CLI default)'}${who.seat !== null ? ` (seat ${who.seat}, ${who.role})` : ' (a candidate, not in the config)'}; capped at ${minutes} min, on the planted-defect fixture (${fixture.defects.length} defects)`,
  );
  const result = await runSeatTest(occupant, who, {
    adapters: io.adapters,
    rootsDir: join(paths.rootsPath, 'seat-tests'),
    dataDir: dirname(paths.dbPath),
    timeoutMs: Math.round(minutes * 60_000),
    env: io.env,
    pollMs: io.pollMs,
    signal: args.signal,
    fixture,
  });
  // The paid result is printed whatever happens to the record of it.
  const code = exitCodeOf(result);
  let recorded: string | null = null;
  try {
    const store = openStore(paths.dbPath);
    try {
      recordSeatTest(store, result);
    } finally {
      store.close();
    }
  } catch (error) {
    recorded = `could not record the seat test in ${paths.dbPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (args.json) io.write(JSON.stringify({ ...result, exit_code: code, record_error: recorded }, null, 2));
  else {
    for (const line of resultLines(result, fixture.defects.map((d) => ({ id: d.id, severity: d.severity, title: d.title })))) io.write(line);
    if (recorded !== null) io.write(`warn  ${recorded}`);
  }
  io.setExitCode(code);
}

export function resultLines(r: SeatTestResult, defects: ReadonlyArray<{ id: string; severity: string; title: string }>): string[] {
  const out: string[] = [];
  out.push(`ratification  ${r.ratified ? 'PASS' : `${r.status}${r.failure_class !== null ? ` (${r.failure_class})` : ''}`}${r.enforcement !== null ? `; enforcement ${r.enforcement}` : ''}${r.cli_version !== null ? `; ${r.occupant.backend} ${r.cli_version}` : ''}`);
  for (const c of r.failed_checks) out.push(`  failed  ${c}`);
  if (r.reason !== null) out.push(`  ${r.reason}`);
  out.push(`verdict       ${r.verdict ?? 'none'}${r.findings_extracted_by === 'adjudicator-needed' ? ' (its findings block did not parse: defects read from the answer text)' : ''}`);
  out.push(`defects       found ${r.defects.found.length} of ${r.defects.total}${r.defects.other_findings.length > 0 ? `; ${r.defects.other_findings.length} other finding(s) (the base is correct, so these are noise)` : ''}`);
  for (const d of defects) {
    const m = r.defects.matches.find((x) => x.defect === d.id);
    out.push(`  ${r.defects.found.includes(d.id) ? 'found ' : 'missed'}  ${d.id} ${d.severity} ${d.title}${m ? ` (${m.finding}, by ${m.by})` : ''}`);
  }
  const cost = [r.cost_usd !== null ? money(r.cost_usd) : null, r.credits !== null ? `${r.credits} credits` : null, r.quota_used_pct !== null ? `quota ${r.quota_used_pct}%` : null].filter((x) => x !== null);
  out.push(`cost          ${cost.join(', ') || 'none recorded'}; duration ${durationText(r.duration_ms)}`);
  out.push(`records       ${r.leg_dir}`);
  out.push(
    r.ratified && r.defects.missed.length === 0
      ? 'qualified: it ratified and found every planted defect (recorded as a seat test; it never counts in stats)'
      : r.ratified
        ? `not qualified: it ratified but missed ${r.defects.missed.join(', ')} (recorded as a seat test; it never counts in stats)`
        : 'not qualified: the leg did not ratify (recorded as a seat test; it never counts in stats)',
  );
  return out;
}
