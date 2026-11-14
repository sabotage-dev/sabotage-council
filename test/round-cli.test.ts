import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findingIdOf } from '../src/adjudicate/index.js';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import { layoutOf, renderSummary, type StorePaths } from '../src/cli/round.js';
import { runnerFile, runWorker, type RoundSummary } from '../src/engine/index.js';
import { openStore } from '../src/store/index.js';
import { fakeRegistry } from './fake-registry.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { git } from './helpers/git-fixture.js';
import { fakeAdapters, fakeHome, fixtureRepo, ROSTER_TOML } from './helpers/round.js';

cleanScratchAfterAll();

const REGISTRY = fakeRegistry({
  codex: [{ id: 'gpt-6.1-sol', family: 'openai' }],
  claude: [
    { id: 'claude-sonnet-5-5', family: 'anthropic' },
    { id: 'claude-haiku-5-5', family: 'anthropic' },
    { id: 'claude-opus-5-5', family: 'anthropic' },
  ],
});

interface Cli {
  run: (...args: string[]) => Promise<{ code: number; lines: string[] }>;
  paths: StorePaths;
  workers: Array<Promise<unknown>>;
}

/** The real CLI program, with the fake CLIs' adapters and an in-process worker in place of the detached one. */
function cli(cwd: string, startWorker?: ProgramIo['startWorker']): Cli {
  const dir = scratch('sc-cli-');
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, ROSTER_TOML);
  const paths: StorePaths = { configPath, dbPath: join(dir, 'data', 'council.db'), rootsPath: join(dir, 'roots') };
  const { env } = fakeHome({});
  const workers: Array<Promise<unknown>> = [];
  const inProcess = (roundId: number, p: StorePaths): void => {
    const store = openStore(p.dbPath);
    workers.push(runWorker(store, layoutOf(p), roundId, { adapters: fakeAdapters, env, pollMs: 20, legTimeoutMs: 20_000 }).finally(() => store.close()));
  };
  const run = async (...args: string[]): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    let code = 0;
    const io: ProgramIo = {
      write: (l) => lines.push(l),
      env: { HOME: dir },
      setExitCode: (c) => (code = c),
      adapters: fakeAdapters,
      registry: REGISTRY,
      cwd,
      startWorker: startWorker ?? inProcess,
      waitPollMs: 20,
    };
    await buildProgram(io).exitOverride().parseAsync(['node', 'sabotage-council', ...args, '--config', paths.configPath, '--db', paths.dbPath, '--roots', paths.rootsPath]);
    return { code, lines };
  };
  return { run, paths, workers };
}

describe('CLI: round start / wait / show and adjudicate', () => {
  it('starts a diff round, waits for it, shows it, and stores an adjudication', async () => {
    const { repo } = fixtureRepo();
    const c = cli(repo);
    const started = await c.run('round', 'start', 'diff', 'main..feature', '--json');
    expect(started.code).toBe(0);
    const start = JSON.parse(started.lines.at(-1)!) as { round_id: number; round_no: number; rule: string; scope: string; target: string; next: string };
    expect(start).toMatchObject({ round_no: 1, rule: 'round-1', scope: 'full', target: 'widget@feature' });
    expect(start.next).toBe(`sabotage-council round wait ${start.round_id}`);

    const waited = await c.run('round', 'wait', String(start.round_id));
    expect(waited.code).toBe(0);
    const summary = JSON.parse(waited.lines.join('\n')) as RoundSummary;
    expect(summary).toMatchObject({ status: 'awaiting-adjudication', quorum: { label: 'council', ratified: 3 } });
    expect(summary.legs.map((l) => [l.seat, l.status, l.verdict_raw, l.findings.length])).toEqual([
      ['a', 'PASS', 'SHIP-WITH-FIXES', 0],
      ['b', 'PASS', 'NEEDS-WORK', 1],
      ['c', 'PASS', 'NEEDS-WORK', 1],
    ]);
    expect(summary.legs[0]!.ratification?.failed_checks).toEqual([]);

    const shown = await c.run('round', 'show', String(start.round_id));
    expect(shown.lines[0]).toBe(`round ${start.round_id}: diff widget@feature, round 1 (rule round-1, full review)`);
    expect(shown.lines).toContain('quorum council: 3 ratified legs: a council round');

    // A bad adjudication is rejected with its class, and nothing is stored.
    const file = join(scratch('sc-adj-'), 'ADJUDICATION.json');
    const id = findingIdOf(summary.target_key, 'widget/calc/rangesum.py', 'range_sum excludes the end index');
    const adjudication = {
      nonce: summary.nonce,
      head_sha: summary.head_sha,
      round: 1,
      verdict: 'NEEDS-WORK',
      approve: false,
      needs_ruling: false,
      reason: 'the loop drops the end element',
      findings: [
        {
          id,
          title: 'range_sum excludes the end index',
          path: 'widget/calc/rangesum.py',
          line: 3,
          severity: 'HIGH',
          outcome: 'owed',
          owner: 'this',
          proof: 'widget/calc/rangesum.py:3 range(start, end)',
          kind: 'finding',
          raised_by: [
            { seat: 'a', leg_finding: 'X1', severity: 'MEDIUM' },
            { seat: 'b', leg_finding: 'F1', severity: 'HIGH' },
            { seat: 'c', leg_finding: 'F1', severity: 'HIGH' },
          ],
          same_as: null,
          closes_item: null,
        },
      ],
      unmapped: [],
      earlier_items: [],
      human_asks: [],
      leg_verdicts: [
        { seat: 'a', raw: 'SHIP-WITH-FIXES', effective: 'SHIP-WITH-FIXES' },
        { seat: 'b', raw: 'NEEDS-WORK', effective: 'NEEDS-WORK' },
        { seat: 'c', raw: 'NEEDS-WORK', effective: 'NEEDS-WORK' },
      ],
      not_verified: [],
      followups: [],
      summary: 'One owed defect.',
      blocker_call: 'Fix the loop bound.',
    };
    writeFileSync(file, JSON.stringify({ ...adjudication, verdict: 'SHIP' }));
    const rejected = await c.run('adjudicate', String(start.round_id), file);
    expect(rejected.code).toBe(1);
    expect(rejected.lines[0]).toBe('rejected: 1 problem(s); nothing was stored');
    expect(rejected.lines[1]).toBe('  [verdict] SHIP with 1 owed row(s)');

    writeFileSync(file, JSON.stringify(adjudication));
    // --check validates and stores nothing.
    const checked = await c.run('adjudicate', String(start.round_id), file, '--check');
    expect(checked.code).toBe(0);
    expect(checked.lines[0]).toBe(`check passed (nothing stored): would store round ${start.round_id} verdict NEEDS-WORK, owed 1, approve no, needs ruling no`);
    const still = await c.run('round', 'show', String(start.round_id), '--json');
    expect(JSON.parse(still.lines.join('\n'))).toMatchObject({ status: 'awaiting-adjudication', adjudication: null });
    const stored = await c.run('adjudicate', String(start.round_id), file);
    expect(stored.code).toBe(0);
    expect(stored.lines[0]).toBe(`stored: round ${start.round_id} verdict NEEDS-WORK, owed 1, approve no, needs ruling no`);
    expect(stored.lines[1]).toBe('legs clear: no; leg verdicts: a SHIP-WITH-FIXES, b NEEDS-WORK, c NEEDS-WORK');

    const again = await c.run('adjudicate', String(start.round_id), file);
    expect(again.code).toBe(1);
    expect(again.lines[0]).toContain('is adjudicated; only a round awaiting adjudication can be adjudicated');

    const after = await c.run('round', 'show', String(start.round_id), '--json');
    expect(JSON.parse(after.lines.join('\n'))).toMatchObject({ status: 'adjudicated', adjudication: { verdict: 'NEEDS-WORK', owed: 1, approve: false } });
  }, 60_000);

  it('starts a plan round from a file and prints the bare id', async () => {
    const { repo } = fixtureRepo();
    const c = cli(join(repo, 'docs'));
    const started = await c.run('round', 'start', 'plan', 'PLAN.md', '--fact', 'the module has no callers yet');
    // Config warnings come first; the round id is the last line.
    expect(started.lines.at(-1)).toBe('1');
    expect(started.lines.slice(0, -1).every((l) => l.startsWith('warn  '))).toBe(true);
    await Promise.all(c.workers);
    const brief = readFileSync(join(layoutOf(c.paths).roundsDir, '1', 'BRIEF.md'), 'utf8');
    expect(brief).toContain('TARGET: docs/PLAN.md');
    expect(brief).toContain('- the module has no callers yet');
  }, 60_000);

  it('warns when a diff target is keyed by a commit, and --series names the series instead', async () => {
    const { repo } = fixtureRepo();
    const c = cli(repo, () => undefined);
    const sha = git(repo, ['rev-parse', 'feature']);
    const bySha = await c.run('round', 'start', 'diff', `main..${sha}`, '--json');
    expect(bySha.code).toBe(0);
    expect(bySha.lines.filter((l) => l.includes('a later commit starts a new series'))).toHaveLength(1);
    expect(bySha.lines.find((l) => l.includes('new series'))?.startsWith('warn  ')).toBe(true);
    expect((JSON.parse(bySha.lines.at(-1)!) as { target: string }).target).toBe(`widget@commit:${sha.slice(0, 12)}`);
    const named = await c.run('round', 'start', 'diff', `main..${sha}`, '--series', 'range-fix', '--json');
    expect(named.code).toBe(0);
    expect(named.lines.join('\n')).not.toContain('new series');
    expect((JSON.parse(named.lines.at(-1)!) as { target: string }).target).toBe('widget@series:range-fix');
    const bad = await c.run('round', 'start', 'diff', '--series', 'two words');
    expect(bad.code).toBe(1);
    expect(bad.lines.at(-1)).toContain('--series "two words" must be');
  });

  it('refuses a config the registry rejects, and an unknown model never starts a round', async () => {
    const { repo } = fixtureRepo();
    const c = cli(repo);
    writeFileSync(c.paths.configPath, ROSTER_TOML.replace('claude-opus-5-5', 'claude-nonexistent-1'));
    const r = await c.run('round', 'start', 'diff', 'main..feature');
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('does not offer model "claude-nonexistent-1"');
  });

  it('round wait times out with exit 3 while the round runs, and fails a round whose worker died', async () => {
    const { repo } = fixtureRepo();
    const noWorker = (): void => undefined;
    const c = cli(repo, noWorker);
    const started = await c.run('round', 'start', 'diff', 'main..feature');
    const id = started.lines.at(-1)!;
    const waiting = await c.run('round', 'wait', id, '--timeout', '0.001');
    expect(waiting.code).toBe(3);
    expect(JSON.parse(waiting.lines.join('\n'))).toMatchObject({ status: 'running', quorum: { label: 'pending', note: 'running: 0 leg(s) ratified so far' } });
    // A worker record whose process is gone: the round fails visibly.
    writeFileSync(runnerFile(join(layoutOf(c.paths).roundsDir, id)), JSON.stringify({ pid: 2 ** 22 + 12345, started_at: new Date().toISOString() }));
    const dead = await c.run('round', 'wait', id);
    expect(dead.code).toBe(1);
    const summary = JSON.parse(dead.lines.join('\n')) as RoundSummary;
    expect(summary.status).toBe('failed');
    expect(summary.events.find((e) => e.kind === 'round-failed')?.detail).toMatchObject({ stage: 'worker-died' });
  }, 60_000);

  it('renders a solo round with its label', () => {
    const lines = renderSummary({
      round_id: 7,
      round_no: 2,
      mode: 'plan',
      target: 'docs/PLAN.md',
      target_key: 'plan:x:docs/PLAN.md',
      head_sha: 'a'.repeat(40),
      base_sha: null,
      baseline_sha: 'b'.repeat(40),
      scope: 'delta',
      full_round_reason: null,
      rule: 'serious',
      nonce: '0123456789ab',
      snapshot: null,
      status: 'awaiting-adjudication',
      quorum: { label: 'solo', ratified: 1, seats: 3, note: 'SOLO REVIEW: one ratified leg. This is not a council verdict, and it never approves (plan 3.1 step 8).' },
      round_dir: '/r',
      root: '/root',
      brief_path: '/r/BRIEF.md',
      earlier_items: [],
      legs: [
        {
          leg_id: 1, seat: 'a', role: 'primary', attempt: 1, backend: 'codex', model: 'm', effort: 'high', transport: 'headless',
          status: 'CONTAMINATED', counted: false, failure_class: 'contaminated', enforcement: null, cli_version: null,
          verdict_raw: null, verdict_reason: null, verdict_effective: null, findings: [], findings_extracted_by: null,
          findings_problem: null, answer_path: null, leg_dir: '/r/legs/a-primary-1',
          ratification: {
            status: 'CONTAMINATED',
            failed_checks: [{ name: 'write-denial', detail: `line one\n  line two ${'x'.repeat(300)}` }],
            notes: ['leg t1: denial text in a command output (a note: the commands, records and root-unchanged checks decide): Permission denied'],
            model_observed: null,
            effort_observed: null,
            session_id: null,
            record_path: null,
          },
          started_at: null, finished_at: null, duration_ms: null, tokens_in: null, tokens_out: null, cost_usd: null, credits: null,
        },
      ],
      adjudication: null,
      held: null,
      adjudicator: null,
      started_at: '2026-01-01T00:00:00.000Z',
      finished_at: null,
      settled_at: '2026-01-01T00:01:00.000Z',
      wall_ms: 60_000,
      cost: { usd: 0, credits: 0, legs_with_cost: 0 },
      events: [],
    });
    expect(lines).toContain('quorum solo: SOLO REVIEW: one ratified leg. This is not a council verdict, and it never approves (plan 3.1 step 8).');
    const failed = lines.find((l) => l.includes('failed write-denial'))!;
    expect(failed.startsWith('        failed write-denial: line one line two xxx')).toBe(true);
    expect(failed.endsWith('...')).toBe(true);
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    expect(lines).toContain('        note leg t1: denial text in a command output (a note: the commands, records and root-unchanged checks decide): Permission denied');
  });
});

describe('CLI: fold row 13, the worker hand-off', () => {
  it('hands the worker absolute paths, even from relative flags', async () => {
    const { repo } = fixtureRepo();
    writeFileSync(join(repo, '..', 'config.toml'), ROSTER_TOML);
    const seen: StorePaths[] = [];
    const lines: string[] = [];
    const io: ProgramIo = { write: (l) => lines.push(l), env: { HOME: repo }, setExitCode: () => undefined, adapters: fakeAdapters, registry: REGISTRY, cwd: repo, startWorker: (_id, p) => void seen.push(p) };
    await buildProgram(io).exitOverride().parseAsync(['node', 'sc', 'round', 'start', 'diff', 'main..feature', '--config', '../config.toml', '--db', 'data/council.db', '--roots', 'roots']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ configPath: join(repo, '..', 'config.toml'), dbPath: join(repo, 'data', 'council.db'), rootsPath: join(repo, 'roots') });
  });

  it('fails the round, removes its root and names it when the worker cannot start', async () => {
    const { repo } = fixtureRepo();
    const c = cli(repo, () => {
      throw new Error('spawn failed');
    });
    const r = await c.run('round', 'start', 'diff', 'main..feature');
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toBe('error: round 1 failed: its worker did not start (spawn failed)');
    const shown = await c.run('round', 'show', '1', '--json');
    const summary = JSON.parse(shown.lines.join('\n')) as RoundSummary;
    expect(summary.status).toBe('failed');
    expect(summary.events.find((e) => e.kind === 'round-failed')?.detail).toMatchObject({ stage: 'worker-start' });
    expect(existsSync(summary.root)).toBe(false);
  });
});
