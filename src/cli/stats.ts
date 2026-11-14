import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import { loadConfig, statsSchema, type ConfigIssue, type StatsConfig } from '../config/index.js';
import { formatPath } from '../config/validate.js';
import { loadStats } from '../stats/data.js';
import { writeHtmlReport } from '../stats/html.js';
import { buildReport, thresholdsOf, type Filters, type StatsReport, type Thresholds } from '../stats/report.js';
import { renderText } from '../stats/text.js';
import { openStore } from '../store/index.js';

/*
 * `sabotage-council stats` (plan 8.2, 8.3): the seat scorecard over the run store. It reads; it never changes a
 * round. With no store, or an empty window, it says so and exits 0.
 */

export interface StatsIo {
  write: (line: string) => void;
  setExitCode: (code: number) => void;
}

export interface StatsArgs {
  configPath: string;
  dbPath: string;
  since: string | null;
  filters: Filters;
  json: boolean;
  html: string | null;
  /** Tests pin the clock. */
  generatedAt?: string | undefined;
}

function formatIssue(issue: ConfigIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

/**
 * The swap-candidate thresholds: the config's [stats] section. A missing config file gives the defaults. A config that
 * fails validation elsewhere (a seat, a model) still gives its [stats] section, with a warning; an invalid [stats]
 * section is an error.
 */
export async function statsThresholds(configPath: string): Promise<{ thresholds: Thresholds; warnings: string[] } | { errors: string[] }> {
  if (!existsSync(configPath)) {
    return { thresholds: thresholdsOf(statsSchema.parse({}), 'defaults'), warnings: [] };
  }
  const loaded = await loadConfig(configPath);
  if (loaded.ok) return { thresholds: thresholdsOf(loaded.config.stats, 'config'), warnings: [] };
  let raw: unknown;
  try {
    raw = parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { thresholds: thresholdsOf(statsSchema.parse({}), 'defaults'), warnings: [`config ${configPath} does not parse (${loaded.errors.map(formatIssue).join('; ')}): the [stats] thresholds are the defaults`] };
  }
  const table = typeof raw === 'object' && raw !== null && 'stats' in raw ? (raw as { stats: unknown }).stats : {};
  const stats = statsSchema.safeParse(table);
  if (!stats.success) return { errors: stats.error.issues.map((i) => formatIssue({ path: formatPath(['stats', ...i.path]), message: i.message })) };
  const source: Thresholds['source'] = table === undefined || (typeof table === 'object' && table !== null && Object.keys(table).length === 0) ? 'defaults' : 'config';
  return {
    thresholds: thresholdsOf(stats.data as StatsConfig, source),
    warnings: [`config ${configPath} has ${loaded.errors.length} error(s) outside [stats] (${loaded.errors.map(formatIssue).join('; ')}); its [stats] thresholds still apply`],
  };
}

/** Reads the store and builds the report; null when there is no store file (nothing recorded). */
export function readReport(dbPath: string, since: string | null, thresholds: Thresholds, filters: Filters, generatedAt?: string): StatsReport | null {
  if (!existsSync(dbPath)) return null;
  const store = openStore(dbPath);
  try {
    return buildReport(loadStats(store.db, since), thresholds, filters, generatedAt);
  } finally {
    store.close();
  }
}

export async function statsCommand(io: StatsIo, args: StatsArgs): Promise<void> {
  const t = await statsThresholds(args.configPath);
  if ('errors' in t) {
    io.write(`config ${args.configPath}: the [stats] section has ${t.errors.length} error(s):`);
    for (const e of t.errors) io.write(`  ${e}`);
    io.setExitCode(1);
    return;
  }
  let report = readReport(args.dbPath, args.since, t.thresholds, args.filters, args.generatedAt);
  if (report === null) {
    // No store yet: the same empty report a fresh store would give, without creating one.
    report = emptyReport(args, t.thresholds);
    report.notes.push(`no run store at ${args.dbPath}: no rounds recorded yet`);
  }
  report.notes.unshift(...t.warnings);
  if (args.html !== null) {
    try {
      writeHtmlReport(args.html, report);
    } catch (error) {
      io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
      io.setExitCode(1);
      return;
    }
  }
  if (args.json) {
    io.write(JSON.stringify(report, null, 2));
  } else {
    for (const line of renderText(report)) io.write(line);
    if (args.html !== null) io.write(`html report written to ${args.html}`);
  }
  io.setExitCode(0);
}

function emptyReport(args: StatsArgs, thresholds: Thresholds): StatsReport {
  return buildReport(
    {
      since: args.since,
      rounds: [],
      occupants: new Map(),
      counts: { total: 0, identity: 0, council: 0, running: 0, settled: 0, adjudicated: 0, failed: 0, awaitingAdjudication: 0, dryRun: 0 },
      adjudicatorUsd: 0,
      firstStartedAt: null,
      lastStartedAt: null,
      seatTests: [],
    },
    thresholds,
    args.filters,
    args.generatedAt,
  );
}
