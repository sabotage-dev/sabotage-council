import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeatAdapters } from '../adapters/index.js';
import type { Occupant, Preflight } from '../adapters/types.js';
import { loadConfig, type AdapterRegistry, type ConfigIssue, type SeatConfig } from '../config/index.js';
import { openStore } from '../store/index.js';
import { packageInfo } from '../version.js';
import { judgeDeep, markersIn, plantCanaryRoot, UNPROVEN_VERDICTS, type DeepResult, type DeepVerdict } from './deep.js';

export interface DoctorOptions {
  configPath: string;
  dbPath: string;
  /** Seat adapters arrive in P2-P4. Without a registry, model ids and families are not checked. */
  registry?: AdapterRegistry | undefined;
  /** Defaults to the running Node (`process.version`). */
  nodeVersion?: string | undefined;
  /** Defaults to package.json `engines.node`. */
  nodeRange?: string | undefined;
  /**
   * Seat adapters for the per-seat preflight (plan 4.3): binary, version, auth, model and the isolation proof,
   * with no model call. Absent: no seat is preflighted.
   */
  adapters?: SeatAdapters | undefined;
  /** The environment the preflight scrubs per adapter. Default: `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * `--deep` (plan 4.3): also run every occupant's preflight against a canary root holding planted hook, rules and
   * MCP files for every backend, top level and nested; a backend that loads one fails.
   */
  deep?: boolean | undefined;
  write: (line: string) => void;
}

type Status = 'ok' | 'warn' | 'fail' | 'note';

/**
 * `doctor` skeleton (plan 4.3): checks that need no CLI or model call. Runs every check even after a failure and
 * returns the exit code: 0 when nothing failed (warnings allowed), 1 when something failed (with `--deep`: a
 * backend loaded a planted file), 2 when nothing failed but `--deep` left some backend unproven.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  let failed = false;
  let deepUnproven = false;
  const line = (status: Status, text: string): void => {
    if (status === 'fail') failed = true;
    options.write(`${status.padEnd(4)}  ${text}`);
  };

  // Node version against package.json engines.
  const nodeVersion = options.nodeVersion ?? process.version;
  const nodeRange = options.nodeRange ?? packageInfo().nodeRange;
  const node = checkNodeVersion(nodeVersion, nodeRange);
  line(node.ok ? 'ok' : 'fail', node.message);

  // Config.
  const config = await loadConfig(options.configPath, { registry: options.registry });
  let seats: SeatConfig[] = [];
  if (config.ok) {
    line('ok', `config ${config.path} loaded`);
    seats = config.config.seats;
    if (!config.modelsChecked) {
      line('note', 'config-wide model and family checks are not run here; each seat is preflighted below');
    }
  } else {
    line('fail', `config ${config.path} has ${config.errors.length} error(s)`);
    for (const issue of config.errors) options.write(`        ${formatIssue(issue)}`);
  }
  for (const issue of config.warnings) line('warn', formatIssue(issue));

  // Store.
  try {
    const store = openStore(options.dbPath);
    try {
      const { applied, version } = store.migration;
      const migrated = applied.length > 0 ? `, applied migration(s) ${applied.join(', ')}` : '';
      line('ok', `store ${store.path} at schema version ${version}${migrated}`);
    } finally {
      store.close();
    }
  } catch (error) {
    line('fail', `store ${options.dbPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Seats.
  if (seats.length > 0) {
    options.write('seats:');
    for (const seat of seats) options.write(`  ${describeSeat(seat)}`);
  }

  // Cursor in auto (plan 4.2): refused until a Cursor canary passes; D14 allows none in v1.
  if (config.ok && config.config.auto !== undefined) {
    const cursor = occupantsOf(seats).filter(({ o }) => o.backend === 'cursor');
    for (const { label } of cursor) line('fail', `${label}: cursor seats are refused for auto until a Cursor promotion canary passes (none runs in v1, D14)`);
  }

  // Per-seat preflight (plan 4.3), no model calls.
  if (seats.length > 0 && options.adapters) {
    options.write('preflight (no model calls):');
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'sc-doctor-')));
    const root = join(tmp, 'root');
    mkdirSync(root);
    let legs = 0;
    // Each preflight gets its own leg dir, outside the root (some backends write their per-leg homes there).
    const legDir = (): string => {
      const d = join(tmp, `leg-${legs++}`);
      mkdirSync(d);
      return d;
    };
    // Whether each occupant's preflight passed on the clean root (`--deep` judges its canary refusal against it).
    const cleanOk: boolean[] = [];
    try {
      for (const { label, o } of occupantsOf(seats)) {
        cleanOk.push(false);
        const adapter = options.adapters(o.backend);
        const name = `${label}  ${[o.backend, o.model, o.effort].filter((p) => p !== undefined).join(' / ')}`;
        if (!adapter) {
          options.write(`  ${name}: no adapter in this build`);
          continue;
        }
        let pre: Preflight;
        try {
          pre = await adapter.preflight(o, {
            root,
            legDir: legDir(),
            nonce: '000000000000',
            briefFile: '/dev/null',
            timeoutMs: 60_000,
            env: options.env,
          });
        } catch (error) {
          line('fail', `${name}: preflight threw: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        options.write(`  ${name}: ${pre.cliVersion !== null ? `${o.backend} ${pre.cliVersion}, ` : ''}enforcement ${pre.enforcement}`);
        // Which HOME a kiro seat signs in from (plan 4.3, the auth_home setting).
        if (o.backend === 'kiro') {
          options.write(`        home  ${o.authHome !== undefined ? `${o.authHome} (auth_home)` : "the user's HOME (default)"}`);
          if (typeof pre.data['credential'] === 'string') options.write(`        credential  ${pre.data['credential']}`);
        }
        // Which grok home a grok seat signs in from: its auth_home (its own login and config), or the default.
        if (o.backend === 'grok') {
          options.write(`        grok home  ${o.authHome !== undefined ? `${o.authHome} (auth_home)` : typeof pre.data['grokHome'] === 'string' ? `${pre.data['grokHome']} (${String(pre.data['route'])})` : "the user's grok home (default)"}`);
        }
        for (const c of pre.checks) {
          if (c.status === 'fail') failed = true;
          options.write(`        ${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
        }
        if (!pre.ok) options.write(`        => not usable: ${pre.reason ?? 'preflight failed'}`);
        cleanOk[cleanOk.length - 1] = pre.ok;
      }
      if (options.deep === true) {
        const deep = await deepCheck(occupantsOf(seats), cleanOk, options, legDir, tmp);
        // A backend that loaded a planted file fails (exit 1). One proven by its load dump, or by its own recorded
        // promotion canary, is ok. The rest are unproven by --deep: nothing loaded, but nothing proves it (exit 2).
        for (const { name, result } of deep) {
          if (result.verdict === 'loads') line('fail', `${name}: loads: ${result.detail}`);
          else if (result.verdict === 'isolated') line('ok', `${name}: isolated: ${result.detail}`);
          else if (result.verdict === 'canary') line('ok', `${name}: proven by its promotion canary: ${result.detail}`);
          else {
            deepUnproven = true;
            line('warn', `${name}: unproven by --deep (${result.verdict}): ${result.detail}`);
          }
        }
        const count = (v: DeepVerdict): number => deep.filter((d) => d.result.verdict === v).length;
        options.write(
          `        ${count('isolated')} isolated by their load dump, ${count('canary')} proven by their promotion canary, ${deep.filter((d) => UNPROVEN_VERDICTS.includes(d.result.verdict)).length} unproven, ${count('loads')} loading a planted file (of ${deep.length})`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // 1: a failure (a backend loaded a planted file, or any other check failed). 2: `--deep` found nothing loaded,
  // but some backend is unproven. 0: everything passed.
  return failed ? 1 : deepUnproven ? 2 : 0;
}

/** Each seat's occupant, then its fallback. */
function occupantsOf(seats: readonly SeatConfig[]): Array<{ label: string; o: Occupant }> {
  const out: Array<{ label: string; o: Occupant }> = [];
  for (const seat of seats) {
    out.push({ label: seat.id, o: { backend: seat.backend, model: seat.model, effort: seat.effort, authHome: seat.auth_home, sandbox: seat.sandbox } });
    if (seat.fallback) {
      out.push({ label: `${seat.id} fallback`, o: { backend: seat.fallback.backend, model: seat.fallback.model, effort: seat.fallback.effort, authHome: seat.fallback.auth_home } });
    }
  }
  return out;
}

/**
 * `doctor --deep` (plan 4.3): every occupant's preflight against the canary root, one at a time, watching the
 * markers dir for planted code that ran. No model call is made: preflight never makes one.
 */
async function deepCheck(
  occupants: ReadonlyArray<{ label: string; o: Occupant }>,
  cleanOk: readonly boolean[],
  options: DoctorOptions,
  legDir: () => string,
  tmp: string,
): Promise<Array<{ name: string; result: DeepResult }>> {
  options.write('deep (a fresh canary root per occupant with planted hooks, rules and MCP config for every backend, top level and nested):');
  const out: Array<{ name: string; result: DeepResult }> = [];
  for (const [i, { label, o }] of occupants.entries()) {
    const adapter = options.adapters?.(o.backend);
    const name = `${label}  ${o.backend}`;
    if (!adapter) continue;
    // Its own root and markers dir: no marker another occupant left can hide a repeat execution.
    const base = join(tmp, `canary-${i}`);
    const root = join(base, 'canary-root');
    const markers = join(base, 'canary-markers');
    mkdirSync(root, { recursive: true });
    const planted = plantCanaryRoot(root, markers, `${label}-${o.backend}`.replace(/[^\w.-]/g, '_'));
    if (i === 0) options.write(`        planted ${planted.length} files per occupant`);
    const before = new Set(markersIn(markers));
    let pre: Preflight | null = null;
    let error: string | null = null;
    try {
      pre = await adapter.preflight(o, { root, legDir: legDir(), nonce: '000000000000', briefFile: '/dev/null', timeoutMs: 60_000, env: options.env });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const appeared = markersIn(markers).filter((m) => !before.has(m));
    out.push({ name, result: judgeDeep(pre, appeared, error, cleanOk[i] ?? false) });
  }
  return out;
}

function formatIssue(issue: ConfigIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

function describeSeat(seat: SeatConfig): string {
  const home = (h: string | undefined): string => (h !== undefined ? `, auth_home ${h}` : '');
  const primary = [seat.backend, seat.model, seat.effort].filter((p) => p !== undefined).join(' / ') + home(seat.auth_home);
  if (!seat.fallback) return `${seat.id}  ${primary}`;
  const f = seat.fallback;
  const fallback = [f.backend, f.model, f.effort].filter((p) => p !== undefined).join(' / ') + home(f.auth_home);
  return `${seat.id}  ${primary}  (fallback ${fallback} on ${f.on.join(', ')})`;
}

/** Supports the `>=MAJOR[.MINOR[.PATCH]]` form package.json uses. */
export function checkNodeVersion(version: string, range: string): { ok: boolean; message: string } {
  const floor = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  const current = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!floor) return { ok: false, message: `cannot read the engines range "${range}"` };
  if (!current) return { ok: false, message: `cannot read the Node version "${version}"` };
  const want = [Number(floor[1]), Number(floor[2] ?? 0), Number(floor[3] ?? 0)];
  const have = [Number(current[1]), Number(current[2]), Number(current[3])];
  let cmp = 0;
  for (let i = 0; i < 3 && cmp === 0; i++) cmp = Math.sign((have[i] ?? 0) - (want[i] ?? 0));
  const ok = cmp >= 0;
  return { ok, message: `node ${version} ${ok ? 'satisfies' : 'does not satisfy'} ${range}` };
}
