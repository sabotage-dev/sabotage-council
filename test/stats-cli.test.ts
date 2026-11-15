import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import { renderHtml } from '../src/stats/html.js';
import { loadStats } from '../src/stats/data.js';
import { buildReport, thresholdsOf } from '../src/stats/report.js';
import { DEFAULT_MIGRATIONS_DIR, openStore, readMigrations, sqlite } from '../src/store/index.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { OCC, statsStore, three, type FindingSpec, type StatsStore } from './helpers/stats-store.js';

cleanScratchAfterAll();

/*
 * `stats` end to end (plan 8.2, 8.3): text, versioned JSON, the empty cases, the [stats] thresholds from the config,
 * and the HTML report: one self-contained, well-formed file in which every value from a round is escaped.
 */

const NOW = '2026-11-14T00:00:00.000Z';

async function run(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; lines: string[]; text: string }> {
  const lines: string[] = [];
  let code = -1;
  const io: ProgramIo = { write: (l) => lines.push(l), env, setExitCode: (c) => (code = c), now: () => NOW };
  const program = buildProgram(io);
  // A bad option value throws (CommanderError) instead of exiting, and commander's own message stays out of the output.
  for (const c of [program, ...program.commands, ...program.commands.flatMap((x) => x.commands)]) c.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  await program.parseAsync(['node', 'sabotage-council', ...args]);
  return { code, lines, text: lines.join('\n') };
}

const SEATS = '[[seats]]\nid = "a"\nbackend = "codex"\nmodel = "gpt-6.1-sol"\neffort = "high"\n\n[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n[[seats]]\nid = "c"\nbackend = "grok"\nmodel = "grok-4.7"\neffort = "high"\n';

/** A store with one seat (c) flagged at N = 2, and the paths to run `stats` on it. */
function flaggedStore(): { w: StatsStore; config: string } {
  const w = statsStore();
  w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'refuted', by: ['c'], title: 'refuted one' }] });
  w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'refuted', by: ['c'], title: 'refuted two' }, { outcome: 'owed', by: ['a', 'b'] }] });
  const config = join(w.dir, 'config.toml');
  writeFileSync(config, `${SEATS}\n[stats]\nswap_min_ratified_rounds = 2\n`);
  return { w, config };
}

describe('stats CLI', () => {
  it('prints the scorecard as text, with the swap candidate and its evidence', async () => {
    const { w, config } = flaggedStore();
    w.close();
    const r = await run(['stats', '--db', w.dbPath, '--config', config]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe('sabotage-council stats: all history (rounds from 2026-11-01 to 2026-11-01)');
    expect(r.text).toContain('rounds: 2 council (2 settled, 2 adjudicated, 0 failed, 0 awaiting adjudication, 0 still running, 0 dry run), 0 identity');
    expect(r.text).toContain(
      "swap candidate (judged on each seat's current occupant since it took the seat): 0 unique owed, and ratified rate < 80% over >= 2 rounds seated, or precision < 50% over >= 2 adjudicated rounds ratified (config [stats])",
    );
    expect(r.text).toContain(`    - judged on its current occupant ${OCC.c} (the config), in the seat since round #1 (2026-11-01)`);
    expect(r.text).toContain('seat c  (occupants #3)');
    expect(r.text).toContain('  findings  raised 2, adopted 0, refuted 2; precision 0%');
    expect(r.text).toContain('  seat c: SWAP CANDIDATE');
    expect(r.text).toContain('    - precision 0% is below 50%');
    expect(r.text).toMatch(/#\d+ f_0+\d+ MEDIUM refuted unique src\/x\.ts:1: refuted one/);
    expect(r.text).toContain('  a  vs  b: disagree 0 of 2 (0%)  always agree');
    expect(r.text).toContain('  seat a: keep');
  });

  it('prints versioned JSON, the same report', async () => {
    const { w, config } = flaggedStore();
    w.close();
    const r = await run(['stats', '--db', w.dbPath, '--config', config, '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.text) as { schema: string; version: number; generated_at: string; recommendations: Array<{ seat: string; swap_candidate: boolean }>; thresholds: unknown };
    expect(json).toMatchObject({ schema: 'sabotage-council.stats', version: 1, generated_at: NOW });
    expect(json.thresholds).toEqual({ min_ratified_rounds: 2, precision_below: 0.5, ratified_rate_below: 0.8, source: 'config' });
    expect(json.recommendations.map((x) => [x.seat, x.swap_candidate])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
  });

  it('filters by seat and by occupant, and takes --since', async () => {
    const { w, config } = flaggedStore();
    w.close();
    const seat = JSON.parse((await run(['stats', '--db', w.dbPath, '--config', config, '--json', '--seat', 'c'])).text) as { seats: Array<{ seat: string }> };
    expect(seat.seats.map((s) => s.seat)).toEqual(['c']);
    const occ = JSON.parse((await run(['stats', '--db', w.dbPath, '--config', config, '--json', '--occupant', OCC.a])).text) as { occupants: Array<{ occupant: { key: string } }> };
    expect(occ.occupants.map((o) => o.occupant.key)).toEqual([OCC.a]);
    const later = await run(['stats', '--db', w.dbPath, '--config', config, '--since', '2026-11-02']);
    expect(later.code).toBe(0);
    expect(later.text).toContain('no rounds since 2026-11-02T00:00:00.000Z: nothing to score');
    await expect(run(['stats', '--db', w.dbPath, '--since', 'last week'])).rejects.toThrow(/--since takes a duration/);
    await expect(run(['stats', '--db', w.dbPath, '--occupant', 'codex'])).rejects.toThrow(/an occupant is backend:model/);
  });

  it('says so and exits 0 with no store, without creating one', async () => {
    const dir = scratch('sc-stats-none-');
    const db = join(dir, 'data', 'council.db');
    const r = await run(['stats', '--db', db, '--config', join(dir, 'none.toml')]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`note  no run store at ${db}: no rounds recorded yet`);
    expect(r.text).toContain('no rounds in the run store yet: nothing to score');
    expect(existsSync(db)).toBe(false);
    const json = JSON.parse((await run(['stats', '--db', db, '--json'], { HOME: dir })).text) as { message: string; thresholds: { source: string }; notes: string[] };
    expect(json.message).toBe('no rounds in the run store yet: nothing to score');
    expect(json.thresholds.source).toBe('defaults');
    expect(existsSync(db)).toBe(false);
  });

  it('keeps the [stats] thresholds of a config with errors elsewhere, and refuses an invalid [stats] section', async () => {
    const { w } = flaggedStore();
    w.close();
    const broken = join(w.dir, 'broken.toml');
    writeFileSync(broken, '[stats]\nswap_min_ratified_rounds = 2\n\n[[seats]]\nid = "a"\nbackend = "codex"\nmodel = "gpt-6.1-sol"\n');
    const r = await run(['stats', '--db', w.dbPath, '--config', broken]);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^note {2}config .* has 1 error\(s\) outside \[stats\] \(seats: exactly 3 seats are required \(D10\); found 1\); its \[stats\] thresholds still apply$/);
    expect(r.text).toContain('  seat c: SWAP CANDIDATE');
    const bad = join(w.dir, 'bad.toml');
    writeFileSync(bad, '[stats]\nswap_precision_below = 2\n');
    const b = await run(['stats', '--db', w.dbPath, '--config', bad]);
    expect(b.code).toBe(1);
    expect(b.lines).toEqual([`config ${bad}: the [stats] section has 1 error(s):`, '  stats.swap_precision_below: must be from 0 to 1']);
  });

  it('prints hostile titles on one line, with no terminal control characters', async () => {
    const w = statsStore();
    const c = join(w.dir, 'config.toml');
    writeFileSync(c, `${SEATS}\n[stats]\nswap_min_ratified_rounds = 1\n`);
    w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'refuted', by: ['c'], title: 'line one\nseat a: SWAP CANDIDATE\u001b[2J\u0007' }] });
    // Bidi controls reorder what a terminal shows; zero-width characters hide text; C1 and the line separators too.
    w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'refuted', by: ['c'], title: 'evil\u202egnp.exe\u2066x\u2069 zero\u200bwidth\ufeff\u200f end\u2028\u2029\u009b', path: 'src/\u202ex.ts' }] });
    w.close();
    const r = await run(['stats', '--db', w.dbPath, '--config', c]);
    expect(r.text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
    expect(r.lines.filter((l) => l.includes('SWAP CANDIDATE')).map((l) => l.trim())).toEqual(['seat c: SWAP CANDIDATE', expect.stringContaining('line one\uFFFDseat a: SWAP CANDIDATE\uFFFD[2J\uFFFD')]);
    expect(r.text).toContain('src/\uFFFDx.ts:1: evil\uFFFDgnp.exe\uFFFDx\uFFFD zero\uFFFDwidth\uFFFD\uFFFD end\uFFFD\uFFFD\uFFFD');
  });

  it('prints JSON whose bytes hold no DEL, C1, line separator, bidi or zero-width character, and parses to the exact strings', async () => {
    const w = statsStore();
    const c = join(w.dir, 'config.toml');
    writeFileSync(c, `${SEATS}\n[stats]\nswap_min_ratified_rounds = 1\n`);
    const title = 'a\u2028b\u2029c\u007fd\u009be\u0085f\u202eg\u2067h\u200bi\ufeffj';
    w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'refuted', by: ['c'], title, path: 'src/\u202ex.ts' }] });
    w.close();
    const r = await run(['stats', '--db', w.dbPath, '--config', c, '--json']);
    expect(r.text).not.toMatch(/[\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
    expect(r.text).toContain('a\\u2028b\\u2029c\\u007fd\\u009be\\u0085f\\u202eg\\u2067h\\u200bi\\ufeffj');
    const json = JSON.parse(r.text) as { recommendations: Array<{ seat: string; evidence: { findings: Array<{ title: string; path: string }> } | null }> };
    const finding = json.recommendations.find((x) => x.seat === 'c')?.evidence?.findings[0];
    expect(finding).toMatchObject({ title, path: 'src/\u202ex.ts' });
  });
});

// ---- the store is only read ----

/**
 * Whether this Node's SQLite opens a URI filename, as src/store/read.ts tries first: Node 22.15 and later do. Only
 * then is a closed store opened `immutable`, with nothing created beside it. Node 22.13 and 22.14 (the engines
 * floor) take the plain read-only open, and SQLite then leaves the store's `-wal` and `-shm` files beside it; the
 * store's own bytes are unchanged either way.
 */
const IMMUTABLE_OPEN = ((): boolean => {
  const dir = scratch('sc-stats-uri-');
  const path = join(dir, 'probe.db');
  const w = new (sqlite().DatabaseSync)(path);
  w.exec('CREATE TABLE t (a)');
  w.close();
  try {
    new (sqlite().DatabaseSync)(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true }).close();
    return true;
  } catch {
    return false;
  }
})();

/** The files beside a closed store after a read-only command: its own, plus SQLite's two where it cannot open immutable. */
const afterRead = (files: string[]): string[] => (IMMUTABLE_OPEN ? files : [...new Set([...files, 'council.db-shm', 'council.db-wal'])].sort());

describe('stats reads the store read-only', () => {
  const latest = readMigrations().length;

  /** A store at schema version `upTo` (the shipped migrations 1..upTo only). */
  function olderStore(upTo: number): { dir: string; db: string } {
    const dir = scratch('sc-stats-old-');
    const mig = join(dir, 'migrations');
    mkdirSync(mig);
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR)) if (/^\d{3}_/.test(f) && Number(f.slice(0, 3)) <= upTo) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(mig, f));
    const db = join(dir, 'data', 'council.db');
    openStore(db, { migrationsDir: mig }).close();
    return { dir, db };
  }

  it('refuses a store whose schema is behind, names the command that upgrades it, and leaves it byte for byte unchanged', async () => {
    const { dir, db } = olderStore(3);
    const before = readFileSync(db);
    const files = readdirSync(join(dir, 'data')).sort();
    expect(files).toEqual(['council.db']);
    const r = await run(['stats', '--db', db, '--config', join(dir, 'none.toml')]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([
      `error: the run store at ${db} is at schema version 3; this build reads version ${latest}, and this command never writes the store: run \`sabotage-council doctor --db ${db}\` once to upgrade it (doctor applies the pending migrations), then run this again`,
    ]);
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(readdirSync(join(dir, 'data')).sort()).toEqual(afterRead(files));
    // `seats list` reads the scorecard the same way: the seats are listed, the store is left alone.
    const config = join(dir, 'config.toml');
    writeFileSync(config, SEATS);
    const list = await run(['seats', 'list', '--config', config, '--db', db, '--no-preflight']);
    expect(list.code).toBe(0);
    expect(list.lines[0]).toMatch(/^note {2}the scorecard is not shown: the run store at .* is at schema version 3;/);
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(readdirSync(join(dir, 'data')).sort()).toEqual(afterRead(files));
    // The command it names upgrades the store; stats then reads it.
    await run(['doctor', '--db', db, '--config', join(dir, 'none.toml')]);
    expect((await run(['stats', '--db', db, '--config', join(dir, 'none.toml')])).code).toBe(0);
  });

  it('refuses a store ahead of this build', async () => {
    const { dir, db } = olderStore(latest);
    const s = openStore(db);
    s.db.prepare("INSERT INTO schema_version (version, name, sha256, applied_at) VALUES (?, 'future', 'x', '2026-11-14T00:00:00.000Z')").run(latest + 1);
    s.close();
    const before = readFileSync(db);
    const r = await run(['stats', '--db', db, '--config', join(dir, 'none.toml')]);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([`error: the run store at ${db} has schema version ${latest + 1}, newer than this build reads (${latest}): it was written by a newer sabotage-council; upgrade this one to read it`]);
    expect(readFileSync(db).equals(before)).toBe(true);
  });

  it('creates no -wal or -shm file beside a closed store (where SQLite opens it immutable), and reads a writer\'s last commit through its open ones', async () => {
    const w = statsStore();
    w.round({ legs: three() });
    // A writer has the store open (its -wal and -shm exist): stats sees its uncheckpointed commits.
    expect(existsSync(`${w.dbPath}-wal`)).toBe(true);
    const live = JSON.parse((await run(['stats', '--db', w.dbPath, '--json'], { HOME: w.dir })).text) as { window: { rounds: { council: number } } };
    expect(live.window.rounds.council).toBe(1);
    w.round({ legs: three() });
    const live2 = JSON.parse((await run(['stats', '--db', w.dbPath, '--json'], { HOME: w.dir })).text) as { window: { rounds: { council: number } } };
    expect(live2.window.rounds.council).toBe(2);
    w.close();
    const dataDir = join(w.dir, 'data');
    const files = readdirSync(dataDir).sort();
    expect(files).toEqual(['council.db']);
    const before = readFileSync(w.dbPath);
    const r = await run(['stats', '--db', w.dbPath, '--json'], { HOME: w.dir });
    expect(r.code).toBe(0);
    expect((JSON.parse(r.text) as { window: { rounds: { council: number } } }).window.rounds.council).toBe(2);
    expect(readdirSync(dataDir).sort()).toEqual(afterRead(files));
    expect(readFileSync(w.dbPath).equals(before)).toBe(true);
  });

  it('refuses a file that is not a run store, with an error rather than a crash', async () => {
    const dir = scratch('sc-stats-notdb-');
    const db = join(dir, 'council.db');
    writeFileSync(db, 'not a database');
    const r = await run(['stats', '--db', db, '--config', join(dir, 'none.toml')]);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/^error: /);
    expect(readFileSync(db, 'utf8')).toBe('not a database');
  });
});

// ---- the HTML report ----

const HOSTILE = {
  script: '<script>alert(1)</script>',
  style: '</style><style>body{display:none}</style>',
  quote: '" onmouseover="alert(1)" x=\'',
  js: 'javascript:alert(document.cookie)',
  url: 'https://evil.example/x.js',
  bidi: 'evil\u202egnp.exe\u2066x\u2069',
  zw: 'zero\u200bwidth\ufeff\u200e',
};

/**
 * The sample store: 24 ordinary rounds (fallbacks, relaunches, a failed leg, owed and refuted findings, costs in every
 * unit) in which seat c earns a swap-candidate flag, then one round whose finding titles, paths, a model name and a
 * seat test carry hostile strings. Seat c raises the hostile findings, so its evidence table renders them.
 */
function hostileStore(): StatsStore {
  const w = statsStore();
  for (let i = 0; i < 24; i++) {
    const usage = i % 6 === 5;
    const relaunch = i % 8 === 3;
    const findings: FindingSpec[] = [];
    if (i % 3 === 0) findings.push({ outcome: 'owed', severity: i % 2 === 0 ? 'HIGH' : 'MEDIUM', by: i % 2 === 0 ? ['a'] : ['a', 'b'], title: `owed finding in round ${i + 1}`, path: 'src/server/handler.ts', line: 10 + i });
    if (i % 2 === 0) findings.push({ outcome: 'refuted', by: ['c'], title: `a claim the adjudicator refuted (${i + 1})`, path: 'src/server/router.ts', line: 40 + i });
    if (i % 5 === 0) findings.push({ outcome: 'follow-up', severity: 'LOW', by: ['b', 'c'], title: `a follow-up in round ${i + 1}`, path: 'README.md', line: 3 });
    const blocking = findings.some((f) => f.outcome === 'owed');
    w.round({
      target: i % 4 === 0 ? 'api' : 'widget',
      dryRun: i >= 18,
      adjudicatorUsd: 0.12,
      legs: [
        ...(usage
          ? [
              { seat: 'a', occ: OCC.a, status: 'FAIL' as const, failure: 'usage_limit', quota: 100 },
              { seat: 'a', occ: OCC.af, role: 'fallback' as const, verdict: blocking ? ('NEEDS-WORK' as const) : ('SHIP' as const), credits: 0.6, durationMs: 70_000 + i * 900 },
            ]
          : [{ seat: 'a', occ: OCC.a, verdict: blocking ? ('NEEDS-WORK' as const) : ('SHIP-WITH-FIXES' as const), quota: 20 + i * 3, durationMs: 40_000 + i * 1500 }]),
        ...(relaunch
          ? [
              { seat: 'b', occ: OCC.b, status: 'FAIL' as const, failure: 'empty', usd: 0.01 },
              { seat: 'b', occ: OCC.b, attempt: 2, verdict: blocking && i % 2 === 1 ? ('NEEDS-WORK' as const) : ('SHIP' as const), usd: 0.09, durationMs: 30_000 },
            ]
          : [{ seat: 'b', occ: OCC.b, verdict: blocking && i % 2 === 1 ? ('NEEDS-WORK' as const) : ('SHIP' as const), usd: 0.05 + i / 1000, durationMs: 20_000 + i * 700 }]),
        { seat: 'c', occ: OCC.c, verdict: i % 2 === 0 ? ('NEEDS-WORK' as const) : ('SHIP' as const), usd: 0.03, durationMs: 60_000 + i * 2000 },
      ],
      findings,
    });
  }
  w.round({
    target: 'widget',
    legs: [
      { seat: 'a', occ: `codex:${HOSTILE.script}:high`, verdict: 'NEEDS-WORK' },
      { seat: 'b', occ: OCC.b },
      { seat: 'c', occ: OCC.c, verdict: 'NEEDS-WORK' },
    ],
    findings: [
      { outcome: 'refuted', by: ['c'], title: `${HOSTILE.script} ${HOSTILE.style}`, path: HOSTILE.js, line: 3 },
      { outcome: 'refuted', by: ['c'], title: `${HOSTILE.quote} ${HOSTILE.url}`, path: `src/${HOSTILE.quote}.ts` },
      { outcome: 'follow-up', by: ['a', 'c'], title: `${HOSTILE.js} & more`, path: HOSTILE.style },
      { outcome: 'refuted', by: ['c'], title: `${HOSTILE.bidi} ${HOSTILE.zw}`, path: `src/${HOSTILE.bidi}.ts` },
      { outcome: 'owed', severity: 'HIGH', by: ['a'], title: 'a plain owed finding' },
    ],
  });
  w.seatTest({ occupant: { backend: 'claude', model: 'claude-haiku-5-5', effort: 'low' }, ratified: true, status: 'PASS', verdict: 'NEEDS-WORK', defects: { found: ['D1', 'D2', 'D3'], total: 3 }, cost_usd: 0.031, duration_ms: 48_000 });
  w.seatTest({ seat: HOSTILE.script, occupant: { backend: 'claude', model: HOSTILE.quote, effort: 'low' }, ratified: false, status: 'FAIL', failure_class: HOSTILE.style, verdict: null, defects: { found: [HOSTILE.js], total: 3 } });
  return w;
}

const VOID = new Set(['meta', 'br', 'hr', 'img', 'input', 'link']);

/** A strict well-formedness check for the subset of HTML the report writes. Returns the problems found. */
export function wellFormed(html: string): string[] {
  const problems: string[] = [];
  if (!html.startsWith('<!doctype html>\n')) problems.push('no doctype first');
  const body = html.replace(/^<!doctype html>\n/, '');
  const stack: string[] = [];
  const tag = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*>/gy;
  let i = 0;
  let inStyle = false;
  while (i < body.length) {
    const lt = body.indexOf('<', i);
    const text = body.slice(i, lt === -1 ? body.length : lt);
    if (!inStyle) {
      if (text.includes('>')) problems.push(`a bare > in text near ${JSON.stringify(text.slice(0, 40))}`);
      for (const m of text.matchAll(/&/g)) {
        if (!/^&(?:amp|lt|gt|quot|#39);/.test(text.slice(m.index))) problems.push(`a bare & near ${JSON.stringify(text.slice(m.index, m.index + 12))}`);
      }
    }
    if (lt === -1) break;
    tag.lastIndex = lt;
    const m = tag.exec(body);
    if (!m) {
      problems.push(`not a tag at ${JSON.stringify(body.slice(lt, lt + 40))}`);
      i = lt + 1;
      continue;
    }
    const [, close, name] = m as unknown as [string, string, string];
    if (inStyle && !(close === '/' && name === 'style')) problems.push(`a tag inside the style sheet: ${m[0]}`);
    if (close === '/') {
      const top = stack.pop();
      if (top !== name) problems.push(`</${name}> closes <${String(top)}>`);
      if (name === 'style') inStyle = false;
    } else if (!VOID.has(name)) {
      stack.push(name);
      if (name === 'style') inStyle = true;
    }
    i = lt + m[0].length;
  }
  if (stack.length > 0) problems.push(`unclosed: ${stack.join(' > ')}`);
  return problems;
}

/** Every tag (with its attributes) and the style sheet: the places a fetch or a script could hide. */
function markup(html: string): string {
  const tags = [...html.matchAll(/<[^>]*>/g)].map((m) => m[0]).join('\n');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  return `${tags}\n${style}`;
}

describe('stats --html', () => {
  it('is well formed, self-contained, light and dark, phone width, and escapes every value from a round', () => {
    const w = hostileStore();
    const report = buildReport(loadStats(w.store.db, null), thresholdsOf({ swap_min_ratified_rounds: 20, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'config'), { seat: null, occupant: null }, NOW);
    expect(report.recommendations.map((r) => [r.seat, r.swap_candidate])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ]);
    w.close();
    const html = renderHtml(report);
    const sample = process.env['SC_STATS_SAMPLE_HTML'];
    if (sample !== undefined && sample !== '') writeFileSync(sample, html, { mode: 0o600 });

    expect(wellFormed(html)).toEqual([]);
    const m = markup(html);
    expect(m).not.toMatch(/https?:|javascript:|\burl\(|@import|\bsrc=|\bhref=|<script|<link|<img|<iframe|<object|<embed|<base\b|<form/i);
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`);
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('.scroll { overflow-x: auto;');

    // Every hostile string appears only escaped.
    expect(html.match(/<script/gi)).toBeNull();
    expect(html.match(/<\/style>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
    expect(html).not.toContain('" onmouseover=');
    expect(html).not.toContain("x='");
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;/style&gt;&lt;style&gt;body{display:none}&lt;/style&gt;');
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)&quot; x=&#39;');
    expect(html).toContain('javascript:alert(document.cookie) &amp; more');
    expect(html).toContain('<code>javascript:alert(document.cookie):3</code>');
    expect(html).toContain('&quot; onmouseover=&quot;alert(1)&quot; x=&#39; https://evil.example/x.js');
    expect(html).toContain('<span class="flag">swap candidate</span>');
    // The hostile model name and the seat test's fields too.
    expect(html).toContain('codex:&lt;script&gt;alert(1)&lt;/script&gt;:high');
    expect(html).toContain('(seat &lt;script&gt;alert(1)&lt;/script&gt;)');
    expect(html).toContain('no (&lt;/style&gt;&lt;style&gt;body{display:none}&lt;/style&gt;)');
    // Bidi controls and zero-width characters are neutralized.
    expect(html).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
    expect(html).toContain('evil\uFFFDgnp.exe\uFFFDx\uFFFD zero\uFFFDwidth\uFFFD\uFFFD');
    expect(html).toContain('<code>src/evil\uFFFDgnp.exe\uFFFDx\uFFFD.ts:1</code>');
  });

  it('writes the file with mode 0600, replaces a regular file, and refuses a symlink or a directory', async () => {
    const { w, config } = flaggedStore();
    w.close();
    const dir = scratch('sc-stats-html-');
    const out = join(dir, 'report.html');
    const r = await run(['stats', '--db', w.dbPath, '--config', config, '--html', out]);
    expect(r.code).toBe(0);
    expect(r.lines.at(-1)).toBe(`html report written to ${out}`);
    expect(lstatSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toContain('<span class="flag">swap candidate</span>');

    writeFileSync(out, 'old', { mode: 0o644 });
    expect((await run(['stats', '--db', w.dbPath, '--config', config, '--html', out, '--json'])).code).toBe(0);
    expect(readFileSync(out, 'utf8')).toMatch(/^<!doctype html>/);
    expect(lstatSync(out).mode & 0o777).toBe(0o600);

    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep me');
    const link = join(dir, 'link.html');
    symlinkSync(victim, link);
    const s = await run(['stats', '--db', w.dbPath, '--config', config, '--html', link]);
    expect(s.code).toBe(1);
    expect(s.lines).toEqual([`error: refusing to write the report over ${link}: it is not a regular file`]);
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    const sub = join(dir, 'sub.html');
    mkdirSync(sub);
    expect((await run(['stats', '--db', w.dbPath, '--config', config, '--html', sub])).code).toBe(1);
    expect(lstatSync(sub).isDirectory()).toBe(true);
  });

  it('shows every agreement pair a filtered report keeps, as the text and the JSON do', () => {
    const w = statsStore();
    w.round({ legs: three({ a: 'NEEDS-WORK', b: 'SHIP', c: 'SHIP-WITH-FIXES' }) });
    w.round({ legs: three({ a: 'SHIP', b: 'SHIP', c: 'NEEDS-WORK' }) });
    const data = loadStats(w.store.db, null);
    w.close();
    const t = thresholdsOf({ swap_min_ratified_rounds: 20, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'defaults');
    const report = buildReport(data, t, { seat: 'a', occupant: null }, NOW);
    expect(report.agreement.seats.map((p) => `${p.a}-${p.b}`)).toEqual(['a-b', 'a-c']);
    const html = renderHtml(report);
    expect(wellFormed(html)).toEqual([]);
    const table = /<h2>Agreement<\/h2>[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    // Axes a, b and c: a's pairs with b and c are shown; b-c is not a pair this filter keeps.
    expect([...table.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(['', 'a', 'b', 'c']);
    expect(table).toContain('<td>1 of 2 disagree (50%)</td>');
    expect(table).toContain('<td>2 of 2 disagree (100%)</td>');
    expect(table).toContain('<td class="muted">not in this filter</td>');
    // By occupant: the same, with the occupant axes in id order.
    const occTable = /<h3>By occupant<\/h3>[\s\S]*?<\/table>/.exec(html)?.[0] ?? '';
    expect([...occTable.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1])).toEqual(['', `${OCC.a} #1`, `${OCC.b} #2`, `${OCC.c} #3`]);
    expect(occTable).toContain('<td>1 of 2 disagree (50%)</td>');
  });

  it('renders the empty report too', () => {
    const w = statsStore();
    const html = renderHtml(buildReport(loadStats(w.store.db, null), thresholdsOf({ swap_min_ratified_rounds: 20, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'defaults'), { seat: null, occupant: null }, NOW));
    w.close();
    expect(wellFormed(html)).toEqual([]);
    expect(html).toContain('no rounds in the run store yet: nothing to score');
  });

  it('the checker itself catches what it must', () => {
    expect(wellFormed('<!doctype html>\n<p>a < b</p>')).not.toEqual([]);
    expect(wellFormed('<!doctype html>\n<p>a > b</p>')).not.toEqual([]);
    expect(wellFormed('<!doctype html>\n<p><b>x</p></b>')).not.toEqual([]);
    expect(wellFormed('<!doctype html>\n<p title="a" onclick="x">x</p>')).toEqual([]);
    expect(wellFormed('<!doctype html>\n<p title="a"b">x</p>')).not.toEqual([]);
    expect(wellFormed('<!doctype html>\n<p>R&D</p>')).not.toEqual([]);
    expect(wellFormed('<!doctype html>\n<div><p>x</p>')).not.toEqual([]);
  });
});
