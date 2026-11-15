import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../src/adapters/claude/index.js';
import type { SeatAdapters } from '../src/adapters/index.js';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import type { LegHandle, Occupant, Preflight, Ratification, RoundCtx, SeatAdapter } from '../src/adapters/types.js';
import { buildPlantedRepo, DEFAULT_FIXTURE_DIR, loadFixture, matchDefects, matchDefectsInText } from '../src/seats/fixture.js';
import { runSeatTest } from '../src/seats/run.js';
import { resolveOccupantSpec } from '../src/seats/spec.js';
import { loadStats } from '../src/stats/data.js';
import { buildReport, thresholdsOf } from '../src/stats/report.js';
import { openStore } from '../src/store/index.js';
import { fakeRegistry } from './fake-registry.js';
import { cleanScratchAfterAll, fixtureDir, scratch } from './helpers/fixtures.js';
import { git } from './helpers/git-fixture.js';

cleanScratchAfterAll();

/*
 * `seats test` (plan 8.4) end to end with the fake claude CLI: one that finds every planted defect, one that finds
 * none, one whose leg fails ratification, and one that hangs past the cap. Every fake runs from its own copy of the
 * fake binary, so the process check after each run sees only this test's fakes. A seat test never writes a round.
 */

const FAKE_CLAUDE_SRC = new URL('./fixtures/bin/fake-claude.mjs', import.meta.url).pathname;

const ALL_DEFECTS = [
  'NONCE: ${NONCE}',
  '',
  'F1 HIGH planted/calc/rangesum.py:11: the loop drops the end element.',
  'F2 MEDIUM planted/calc/rangesum.py:6: the bounds check accepts end == len(values).',
  'F3 MEDIUM planted/calc/rangesum.py:20: mean floors.',
  '',
  'Not verified: nothing.',
  '',
  '```findings',
  'F1 | HIGH | planted/calc/rangesum.py:11 | range_sum drops the end element',
  'F2 | MEDIUM | planted/calc/rangesum.py:6 | the bounds check lets end == len(values) through',
  'F3 | MEDIUM | planted/calc/rangesum.py | mean uses floor division',
  'F4 | LOW | planted/calc/test_rangesum.py:8 | test_mean does not cover a fractional mean',
  '```',
  '',
  'VERDICT: NEEDS-WORK',
].join('\n');

const NO_DEFECTS = ['NONCE: ${NONCE}', '', 'The change looks fine.', '', 'Not verified: nothing.', '', '```findings', 'none', '```', '', 'VERDICT: SHIP'].join('\n');

interface Fake {
  bin: string;
  home: string;
  env: NodeJS.ProcessEnv;
  adapters: SeatAdapters;
}

/** A fake claude from its own copy of the binary, configured by `config` (the fake's $HOME/fake-claude.json). */
function fakeClaude(config: Record<string, unknown>): Fake {
  const dir = scratch('sc-seat-test-fake-');
  const bin = join(dir, 'bin', 'fake-claude.mjs');
  mkdirSync(join(dir, 'bin'));
  copyFileSync(FAKE_CLAUDE_SRC, bin);
  const home = join(dir, 'home');
  mkdirSync(home);
  writeFileSync(join(home, 'fake-claude.json'), JSON.stringify({ fixture: fixtureDir('claude', 'success'), replay: true, ...config }));
  const adapter = createClaudeAdapter({ bin });
  return { bin, home, env: { PATH: process.env['PATH'], HOME: home }, adapters: (b) => (b === 'claude' ? adapter : undefined) };
}

/** Processes still running from this fake's binary. */
function running(bin: string): string[] {
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  return out.split('\n').filter((l) => l.includes(bin));
}

const CLAUDE_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];

async function run(
  args: string[],
  fake: Fake,
  paths: { config: string; db: string; roots: string },
  models: readonly string[] = CLAUDE_MODELS,
): Promise<{ code: number; lines: string[]; text: string; err: string[] }> {
  const lines: string[] = [];
  const err: string[] = [];
  let code = -1;
  const io: ProgramIo = {
    write: (l) => lines.push(l),
    writeErr: (l) => err.push(l),
    env: fake.env,
    setExitCode: (c) => (code = c),
    adapters: fake.adapters,
    registry: fakeRegistry({ claude: models.map((id) => ({ id, family: 'anthropic' })) }),
    seatTestPollMs: 20,
  };
  const program = buildProgram(io);
  for (const c of [program, ...program.commands, ...program.commands.flatMap((c) => c.commands)]) c.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  await program.parseAsync(['node', 'sabotage-council', ...args, '--config', paths.config, '--db', paths.db, '--roots', paths.roots]);
  return { code, lines, text: lines.join('\n'), err };
}

function places(): { config: string; db: string; roots: string; dir: string } {
  const dir = scratch('sc-seat-test-');
  return { dir, config: join(dir, 'config.toml'), db: join(dir, 'data', 'council.db'), roots: join(dir, 'roots') };
}

function storeRows(db: string): { rounds: number; legs: number; occupants: number; tests: Array<Record<string, unknown>> } {
  const store = openStore(db);
  try {
    const n = (t: string): number => (store.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    const tests = (store.db.prepare("SELECT round_id, detail_json FROM events WHERE kind = 'seat-test' ORDER BY id").all() as Array<{ round_id: number | null; detail_json: string }>).map((r) => ({
      round_id: r.round_id,
      ...(JSON.parse(r.detail_json) as Record<string, unknown>),
    }));
    return { rounds: n('rounds'), legs: n('legs'), occupants: n('occupants'), tests };
  } finally {
    store.close();
  }
}

describe('seats test: the shipped planted-defect fixture', () => {
  it('ships in the package, outside test/, with three defects in one file', () => {
    expect(DEFAULT_FIXTURE_DIR).not.toContain('/test/');
    const f = loadFixture();
    const head = (f.head.get('calc/rangesum.py') ?? '').split('\n');
    expect([head[5], head[10], head[19]]).toEqual(['    if start < 0 or end > len(values):', '    for i in range(start, end):', '    return sum(values) // len(values)']);
    expect(f.defects.map((d) => [d.id, d.severity, d.path, d.lines])).toEqual([
      ['D1', 'HIGH', 'calc/rangesum.py', [11, 11]],
      ['D2', 'MEDIUM', 'calc/rangesum.py', [6, 6]],
      ['D3', 'MEDIUM', 'calc/rangesum.py', [20, 20]],
    ]);
    // The ranges are the changed lines only: the base and the head differ at 6, 11 and 20, nowhere else.
    const base = (f.base.get('calc/rangesum.py') ?? '').split('\n');
    const changed = head.map((l, i) => (l !== base[i] ? i + 1 : 0)).filter((n) => n > 0);
    expect(changed).toEqual([6, 11, 20]);
    for (const d of f.defects) expect(changed).toContain(d.lines[0]);
    for (const d of f.defects) expect(d.keywords).not.toContain('//');
    expect([...f.base.keys()]).toEqual(['calc/__init__.py', 'calc/rangesum.py', 'calc/test_rangesum.py']);
    for (const p of f.base.keys()) if (p !== 'calc/rangesum.py') expect(f.head.get(p), p).toBe(f.base.get(p));

    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('fixtures/planted');
  });

  it('builds the same repository (the same shas) every time', () => {
    const f = loadFixture();
    const one = buildPlantedRepo(f, join(scratch('sc-planted-'), 'repo'));
    const two = buildPlantedRepo(f, join(scratch('sc-planted-'), 'repo'));
    expect([one.base, one.head]).toEqual([two.base, two.head]);
    expect(git(one.repo, ['diff', '--stat', one.base, one.head])).toContain('calc/rangesum.py | 6 +++---');
    expect(git(one.repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feature');
  });

  const finding = (id: string, path: string | null, line: number | null, title: string) => ({ id, severity: 'HIGH' as const, severity_raw: 'HIGH', severity_flag: null, path, line, end_line: null, title });

  it('matches a finding to one defect by line, else by keyword on the right file', () => {
    const f = loadFixture();
    const r = matchDefects(f, [
      finding('F1', 'planted/calc/rangesum.py', 11, 'anything'),
      finding('F2', './calc/rangesum.py', null, 'An out-of-range END is accepted'),
      finding('F3', 'calc/rangesum.py', 2, 'floor division in mean'),
      finding('F4', 'calc/other.py', 11, 'off-by-one'),
      finding('F5', null, null, 'off-by-one somewhere'),
      finding('F6', 'calc/rangesum.py', 15, 'a tidy-up'),
      finding('F7', 'calc/rangesum.py', 12, 'the loop'),
      finding('F8', 'calc/rangesum.py', 13, 'after the loop'),
      finding('F9', './planted/calc/rangesum.py', 20, 'anything'),
    ]);
    expect(r.matches).toEqual([
      { defect: 'D1', finding: 'F1', by: 'line' },
      { defect: 'D2', finding: 'F2', by: 'keyword' },
      { defect: 'D3', finding: 'F3', by: 'keyword' },
      { defect: 'D3', finding: 'F9', by: 'line' },
    ]);
    // Line 12 is unchanged: no line match, and "the loop" names no defect.
    expect(r.other).toEqual(['F4', 'F5', 'F6', 'F7', 'F8']);
  });

  it('never credits the base copy or another prefix, an unchanged line, or "//" in a URL', () => {
    const f = loadFixture();
    const r = matchDefects(f, [
      // The base copy holds the correct code at the same lines.
      finding('F1', '_base/calc/rangesum.py', 11, 'range(start, end) drops the end element'),
      finding('F2', '_base/planted/calc/rangesum.py', 6, 'bounds check'),
      finding('F3', 'vendor/calc/rangesum.py', 20, 'floor division'),
      finding('F4', '/abs/planted/calc/rangesum.py', 11, 'off-by-one'),
      // The unchanged guard at 18-19.
      finding('F5', 'planted/calc/rangesum.py', 19, 'mean of an empty list raises ValueError'),
      // A title holding a URL, on the right file but no defect's line.
      finding('F6', 'planted/calc/rangesum.py', 15, 'see https://docs.python.org/3/library/functions.html'),
    ]);
    expect(r.matches).toEqual([]);
    expect(r.other).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
  });

  it('gives a keyword match to the defect with the most hits, never the first in file order; a tie is no match', () => {
    const f = loadFixture();
    const r = matchDefects(f, [
      // A D2 finding that names range(start, end) (a D1 keyword) holds more of D2's keywords.
      finding('F1', 'planted/calc/rangesum.py', null, 'the bounds check lets an out-of-range end through to range(start, end)'),
      // One keyword each of D1 and D2: no match.
      finding('F2', 'planted/calc/rangesum.py', null, 'off-by-one in the bounds check'),
      // A line on no defect, two D1 keywords.
      finding('F3', 'planted/calc/rangesum.py', 12, 'off-by-one: drops the end element'),
      finding('F4', 'planted/calc/rangesum.py', null, 'Integer division TRUNCATES the mean'),
    ]);
    expect(r.matches).toEqual([
      { defect: 'D2', finding: 'F1', by: 'keyword' },
      { defect: 'D1', finding: 'F3', by: 'keyword' },
      { defect: 'D3', finding: 'F4', by: 'keyword' },
    ]);
    expect(r.other).toEqual(['F2']);
  });

  it('reads citations in the answer text by the same path rule', () => {
    const f = loadFixture();
    const ids = (text: string): string[] => matchDefectsInText(f, text).map((m) => m.defect);
    expect(ids('see planted/calc/rangesum.py:11 and calc/rangesum.py:19, not calc/rangesum.py:2')).toEqual(['D1']);
    expect(ids('`./calc/rangesum.py:6` and (./planted/calc/rangesum.py:20)')).toEqual(['D2', 'D3']);
    expect(ids('_base/calc/rangesum.py:11 _base/planted/calc/rangesum.py:6 vendor/calc/rangesum.py:20 x-calc/rangesum.py:11')).toEqual([]);
  });
});

describe('seats test: reading backend:model[:effort] against the adapter\'s list', () => {
  it('takes the whole rest when listed, the split when only it is listed, and refuses both or neither', () => {
    expect(resolveOccupantSpec('opencode:ollama/llama3:8b', ['ollama/llama3:8b'])).toEqual({ ok: true, occupant: { backend: 'opencode', model: 'ollama/llama3:8b', effort: undefined } });
    expect(resolveOccupantSpec('opencode:ollama/llama3:8b', ['ollama/llama3'])).toEqual({ ok: true, occupant: { backend: 'opencode', model: 'ollama/llama3', effort: '8b' } });
    expect(resolveOccupantSpec('opencode:ollama/llama3:8b:high', ['ollama/llama3:8b'])).toEqual({ ok: true, occupant: { backend: 'opencode', model: 'ollama/llama3:8b', effort: 'high' } });
    expect(resolveOccupantSpec('claude:claude-haiku-5-5:low', ['claude-haiku-5-5'])).toEqual({ ok: true, occupant: { backend: 'claude', model: 'claude-haiku-5-5', effort: 'low' } });
    expect(resolveOccupantSpec('claude:claude-haiku-5-5', ['claude-haiku-5-5'])).toEqual({ ok: true, occupant: { backend: 'claude', model: 'claude-haiku-5-5', effort: undefined } });
    const both = resolveOccupantSpec('opencode:ollama/llama3:8b', ['ollama/llama3', 'ollama/llama3:8b']);
    expect(both.ok).toBe(false);
    expect(both.ok ? '' : both.message).toContain('model "ollama/llama3:8b" at the CLI\'s default effort, or model "ollama/llama3" at effort "8b"');
    expect(resolveOccupantSpec('claude:nope', ['x'])).toEqual({ ok: false, message: 'backend "claude" does not offer model "nope"' });
    // A trailing colon is no effort: only the whole reading, which is not listed.
    expect(resolveOccupantSpec('claude:claude-haiku-5-5:', ['claude-haiku-5-5'])).toEqual({ ok: false, message: 'backend "claude" does not offer model "claude-haiku-5-5:"' });
    for (const bad of ['claude:', ':x', 'claude']) expect(resolveOccupantSpec(bad, ['x']), bad).toEqual({ ok: false, message: `"${bad}" is not backend:model[:effort]` });
  });
});

describe('seats test: one leg end to end with the fake claude', () => {
  it('a candidate that finds every planted defect qualifies (exit 0), and only a seat-test event is recorded', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low'], fake, p);
    expect(r.lines[0]).toBe(
      'seats test: about to run one paid leg: backend claude, model claude-haiku-5-5, effort low (a candidate, not in the config); capped at 25 min, on the planted-defect fixture (3 defects)',
    );
    expect(r.code).toBe(0);
    expect(r.lines[1]).toMatch(/^ratification {2}PASS; enforcement strong; claude [0-9.]+$/);
    expect(r.text).toContain('verdict       NEEDS-WORK');
    expect(r.text).toContain('defects       found 3 of 3; 1 other finding(s) (the base is correct, so these are noise)');
    expect(r.text).toContain('  found   D1 HIGH range_sum drops the end element: range(start, end) excludes the inclusive end (off-by-one) (F1, by line)');
    expect(r.text).toContain('(F3, by keyword)');
    expect(r.text).toMatch(/cost {10}\$0\.0017; duration /);
    expect(r.lines.at(-1)).toBe('qualified: it ratified and found every planted defect (recorded as a seat test; it never counts in stats)');
    expect(running(fake.bin)).toEqual([]);

    const rows = storeRows(p.db);
    expect([rows.rounds, rows.legs, rows.occupants]).toEqual([0, 0, 0]);
    expect(rows.tests).toEqual([
      expect.objectContaining({
        round_id: null,
        seat: null,
        occupant: { backend: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
        ratified: true,
        status: 'PASS',
        verdict: 'NEEDS-WORK',
        defects: { found: ['D1', 'D2', 'D3'], missed: [], total: 3, other_findings: 1 },
      }),
    ]);
    // stats counts no round, and lists the test on its own.
    const store = openStore(p.db);
    const report = buildReport(loadStats(store.db, null), thresholdsOf({ swap_min_ratified_rounds: 20, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'defaults'), { seat: null, occupant: null });
    store.close();
    expect(report.message).toBe('no rounds in the run store yet: nothing to score');
    expect(report.seat_tests).toEqual([expect.objectContaining({ backend: 'claude', ratified: true, defects_found: ['D1', 'D2', 'D3'], defects_total: 3 })]);
    // The work dir (repository and root) is gone; the leg's records stay beside the store.
    expect(readdirSync(join(p.roots, 'seat-tests'))).toEqual([]);
    const legDirs = readdirSync(join(p.dir, 'data', 'seat-tests'));
    expect(legDirs).toHaveLength(1);
    expect(readdirSync(join(p.dir, 'data', 'seat-tests', legDirs[0] ?? ''))).toEqual(expect.arrayContaining(['answer.md', 'preflight.json', 'ratification.json', 'reply.json']));
  });

  it('a leg that finds none ratifies but does not qualify (exit 2)', async () => {
    const fake = fakeClaude({ answer: NO_DEFECTS });
    const p = places();
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low', '--json'], fake, p);
    expect(r.code).toBe(2);
    // stdout is only the JSON; the paid-leg notice went to stderr.
    const json = JSON.parse(r.text) as Record<string, unknown>;
    expect(r.err).toEqual([expect.stringMatching(/^seats test: about to run one paid leg: backend claude, model claude-haiku-5-5, effort low /)]);
    expect(json).toMatchObject({ ratified: true, status: 'PASS', verdict: 'SHIP', exit_code: 2, defects: { found: [], missed: ['D1', 'D2', 'D3'], total: 3 } });
    expect(running(fake.bin)).toEqual([]);
    expect(storeRows(p.db)).toMatchObject({ rounds: 0, legs: 0, occupants: 0 });
  });

  it('an answer with no verdict and no findings is not a review (exit 1, empty)', async () => {
    const fake = fakeClaude({ answer: 'NONCE: ${NONCE}\n\nI could not get to this one.' });
    const p = places();
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low', '--json'], fake, p);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.text)).toMatchObject({ ratified: false, status: 'FAIL', failure_class: 'empty', verdict: 'none' });
    expect(running(fake.bin)).toEqual([]);
  });

  it('a leg that fails ratification does not qualify (exit 1), and says which check failed', async () => {
    const fake = fakeClaude({ fixture: fixtureDir('claude', 'contaminated-used') });
    const p = places();
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low'], fake, p);
    expect(r.code).toBe(1);
    expect(r.lines[1]).toMatch(/^ratification {2}CONTAMINATED \(contaminated\); enforcement strong/);
    expect(r.text).toMatch(/ {2}failed {2}tools-used: /);
    expect(r.lines.at(-1)).toBe('not qualified: the leg did not ratify (recorded as a seat test; it never counts in stats)');
    expect(running(fake.bin)).toEqual([]);
    expect(storeRows(p.db).tests).toEqual([expect.objectContaining({ ratified: false, status: 'CONTAMINATED', failure_class: 'contaminated' })]);
  });

  it('a leg that writes into the root does not ratify', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS, writeIntoRoot: 'planted/calc/extra.py' });
    const p = places();
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low', '--json'], fake, p);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.text) as Record<string, unknown>;
    expect(json).toMatchObject({ ratified: false, status: 'CONTAMINATED', failure_class: 'contaminated', root_unchanged: false });
    expect(running(fake.bin)).toEqual([]);
  });

  it('kills a leg that hangs past its cap', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS, hangAfterInit: true });
    const p = places();
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low', '--timeout', '0.03'], fake, p);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain('capped at 0.03 min');
    expect(running(fake.bin)).toEqual([]);
    expect(storeRows(p.db).tests).toEqual([expect.objectContaining({ ratified: false })]);
  }, 60_000);

  it('tests a configured seat (or its fallback) by its id', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    writeFileSync(
      p.config,
      '[council]\nleg_timeout_minutes = 3\n\n[[seats]]\nid = "a"\nbackend = "codex"\nmodel = "gpt-6.1-sol"\nfallback = { backend = "claude", model = "claude-haiku-5-5", effort = "low", on = ["auth"] }\n\n[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "low"\n\n[[seats]]\nid = "c"\nbackend = "grok"\nmodel = "grok-4.7"\n',
    );
    const b = await run(['seats', 'test', 'b'], fake, p);
    expect(b.code).toBe(0);
    expect(b.lines[0]).toBe('seats test: about to run one paid leg: backend claude, model claude-sonnet-5-5, effort low (seat b, primary); capped at 3 min, on the planted-defect fixture (3 defects)');
    const af = await run(['seats', 'test', 'a', '--fallback'], fake, p);
    expect(af.code).toBe(0);
    expect(af.lines[0]).toContain('(seat a, fallback)');
    expect(storeRows(p.db).tests.map((t) => [t['seat'], t['role']])).toEqual([
      ['b', 'primary'],
      ['a', 'fallback'],
    ]);
    expect(running(fake.bin)).toEqual([]);
  });

  it('with --json, sends refusals and the record warning to stderr: stdout holds the JSON or nothing', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    const refused = await run(['seats', 'test', 'claude:claude-nope-1', '--json'], fake, p);
    expect([refused.code, refused.lines, refused.err]).toEqual([1, [], ['backend "claude" does not offer model "claude-nope-1"']]);
    mkdirSync(join(p.dir, 'data'));
    writeFileSync(p.db, 'not a database');
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low', '--json'], fake, p);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.text)).toMatchObject({ exit_code: 0, record_error: expect.stringContaining('could not record the seat test') });
    expect(r.err).toHaveLength(1);
    expect(running(fake.bin)).toEqual([]);
  });

  it('a setup failure prints a clear error, exits 1, launches and records nothing, and leaves no leg dir', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    // The roots path is a regular file: the work dir cannot be made.
    writeFileSync(p.roots, 'not a directory');
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low'], fake, p);
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toMatch(/^seats test: could not set up the seat test: .+; nothing was launched or recorded$/);
    expect(existsSync(join(fake.home, 'claude-argv.json'))).toBe(false);
    expect(existsSync(p.db)).toBe(false);
    expect(existsSync(join(p.dir, 'data', 'seat-tests'))).toBe(false);
    expect(running(fake.bin)).toEqual([]);
  });

  it('prints the paid result even when the store cannot take the record', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    mkdirSync(join(p.dir, 'data'));
    writeFileSync(p.db, 'not a database');
    const r = await run(['seats', 'test', 'claude:claude-haiku-5-5:low'], fake, p);
    expect(r.code).toBe(0);
    expect(r.text).toContain('defects       found 3 of 3');
    expect(r.lines.at(-1)).toMatch(/^warn {2}could not record the seat test in .*council\.db: /);
    expect(running(fake.bin)).toEqual([]);
  });

  it('reads a model id that holds a colon whole when the adapter lists it, and refuses a spec that reads two listed ways', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    // Only the whole id is listed: the whole rest is the model, at the CLI's default effort.
    const whole = await run(['seats', 'test', 'claude:claude-x:8b'], fake, p, ['claude-x:8b']);
    expect(whole.lines[0]).toBe(
      'seats test: about to run one paid leg: backend claude, model claude-x:8b, effort (the CLI default) (a candidate, not in the config); capped at 25 min, on the planted-defect fixture (3 defects)',
    );
    expect(storeRows(p.db).tests.at(-1)).toMatchObject({ occupant: { backend: 'claude', model: 'claude-x:8b', effort: null } });
    expect(running(fake.bin)).toEqual([]);
    // Both readings listed: refused, naming both, before anything launches.
    const argv = join(fake.home, 'claude-argv.json');
    const before = existsSync(argv) ? readFileSync(argv, 'utf8') : null;
    const both = await run(['seats', 'test', 'claude:claude-x:8b'], fake, p, ['claude-x:8b', 'claude-x']);
    expect(both.code).toBe(1);
    expect(both.lines).toEqual([
      '"claude:claude-x:8b" reads two ways and backend "claude" lists both: model "claude-x:8b" at the CLI\'s default effort, or model "claude-x" at effort "8b"; refusing to guess',
    ]);
    expect(existsSync(argv) ? readFileSync(argv, 'utf8') : null).toBe(before);
    // Neither listed.
    expect((await run(['seats', 'test', 'claude:claude-y:8b'], fake, p, ['claude-x'])).lines).toEqual(['backend "claude" offers neither model "claude-y:8b" nor model "claude-y" (with effort "8b")']);
  });

  it('refuses before launching anything: an unknown model, an unknown backend, an unknown seat, a seat with no fallback', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    const cases: Array<[string[], string]> = [
      [['claude:claude-nope-1'], 'backend "claude" does not offer model "claude-nope-1"'],
      [['gemini:x'], 'unknown backend "gemini"; expected one of: codex, claude, grok, antigravity, kiro, opencode, cursor, muse'],
      [['claude:'], '"claude:" is not backend:model[:effort]'],
      [['b'], `no config file at ${p.config}: name the candidate as backend:model[:effort] instead`],
      [['claude:claude-haiku-5-5', '--auth-home', '/x'], '--auth-home applies only to kiro and grok'],
    ];
    for (const [args, message] of cases) {
      const r = await run(['seats', 'test', ...args], fake, p);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.lines, args.join(' ')).toEqual([message]);
    }
    writeFileSync(p.config, '[[seats]]\nid = "a"\nbackend = "codex"\nmodel = "gpt-6.1-sol"\n\n[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-haiku-5-5"\n\n[[seats]]\nid = "c"\nbackend = "grok"\nmodel = "grok-4.7"\n');
    expect((await run(['seats', 'test', 'z'], fake, p)).lines).toEqual([`no seat "z" in ${p.config} (seats: a, b, c)`]);
    expect((await run(['seats', 'test', 'b', '--fallback'], fake, p)).lines).toEqual(['seat "b" has no fallback']);
    // Nothing launched: the fake never ran a leg, and no store was created.
    expect(existsSync(join(fake.home, 'claude-argv.json'))).toBe(false);
    expect(existsSync(p.db)).toBe(false);
  });
});

/**
 * An in-process adapter for the runner's own lines of defence, behind the adapter's: its poll never ends a leg by
 * itself (no supervisor cap), and its ratification passes whatever happened to the root.
 */
function stubAdapter(opts: { hang?: boolean; writeIntoRoot?: string }): { adapter: SeatAdapter; cancelled: () => number } {
  let cancels = 0;
  const pre: Preflight = { ok: true, backend: 'claude', cliVersion: '0.0.0', enforcement: 'strong', checks: [], userOwned: [], failureClass: null, reason: null, data: {} };
  const adapter: SeatAdapter = {
    id: 'claude',
    transport: 'headless',
    testedVersions: { floor: '0.0.0', tested: [] },
    enforcement: () => 'strong',
    listModels: async () => [{ id: 'stub', family: 'anthropic' }],
    preflight: async () => pre,
    launch: async (o: Occupant, ctx: RoundCtx): Promise<LegHandle> => {
      if (opts.writeIntoRoot !== undefined) writeFileSync(join(ctx.root, opts.writeIntoRoot), 'written by a leg\n');
      return { backend: 'claude', occupant: o, legDir: ctx.legDir, root: ctx.root, nonce: ctx.nonce, startedAt: new Date(), process: null, exit: null, files: {}, data: { nonce: ctx.nonce } };
    },
    poll: async () => (opts.hang === true && cancels === 0 ? { status: 'running' } : { status: 'done', doneBy: 'record', exit: null }),
    collect: async (h: LegHandle) => ({ text: `NONCE: ${String(h.data['nonce'])}\n\n\`\`\`findings\nnone\n\`\`\`\n\nVERDICT: SHIP`, fromNonce: true, source: 'stub' }),
    ratify: async (): Promise<Ratification> => ({
      status: opts.hang === true ? 'FAIL' : 'PASS',
      ok: opts.hang !== true,
      failureClass: opts.hang === true ? 'timeout' : null,
      checks: [{ name: 'stub', ok: opts.hang !== true, detail: 'stub' }],
      enforcement: 'strong',
      recordPath: null,
      sessionId: null,
      cliVersion: '0.0.0',
      modelObserved: 'stub',
      effortObserved: null,
      cwdObserved: null,
      cwdOk: true,
      toolsOffered: [],
      toolsUsed: [],
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      credits: null,
      quotaUsedPct: null,
      quotaNote: null,
      durationMs: 1,
      nonceSeen: true,
      rootMutated: null,
      detail: {},
    }),
    classify: () => null,
    cancel: async () => {
      cancels += 1;
    },
  };
  return { adapter, cancelled: () => cancels };
}

describe('seats test: cancellation and setup failures', () => {
  /** The fake claude adapter, with its preflight followed by `after` (a Ctrl-C arriving during preflight). */
  function withPreflightHook(fake: Fake, after: () => void): SeatAdapters {
    const inner = fake.adapters('claude') as SeatAdapter;
    const wrapped = new Proxy(inner, {
      get(target, key, receiver) {
        if (key === 'preflight') {
          return async (o: Occupant, ctx: RoundCtx): Promise<Preflight> => {
            const pre = await target.preflight(o, ctx);
            after();
            return pre;
          };
        }
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    return (b) => (b === 'claude' ? wrapped : undefined);
  }

  it('an abort before the launch starts nothing (the fake CLI is never run) and leaves no leg dir', async () => {
    const fake = fakeClaude({ answer: ALL_DEFECTS });
    const p = places();
    const options = (signal: AbortSignal, adapters: SeatAdapters) => ({ adapters, rootsDir: p.roots, dataDir: join(p.dir, 'data'), timeoutMs: 60_000, pollMs: 20, env: fake.env, signal });
    const occupant: Occupant = { backend: 'claude', model: 'claude-haiku-5-5', effort: 'low' };
    // Already aborted: nothing is set up.
    const before = new AbortController();
    before.abort();
    await expect(runSeatTest(occupant, { seat: null, role: null }, options(before.signal, fake.adapters))).rejects.toMatchObject({ name: 'SeatTestNotRun', why: 'cancelled' });
    // Aborted during preflight: the preflight ran (no model call), the paid launch did not.
    const during = new AbortController();
    await expect(runSeatTest(occupant, { seat: null, role: null }, options(during.signal, withPreflightHook(fake, () => during.abort())))).rejects.toThrow(
      'cancelled before the leg launched: nothing ran',
    );
    expect(existsSync(join(fake.home, 'claude-argv.json'))).toBe(false);
    expect(existsSync(join(p.dir, 'data', 'seat-tests')) ? readdirSync(join(p.dir, 'data', 'seat-tests')) : []).toEqual([]);
    expect(readdirSync(p.roots)).toEqual([]);
    expect(running(fake.bin)).toEqual([]);
  });

  it('cancels at once a launch that returns after an abort', async () => {
    const p = places();
    const stub = stubAdapter({});
    const events: string[] = [];
    const ac = new AbortController();
    const adapter = new Proxy(stub.adapter, {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver) as unknown;
        if (key === 'launch' || key === 'cancel' || key === 'poll') {
          return async (...a: unknown[]) => {
            events.push(String(key));
            const out = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
            if (key === 'launch') ac.abort(); // the abort lands while the launch is in flight
            return out;
          };
        }
        return v;
      },
    });
    await runSeatTest({ backend: 'claude', model: 'stub' }, { seat: null, role: null }, { adapters: () => adapter, rootsDir: p.roots, dataDir: join(p.dir, 'data'), timeoutMs: 5_000, pollMs: 20, signal: ac.signal });
    expect(events.slice(0, 2)).toEqual(['launch', 'cancel']);
  });

  it('a fixture whose root cannot be built is a setup failure, and its leg dir is removed', async () => {
    const p = places();
    const fixture = { ...loadFixture(), repo: '_base' }; // a reserved root name: the root build refuses it
    await expect(
      runSeatTest({ backend: 'claude', model: 'stub' }, { seat: null, role: null }, { adapters: () => stubAdapter({}).adapter, rootsDir: p.roots, dataDir: join(p.dir, 'data'), timeoutMs: 5_000, pollMs: 20, fixture }),
    ).rejects.toMatchObject({ name: 'SeatTestNotRun', why: 'setup', message: expect.stringMatching(/^could not build the fixture's repository and root: /) });
    expect(readdirSync(join(p.dir, 'data', 'seat-tests'))).toEqual([]);
    expect(readdirSync(p.roots)).toEqual([]);
  });
});

describe('seats test: the runner behind the adapter', () => {
  it('cancels a leg the adapter never ends, once its cap and grace pass', async () => {
    const p = places();
    const stub = stubAdapter({ hang: true });
    const r = await runSeatTest({ backend: 'claude', model: 'stub' }, { seat: null, role: null }, {
      adapters: () => stub.adapter,
      rootsDir: p.roots,
      dataDir: join(p.dir, 'data'),
      timeoutMs: 200,
      capGraceMs: 100,
      pollMs: 20,
    });
    expect(stub.cancelled()).toBeGreaterThanOrEqual(1);
    expect(r).toMatchObject({ ratified: false, status: 'FAIL', failure_class: 'timeout' });
  }, 10_000);

  it('fails a leg whose root changed even when the adapter ratified it (the residue sweep)', async () => {
    const p = places();
    const stub = stubAdapter({ writeIntoRoot: 'planted/calc/extra.py' });
    const r = await runSeatTest({ backend: 'claude', model: 'stub' }, { seat: null, role: null }, {
      adapters: () => stub.adapter,
      rootsDir: p.roots,
      dataDir: join(p.dir, 'data'),
      timeoutMs: 5_000,
      pollMs: 20,
    });
    expect(r).toMatchObject({ ratified: false, status: 'CONTAMINATED', failure_class: 'contaminated', root_unchanged: false });
    expect(r.failed_checks.at(-1)).toMatch(/^residue: /);
    // The same stub with an untouched root ratifies: the sweep alone failed it.
    const clean = await runSeatTest({ backend: 'claude', model: 'stub' }, { seat: null, role: null }, { adapters: () => stubAdapter({}).adapter, rootsDir: p.roots, dataDir: join(p.dir, 'data'), timeoutMs: 5_000, pollMs: 20 });
    expect(clean).toMatchObject({ ratified: true, status: 'PASS', verdict: 'SHIP' });
  });
});
