import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeatAdapters } from '../adapters/index.js';
import type { Occupant, Preflight } from '../adapters/types.js';
import { loadConfig, type AdapterRegistry, type BackendId, type ConfigIssue, type SeatConfig } from '../config/index.js';
import { applySeatEdit, SeatApplyError } from '../seats/apply.js';
import type { SeatEdit } from '../seats/edit.js';
import { loadStats } from '../stats/data.js';
import { buildReport, thresholdsOf, type SeatCard, type Recommendation } from '../stats/report.js';
import { pctText } from '../stats/text.js';
import { openStore } from '../store/index.js';
import type { StorePaths } from './round.js';

/*
 * `sabotage-council seats list | add | remove | swap` (plan 8.4). The editing commands change the user's config file
 * through src/seats (one seam, one block).
 */

export interface SeatsIo {
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
  setExitCode: (code: number) => void;
  adapters?: SeatAdapters | undefined;
  registry?: AdapterRegistry | undefined;
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

/** One line of the scorecard for a seat (all history). */
export function scorecardLine(card: SeatCard | undefined, rec: Recommendation | undefined): string {
  if (!card) return 'scorecard  no rounds recorded for this seat yet';
  const flag = rec?.swap_candidate === true ? 'SWAP CANDIDATE (see `sabotage-council stats`)' : rec?.eligible === false ? 'not enough rounds for the swap flag yet' : 'keep';
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
      const report = buildReport(loadStats(store.db, null), thresholdsOf(config.config.stats, 'config'), { seat: null, occupant: null });
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
          `seat ${op.seat} keeps its id: its history stays under seat ${op.seat}, and ${describe(op.occupant)} opens its own occupant row at its first leg.`,
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
