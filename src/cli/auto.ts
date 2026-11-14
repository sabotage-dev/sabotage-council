import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type ConfigIssue } from '../config/index.js';
import type { CouncilConfig } from '../config/schema.js';
import { allRows, claimLive, FINAL_STATES, MAX_ATTEMPTS } from '../auto/ledger.js';
import { autoDir, lastReport, pauseState, PassError, roundsSince, runPass, setPaused, type PassOptions, type PassReport } from '../auto/pass.js';
import { installService, previewService, serviceInstalled, uninstallService, type ServicePlatform } from '../auto/service.js';
import { releaseRound, ruleFinding, type ReleaseDecision } from '../engine/ruling.js';
import { ghApi } from '../forge/github.js';
import { openStore, type Store } from '../store/index.js';
import type { PrIo } from './pr.js';
import { layoutOf, type StorePaths } from './round.js';

/*
 * `auto run-once | run | status | pause | resume | install | uninstall` (plan 9.4) and `ruling` (plan 3.8).
 */

export interface AutoIo extends PrIo {
  claudeBin?: string | undefined;
  headlessPollMs?: number | undefined;
  /** Tests: pass options beyond what the command line sets (the adjudication step, the notifier, caffeinate, ...). */
  passOverrides?: Partial<PassOptions> | undefined;
  /** Tests: the platform the service commands render for, and their loaders. */
  servicePlatform?: ServicePlatform | undefined;
  serviceLoader?: string | undefined;
  plutil?: string | null | undefined;
}

function formatIssue(issue: ConfigIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

async function config(io: AutoIo, paths: StorePaths, models: boolean): Promise<CouncilConfig | null> {
  const registry = models ? (io.registry ?? (io.adapters ? { lister: io.adapters } : undefined)) : undefined;
  const c = await loadConfig(paths.configPath, { registry });
  for (const w of c.warnings) io.write(`warn  ${formatIssue(w)}`);
  if (!c.ok) {
    io.write(`config ${paths.configPath} has ${c.errors.length} error(s):`);
    for (const e of c.errors) io.write(`  ${formatIssue(e)}`);
    io.setExitCode(1);
    return null;
  }
  return c.config;
}

function passOptions(io: AutoIo, paths: StorePaths, cfg: CouncilConfig, dryRun: boolean, signal?: AbortSignal): PassOptions {
  if (!io.adapters) throw new PassError('no seat adapters');
  return {
    config: cfg,
    configPath: paths.configPath,
    layout: layoutOf(paths),
    api: ghApi({ bin: io.ghBin, env: io.env }),
    dryRun,
    adapters: io.adapters,
    env: io.env,
    ghBin: io.ghBin,
    mirrorSource: io.mirrorSource,
    claudeBin: io.claudeBin,
    headlessPollMs: io.headlessPollMs,
    signal,
    log: (line) => io.write(`auto  ${line}`),
    ...io.passOverrides,
  };
}

export function renderReport(r: PassReport): string[] {
  const out: string[] = [];
  out.push(`pass ${r.outcome}${r.dry_run ? ' (dry run: nothing posts)' : ''}: ${r.started_at} .. ${r.finished_at ?? '?'}`);
  if (r.login !== null) out.push(`account ${r.login}`);
  for (const q of r.queries) out.push(`search  ${q}`);
  out.push(`dropped ${r.dropped} result(s) outside repos_allow or on repos_skip, unread`);
  out.push(`continuation: read ${r.continuation.read} of ${r.continuation.of} PR(s) beyond the search`);
  for (const c of r.candidates) out.push(`pr  ${c.pr}${c.head !== null ? `@${c.head.slice(0, 7)}` : ''} [${c.source}] ${c.action}${c.why !== '' ? `: ${c.why}` : ''}`);
  for (const x of r.rows) out.push(`row ${x.pr}@${x.head.slice(0, 7)}: ${x.from ?? 'new'} -> ${x.to}${x.round_id !== null ? ` (round ${x.round_id})` : ''}${x.why !== '' ? `: ${x.why}` : ''}`);
  for (const n of r.notifications) out.push(`notify ${n.kind} ${n.outcome}: ${n.key}`);
  out.push(`rounds in the last 24 h: ${r.rounds_last_24h} of ${r.max_rounds_per_day}`);
  out.push(`pruned: ${r.pruned.retired} row(s) retired, ${r.pruned.round_dirs} round dir(s), ${r.pruned.roots} root(s), ${r.pruned.orphans ?? 0} orphaned round(s) failed`);
  for (const e of r.errors) out.push(`error ${e}`);
  return out;
}

const EXIT = { done: 0, paused: 0, failed: 1, busy: 3 } as const;

/** `auto run-once [--dry-run]`: one pass. Exit 0 done or paused, 1 failed, 3 another pass is running. */
export async function autoRunOnce(io: AutoIo, paths: StorePaths, dryRun: boolean, json: boolean): Promise<PassReport | null> {
  const cfg = await config(io, paths, true);
  if (cfg === null) return null;
  const store = openStore(paths.dbPath);
  try {
    const report = await runPass(store, passOptions(io, paths, cfg, dryRun));
    if (json) io.write(JSON.stringify(report, null, 2));
    else for (const l of renderReport(report)) io.write(l);
    io.setExitCode(EXIT[report.outcome]);
    return report;
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
    return null;
  } finally {
    store.close();
  }
}

/**
 * `auto run [--dry-run]`: the daemon loop the service runs. Each pass re-reads the config, so an edit applies at the
 * next pass; SIGTERM or SIGINT ends the loop (a running round's legs are cancelled and its attempt fails).
 */
export async function autoRun(io: AutoIo, paths: StorePaths, dryRun: boolean, passes?: number, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const own = signal === undefined;
  if (own) {
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }
  try {
    for (let n = 0; passes === undefined || n < passes; n++) {
      if (controller.signal.aborted) break;
      const cfg = await config(io, paths, true);
      const minutes = cfg?.auto?.interval_minutes ?? 5;
      if (cfg !== null) {
        const store = openStore(paths.dbPath);
        try {
          const report = await runPass(store, passOptions(io, paths, cfg, dryRun, controller.signal));
          for (const l of renderReport(report)) io.write(l);
        } catch (error) {
          io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          store.close();
        }
      }
      if (passes !== undefined && n + 1 >= passes) break;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, minutes * 60_000);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            resolve();
          },
          { once: true },
        );
      });
    }
  } finally {
    if (own) {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    }
  }
  io.setExitCode(0);
}

export function autoStatus(io: AutoIo, paths: StorePaths, json: boolean): void {
  const store = openStore(paths.dbPath);
  try {
    const platform = io.servicePlatform ?? (process.platform === 'darwin' ? 'darwin' : 'linux');
    const status = statusOf(store, platform);
    if (json) {
      io.write(JSON.stringify(status, null, 2));
      return;
    }
    io.write(`paused: ${status.paused.paused ? `yes (${status.paused.reason ?? 'no reason given'}, since ${status.paused.at ?? '?'})` : 'no'}`);
    io.write(`service: ${status.service.installed ? `installed${status.service.shadow === true ? ' (shadow: auto run --dry-run, posts nothing)' : ''}` : 'not installed'} (${status.service.file})`);
    io.write(`rounds in the last 24 h: ${status.rounds_last_24h}`);
    const counts = Object.entries(status.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    io.write(`ledger: ${counts === '' ? 'empty' : counts}`);
    for (const r of status.open) {
      io.write(
        `  ${r.pr}@${r.head.slice(0, 7)} ${r.state}${r.dry_run ? ' (dry)' : ''}${r.claimed ? ' [claimed]' : ''} attempts ${r.attempts}/${MAX_ATTEMPTS}${r.round_id !== null ? ` round ${r.round_id}` : ''}${r.reason !== null ? `: ${r.reason}` : ''}${r.next !== null ? ` | next: ${r.next}` : ''}`,
      );
    }
    if (status.last_pass !== null) {
      io.write(`last pass: ${status.last_pass.outcome}${status.last_pass.dry_run ? ' (dry run)' : ''} at ${status.last_pass.finished_at ?? status.last_pass.started_at}, ${status.last_pass.rows.length} row change(s), ${status.last_pass.errors.length} error(s)`);
    }
    for (const n of status.recent_notifications) io.write(`  notified ${n.ts} ${n.kind}: ${n.message}`);
  } finally {
    store.close();
  }
}

export interface AutoStatus {
  paused: ReturnType<typeof pauseState>;
  service: ReturnType<typeof serviceInstalled>;
  rounds_last_24h: number;
  counts: Record<string, number>;
  open: Array<{ pr: string; head: string; state: string; attempts: number; round_id: number | null; reason: string | null; dry_run: boolean; claimed: boolean; next: string | null }>;
  last_pass: PassReport | null;
  recent_notifications: Array<{ ts: string; kind: string; message: string }>;
}

export function statusOf(store: Store, platform: ServicePlatform, serviceDir?: string): AutoStatus {
  const rows = allRows(store.db);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.state] = (counts[r.state] ?? 0) + 1;
  const open = rows
    .filter((r) => !FINAL_STATES.has(r.state))
    .map((r) => ({
      pr: `${r.repo.replace(/^github\.com\//, '')}#${r.num}`,
      head: r.head,
      state: r.state,
      attempts: r.attempts,
      round_id: r.round_id,
      reason: r.reason,
      dry_run: r.dry_run === 1,
      claimed: claimLive(r),
      next:
        r.state === 'needs-ruling'
          ? r.dry_run === 1
            ? 'none: a dry run is never released; a real pass reviews this head afresh'
            : `sabotage-council ruling ${String(r.round_id)} <finding-id> uphold|overturn, then ruling ${String(r.round_id)} approve|post|skip`
          : r.state === 'failed'
            ? r.attempts >= MAX_ATTEMPTS
              ? `final: see round ${String(r.round_id)} (sabotage-council round show ${String(r.round_id)})`
              : 'the next pass tries again'
            : null,
    }));
  const notes = store.db.prepare("SELECT ts, detail_json FROM events WHERE kind = 'notify' ORDER BY id DESC LIMIT 5").all() as Array<{ ts: string; detail_json: string }>;
  return {
    paused: pauseState(store),
    service: serviceInstalled(platform, serviceDir),
    rounds_last_24h: roundsSince(store, Date.now()),
    counts,
    open,
    last_pass: lastReport(store),
    recent_notifications: notes.map((n) => {
      const d = JSON.parse(n.detail_json) as { kind?: string; message?: string };
      return { ts: n.ts, kind: d.kind ?? '?', message: d.message ?? '' };
    }),
  };
}

export function autoPause(io: AutoIo, paths: StorePaths, paused: boolean, reason: string | undefined): void {
  const store = openStore(paths.dbPath);
  try {
    setPaused(store, paused, reason ?? null);
    io.write(paused ? 'paused: passes do nothing until `auto resume` (a pass already running finishes its current round)' : 'resumed');
  } finally {
    store.close();
  }
}

const CLI_ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

/**
 * `auto install [--shadow] [--dry-run] [--dir] [--no-load]` and `auto uninstall [--dir] [--no-load]` (plan 9.4).
 * `--shadow` installs the shadow mode (the service runs `auto run --dry-run`); `--dry-run` previews the install and
 * writes, creates and loads nothing (P8 round 1 row 13).
 */
export async function autoInstall(io: AutoIo, paths: StorePaths, o: { shadow: boolean; preview: boolean; dir?: string | undefined; load: boolean; uninstall: boolean }): Promise<void> {
  const platform = io.servicePlatform ?? (process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null);
  if (platform === null) {
    io.write(`error: auto install supports macOS (launchd) and Linux (systemd), not ${process.platform}`);
    io.setExitCode(1);
    return;
  }
  const common = { platform, dir: o.dir, load: o.load, loader: io.serviceLoader, plutil: io.plutil, home: io.env['HOME'] };
  try {
    if (o.uninstall) {
      const r = uninstallService(common);
      io.write(`${r.removed ? 'removed' : 'no file at'} ${r.file}`);
      for (const c of r.commands) io.write(`${o.load ? 'ran' : 'would run'}: ${platform === 'darwin' ? 'launchctl' : 'systemctl'} ${c.join(' ')}`);
      for (const p of r.problems) io.write(`warn  ${p}`);
      return;
    }
    const cfg = await config(io, paths, false);
    if (cfg === null) return;
    if (!cfg.github || !cfg.auto) {
      io.write('error: auto needs [github] login and an [auto] table with repos_allow (plan 5.2)');
      io.setExitCode(1);
      return;
    }
    const spec = {
      node: process.execPath,
      cli: CLI_ENTRY,
      configPath: paths.configPath,
      dbPath: paths.dbPath,
      rootsPath: paths.rootsPath,
      shadow: o.shadow,
      path: io.env['PATH'] ?? '/usr/bin:/bin',
      home: io.env['HOME'] ?? '',
      logFile: join(autoDir(layoutOf(paths)), 'daemon.log'),
    };
    const loader = platform === 'darwin' ? 'launchctl' : 'systemctl';
    const mode = o.shadow ? 'auto run --dry-run (the shadow mode: renders reviews, posts nothing)' : 'auto run (posts reviews)';
    if (o.preview) {
      const p = previewService(spec, common);
      io.write(`dry run: nothing is written, created or loaded`);
      io.write(`would create ${p.logDir} (mode 0700) for the daemon's log`);
      io.write(`would write ${p.file}, running ${mode}:`);
      io.write('----- file -----');
      for (const l of p.text.replace(/\n$/, '').split('\n')) io.write(l);
      io.write('----- end -----');
      for (const x of p.problems) io.write(`problem ${x}`);
      if (o.load) for (const c of p.commands) io.write(`would run: ${loader} ${c.join(' ')}`);
      io.setExitCode(p.problems.length > 0 ? 1 : 0);
      return;
    }
    const r = installService(spec, common);
    if (r.written) io.write(`wrote ${r.file}, running ${mode}; its log in ${dirname(spec.logFile)}`);
    for (const p of r.problems) io.write(`problem ${p}`);
    for (const c of r.commands) io.write(`${r.loaded ? 'ran' : 'to load it'}: ${loader} ${c.join(' ')}`);
    io.write(r.loaded ? `loaded: the daemon runs ${mode} every ${cfg.auto.interval_minutes} min; sabotage-council auto status shows it` : 'not loaded');
    io.setExitCode(r.problems.length > 0 ? 1 : 0);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  }
}

/** `ruling <round> <finding-id> uphold|overturn` and `ruling <round> approve|post|skip` (plan 3.8). */
export async function rulingCommand(io: AutoIo, paths: StorePaths, roundId: number, what: string, result: string | undefined, note: string | undefined): Promise<void> {
  const cfg = await config(io, paths, false);
  if (cfg === null) return;
  const by = cfg.github?.login ?? 'user';
  const store = openStore(paths.dbPath);
  try {
    if (result === undefined) {
      if (what !== 'approve' && what !== 'post' && what !== 'skip') {
        io.write('error: give `ruling <round> <finding-id> uphold|overturn` or `ruling <round> approve|post|skip`');
        io.setExitCode(1);
        return;
      }
      const r = releaseRound(store, roundId, what as ReleaseDecision, by, note ?? null);
      io.write(`round ${roundId} released: ${r.decision}${r.archived !== null ? ` (its ruling COMMENT, review ${r.archived}, stays on GitHub; the release posts one more review)` : ''}`);
      if (r.ledger !== null) io.write(`ledger row: ${r.ledger}`);
      io.write(`next: ${r.next}`);
      return;
    }
    if (result !== 'uphold' && result !== 'overturn') {
      io.write('error: a finding takes uphold or overturn');
      io.setExitCode(1);
      return;
    }
    const f = ruleFinding(store, roundId, what, result, by, note ?? null);
    io.write(`round ${roundId} finding ${f.id}: ${String(f.ruling_result)} by ${String(f.ruled_by)}`);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  } finally {
    store.close();
  }
}

