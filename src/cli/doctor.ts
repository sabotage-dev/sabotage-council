import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SeatAdapters } from '../adapters/index.js';
import type { Occupant, Preflight } from '../adapters/types.js';
import { loadConfig, type AdapterRegistry, type ConfigIssue, type SeatConfig } from '../config/index.js';
import { openStore } from '../store/index.js';
import { packageInfo } from '../version.js';

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
  write: (line: string) => void;
}

type Status = 'ok' | 'warn' | 'fail' | 'note';

/**
 * `doctor` skeleton (plan 4.3): checks that need no CLI or model call. Runs every check even after a failure and
 * returns the exit code: 0 when nothing failed (warnings allowed), 1 otherwise.
 */
export async function runDoctor(options: DoctorOptions): Promise<number> {
  let failed = false;
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
      line('note', 'config-wide model and family checks wait for every backend adapter; codex, claude, antigravity and kiro seats are preflighted below');
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

  // Per-seat preflight (plan 4.3), no model calls.
  if (seats.length > 0 && options.adapters) {
    options.write('preflight (no model calls):');
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sc-doctor-root-')));
    try {
      for (const seat of seats) {
        const occupants: Array<{ label: string; o: Occupant }> = [
          { label: seat.id, o: { backend: seat.backend, model: seat.model, effort: seat.effort, authHome: seat.auth_home } },
        ];
        if (seat.fallback) {
          occupants.push({
            label: `${seat.id} fallback`,
            o: { backend: seat.fallback.backend, model: seat.fallback.model, effort: seat.fallback.effort, authHome: seat.fallback.auth_home },
          });
        }
        for (const { label, o } of occupants) {
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
              legDir: root,
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
          for (const c of pre.checks) {
            if (c.status === 'fail') failed = true;
            options.write(`        ${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
          }
          if (!pre.ok) options.write(`        => not usable: ${pre.reason ?? 'preflight failed'}`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  return failed ? 1 : 0;
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
