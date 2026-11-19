import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SeatAdapters } from '../src/adapters/index.js';
import type { LegHandle, Occupant, Preflight, Ratification, RoundCtx, SeatAdapter } from '../src/adapters/types.js';
import { runDoctor } from '../src/cli/doctor.js';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import { parseConfigText, type ValidationResult } from '../src/config/index.js';
import { distinctOccupants, legEngine } from '../src/engine/run.js';
import { OCCUPANT_KEYS, preservingEditor } from '../src/seats/edit.js';
import { recordSeatTest, runSeatTest } from '../src/seats/run.js';
import { loadStats } from '../src/stats/data.js';
import { buildReport, evidenceOf, thresholdsOf } from '../src/stats/report.js';
import { recommendationLines, renderText } from '../src/stats/text.js';
import { insertEvent } from '../src/engine/records.js';
import { openStore } from '../src/store/index.js';
import { fakeRegistry } from './fake-registry.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';

cleanScratchAfterAll();

/*
 * P11 item 1: `engine` on kiro seats and fallbacks (default v3, a config error elsewhere), on `seats swap/add/test`
 * (`--engine`), in the occupant keys the editor replaces and in doctor's per-seat lines; not part of the occupant's
 * identity (Q15); recorded on every leg (the legs-settled event, `stats` evidence rows, `seats test --json`).
 */

const PLAN_EXAMPLE = readFileSync(new URL('./fixtures/config/plan-example.toml', import.meta.url), 'utf8');

const SEATS = (a: string, b = '', c = '') => `[[seats]]
id = "a"
backend = "kiro"
model = "gpt-5.6-sol"
effort = "high"
${a}
[[seats]]
id = "b"
backend = "claude"
model = "claude-sonnet-5-5"
effort = "high"
${b}
[[seats]]
id = "c"
backend = "grok"
model = "grok-4.7"
effort = "high"
${c}`;

const errorsOf = (r: ValidationResult): string[] => (r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`));

describe('config: engine on kiro seats and fallbacks', () => {
  it('takes v3 or v2 on a kiro seat; unset stays unset (the adapter runs v3)', async () => {
    for (const engine of ['v3', 'v2']) {
      const r = await parseConfigText(SEATS(`engine = "${engine}"`), { registry: fakeRegistry() });
      expect(errorsOf(r)).toEqual([]);
      if (r.ok) expect(r.config.seats[0]?.engine).toBe(engine);
    }
    const unset = await parseConfigText(SEATS(''), { registry: fakeRegistry() });
    if (unset.ok) expect(unset.config.seats[0]?.engine).toBeUndefined();
  });

  it('takes engine on a kiro fallback', async () => {
    const r = await parseConfigText(PLAN_EXAMPLE.replace('effort = "high", on = ["usage_limit", "auth"] }', 'effort = "high", engine = "v2", on = ["usage_limit", "auth"] }'), { registry: fakeRegistry() });
    expect(errorsOf(r)).toEqual([]);
    if (r.ok) expect(r.config.seats[0]?.fallback?.engine).toBe('v2');
  });

  it('is a config error on any other backend, seat or fallback, and for any other value', async () => {
    expect(errorsOf(await parseConfigText(SEATS('', 'engine = "v3"'), { registry: fakeRegistry() }))).toEqual(['seats[1].engine: engine applies only to kiro seats and fallbacks (seat "b" is claude)']);
    const fallback = await parseConfigText(SEATS('', 'fallback = { backend = "codex", model = "gpt-6.1-sol", engine = "v2", on = ["auth"] }'), { registry: fakeRegistry() });
    expect(errorsOf(fallback)).toEqual(['seats[1].fallback.engine: engine applies only to kiro seats and fallbacks (this fallback is codex)']);
    const bad = errorsOf(await parseConfigText(SEATS('engine = "v1"'), { registry: fakeRegistry() }));
    expect(bad.join('\n')).toContain('engine is "v3" or "v2" (kiro only)');
  });

  it('is not part of the occupant identity (Q15): two kiro seats on one model with two engines are one occupant', async () => {
    const twice = `${SEATS('engine = "v3"')}`.replace('id = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"', 'id = "b"\nbackend = "kiro"\nmodel = "gpt-5.6-sol"\nengine = "v2"');
    expect(errorsOf(await parseConfigText(twice, { registry: fakeRegistry() })).join('\n')).toContain('is the same occupant as seat "a"');
    const leg = (engine: 'v2' | 'v3' | undefined) => ({ status: 'PASS' as const, occupant: { backend: 'kiro' as const, model: 'm', engine } });
    expect(distinctOccupants([leg('v3'), leg('v2')]).duplicates).toHaveLength(1);
  });

  it('the engine a leg records: v3 when unset, null for other backends', () => {
    expect(legEngine({ backend: 'kiro', model: 'm' })).toBe('v3');
    expect(legEngine({ backend: 'kiro', model: 'm', engine: 'v2' })).toBe('v2');
    expect(legEngine({ backend: 'claude', model: 'm' })).toBeNull();
    expect(legEngine(undefined)).toBeNull();
  });
});

describe('seats swap/add: engine is an occupant key the editor replaces', () => {
  const CONFIG = SEATS('engine = "v2"\nauth_home = "/kiro/home"');
  it('swap writes the new engine, and drops it when the new occupant sets none', () => {
    expect(OCCUPANT_KEYS).toEqual(['backend', 'model', 'effort', 'sandbox', 'engine', 'auth_home']);
    const toV3 = preservingEditor.edit(CONFIG, { kind: 'swap', seat: 'a', occupant: { backend: 'kiro', model: 'gpt-5.6-sol', effort: 'high', engine: 'v3' } });
    expect(toV3).toContain('id = "a"\nbackend = "kiro"\nmodel = "gpt-5.6-sol"\neffort = "high"\nengine = "v3"\n');
    expect(toV3).not.toContain('auth_home');
    const toCodex = preservingEditor.edit(CONFIG, { kind: 'swap', seat: 'a', occupant: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' } });
    expect(toCodex).not.toContain('engine');
  });
  it('add writes engine in the occupant key order', () => {
    const two = SEATS('').split('[[seats]]\nid = "c"')[0] ?? '';
    const out = preservingEditor.edit(two, { kind: 'add', seat: 'c', occupant: { backend: 'kiro', model: 'claude-sonnet-5.5', effort: 'high', engine: 'v2', auth_home: '/h' } });
    expect(out).toContain('[[seats]]\nid = "c"\nbackend = "kiro"\nmodel = "claude-sonnet-5.5"\neffort = "high"\nengine = "v2"\nauth_home = "/h"\n');
  });
});

/** A stub kiro adapter that records the occupant each call saw. */
function kiroStub(seen: Occupant[]): SeatAdapter {
  const pre: Preflight = { ok: true, backend: 'kiro', cliVersion: '3.5.0', enforcement: 'pending', checks: [], userOwned: [], failureClass: null, reason: null, data: {} };
  return {
    id: 'kiro',
    transport: 'acp',
    testedVersions: { floor: '3.2.1', tested: ['3.5.0'] },
    enforcement: () => 'pending',
    listModels: async () => [{ id: 'gpt-5.6-sol', family: 'openai' }],
    preflight: async (o: Occupant) => {
      seen.push({ ...o });
      return pre;
    },
    launch: async (o: Occupant, ctx: RoundCtx): Promise<LegHandle> => ({ backend: 'kiro', occupant: o, legDir: ctx.legDir, root: ctx.root, nonce: ctx.nonce, startedAt: new Date(), process: null, exit: null, files: {}, data: { nonce: ctx.nonce } }),
    poll: async () => ({ status: 'done', doneBy: 'record', exit: null }),
    collect: async (h: LegHandle) => ({ text: `NONCE: ${String(h.data['nonce'])}\n\n\`\`\`findings\nnone\n\`\`\`\n\nVERDICT: SHIP`, fromNonce: true, source: 'stub' }),
    ratify: async (h: LegHandle): Promise<Ratification> => ({
      status: 'PASS',
      ok: true,
      failureClass: null,
      checks: [],
      enforcement: 'pending',
      recordPath: null,
      sessionId: null,
      cliVersion: '3.5.0',
      modelObserved: 'gpt-5.6-sol',
      effortObserved: null,
      cwdObserved: null,
      cwdOk: true,
      toolsOffered: [],
      toolsUsed: [],
      tokensIn: null,
      tokensOut: null,
      costUsd: null,
      credits: 0.1,
      quotaUsedPct: null,
      quotaNote: null,
      durationMs: 1,
      nonceSeen: true,
      rootMutated: null,
      detail: { engine: h.occupant.engine ?? 'v3' },
    }),
    classify: () => null,
    cancel: async () => undefined,
  };
}

async function cli(args: string[], adapters: SeatAdapters, paths: { config: string; db: string; roots: string }): Promise<{ code: number; lines: string[]; err: string[] }> {
  const lines: string[] = [];
  const err: string[] = [];
  let code = -1;
  const io: ProgramIo = {
    write: (l) => lines.push(l),
    writeErr: (l) => err.push(l),
    env: { PATH: process.env['PATH'] },
    setExitCode: (c) => (code = c),
    adapters,
    registry: fakeRegistry(),
    seatTestPollMs: 20,
  };
  const program = buildProgram(io);
  for (const c of [program, ...program.commands, ...program.commands.flatMap((c) => c.commands)]) c.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  try {
    await program.parseAsync(['node', 'sabotage-council', ...args, '--config', paths.config, '--db', paths.db, '--roots', paths.roots]);
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
  }
  return { code, lines, err };
}

function places(): { config: string; db: string; roots: string; dir: string } {
  const dir = scratch('sc-kiro-engine-');
  return { dir, config: join(dir, 'config.toml'), db: join(dir, 'data', 'council.db'), roots: join(dir, 'roots') };
}

describe('seats test --engine, and the engine in its JSON', () => {
  it('a candidate runs on the engine named; the JSON and the seat-test record carry it; unset is v3', async () => {
    const p = places();
    const seen: Occupant[] = [];
    const adapters: SeatAdapters = (b) => (b === 'kiro' ? kiroStub(seen) : undefined);
    const v2 = await cli(['seats', 'test', 'kiro:gpt-5.6-sol', '--engine', 'v2', '--json'], adapters, p);
    expect(seen.at(-1)?.engine).toBe('v2');
    expect((JSON.parse(v2.lines.join('\n')) as { occupant: { engine: string } }).occupant.engine).toBe('v2');
    expect(v2.err.join('\n')).toContain(', engine v2');
    const unset = await cli(['seats', 'test', 'kiro:gpt-5.6-sol', '--json'], adapters, p);
    expect(seen.at(-1)?.engine).toBeUndefined();
    expect((JSON.parse(unset.lines.join('\n')) as { occupant: { engine: string } }).occupant.engine).toBe('v3');
    const store = openStore(p.db);
    try {
      const events = (store.db.prepare("SELECT detail_json FROM events WHERE kind = 'seat-test' ORDER BY id").all() as Array<{ detail_json: string }>).map((r) => JSON.parse(r.detail_json) as { engine: string });
      expect(events.map((e) => e.engine)).toEqual(['v2', 'v3']);
      const lines = renderText(buildReport(loadStats(store.db, null), thresholdsOf({ swap_min_ratified_rounds: 20, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'defaults'), { seat: null, occupant: null }));
      expect(lines.join('\n')).toContain('kiro:gpt-5.6-sol (kiro engine v2)');
    } finally {
      store.close();
    }
  });

  it('a seat id takes --engine for a kiro seat (overrides its own), and refuses it on another backend', async () => {
    const p = places();
    writeFileSync(p.config, SEATS('engine = "v3"'));
    const seen: Occupant[] = [];
    const adapters: SeatAdapters = (b) => (b === 'kiro' ? kiroStub(seen) : undefined);
    await cli(['seats', 'test', 'a', '--engine', 'v2', '--json'], adapters, p);
    expect(seen.at(-1)?.engine).toBe('v2');
    await cli(['seats', 'test', 'a', '--json'], adapters, p);
    expect(seen.at(-1)?.engine).toBe('v3');
    const refused = await cli(['seats', 'test', 'b', '--engine', 'v2'], adapters, p);
    expect(refused.code).toBe(1);
    expect(refused.lines).toEqual(['--engine applies only to kiro (seat "b" is claude)']);
    const candidate = await cli(['seats', 'test', 'claude:claude-sonnet-5-5', '--engine', 'v2'], adapters, p);
    expect(candidate.lines).toEqual(['--engine applies only to kiro']);
    const bad = await cli(['seats', 'test', 'a', '--engine', 'v1'], adapters, p);
    expect(bad.err.join('\n')).toContain('--engine is v3 or v2 (kiro only)');
  });

  it('seats swap --engine writes it; on another backend the config loader refuses the edit', async () => {
    const p = places();
    writeFileSync(p.config, SEATS(''));
    const adapters: SeatAdapters = () => undefined;
    const ok = await cli(['seats', 'swap', 'a', '--backend', 'kiro', '--model', 'gpt-5.6-sol', '--effort', 'high', '--engine', 'v2'], adapters, p);
    expect(ok.code).toBe(0);
    expect(readFileSync(p.config, 'utf8')).toContain('engine = "v2"');
    const refused = await cli(['seats', 'swap', 'b', '--backend', 'claude', '--model', 'claude-sonnet-5-5', '--engine', 'v2'], adapters, p);
    expect(refused.code).toBe(1);
    expect(refused.lines.join('\n')).toContain('engine applies only to kiro seats and fallbacks');
  });

  it('runSeatTest records the engine on its result', async () => {
    const p = places();
    const seen: Occupant[] = [];
    const r = await runSeatTest({ backend: 'kiro', model: 'gpt-5.6-sol', engine: 'v2' }, { seat: null, role: null }, { adapters: () => kiroStub(seen), rootsDir: p.roots, dataDir: join(p.dir, 'data'), timeoutMs: 5000, pollMs: 20 });
    expect(r.occupant.engine).toBe('v2');
    mkdirSync(join(p.dir, 'data'), { recursive: true });
    const store = openStore(p.db);
    try {
      recordSeatTest(store, r);
      expect(loadStats(store.db, null).seatTests[0]?.engine).toBe('v2');
    } finally {
      store.close();
    }
  });
});

describe("doctor's per-seat line and the stats evidence rows", () => {
  it('doctor names each kiro seat engine: the default v3, or engine = "v2"', async () => {
    const dir = scratch('sc-kiro-engine-doctor-');
    const configPath = join(dir, 'config.toml');
    const stub = (): SeatAdapter => kiroStub([]);
    const run = async (text: string): Promise<string[]> => {
      writeFileSync(configPath, text);
      const lines: string[] = [];
      await runDoctor({ configPath, dbPath: join(dir, 'data', 'council.db'), nodeVersion: 'v22.15.0', write: (l) => lines.push(l), adapters: (b) => (b === 'kiro' ? stub() : undefined) });
      return lines;
    };
    expect(await run(PLAN_EXAMPLE)).toContain('        engine  v3 (the default; engine = "v2" keeps the v2 engine)');
    expect(await run(PLAN_EXAMPLE.replace('effort = "high", on = ["usage_limit", "auth"] }', 'effort = "high", engine = "v2", on = ["usage_limit", "auth"] }'))).toContain('        engine  v2 (engine = "v2")');
  });

  it("a round's legs-settled event records each kiro leg's engine, and the evidence rows show it", () => {
    const dir = scratch('sc-kiro-engine-stats-');
    const store = openStore(join(dir, 'council.db'));
    try {
      const db = store.db;
      const target = Number(db.prepare("INSERT INTO targets (kind, repo, path) VALUES ('plan', 'acme/widget', 'PLAN.md')").run().lastInsertRowid);
      const occ = Number(db.prepare("INSERT INTO occupants (backend, model, effort, transport) VALUES ('kiro', 'gpt-5.6-sol', 'high', 'acp')").run().lastInsertRowid);
      const roster = JSON.stringify({ seats: [{ id: 'a', backend: 'kiro', model: 'gpt-5.6-sol', effort: 'high' }] });
      const round = Number(
        db.prepare("INSERT INTO rounds (target_id, round_no, mode, head_sha, roster_json, started_at, status, verdict) VALUES (?, 1, 'plan', 'abc1234', ?, '2026-11-18T00:00:00.000Z', 'adjudicated', 'SHIP')").run(target, roster).lastInsertRowid,
      );
      const leg = Number(db.prepare("INSERT INTO legs (round_id, seat_id, occupant_id, attempt, role, status, verdict_raw) VALUES (?, 'a', ?, 1, 'primary', 'PASS', 'SHIP')").run(round, occ).lastInsertRowid);
      insertEvent(db, 'legs-settled', round, { quorum: 'solo', ratified: ['a'], aborted: false, legs: [{ id: leg, seat: 'a', role: 'primary', attempt: 1, status: 'PASS', failure_class: null, findings: 'leg', engine: 'v3' }] });
      const data = loadStats(db, null);
      expect(data.rounds[0]?.legs[0]?.engine).toBe('v3');
      const evidence = evidenceOf(data, 'a');
      expect(evidence.rounds[0]).toMatchObject({ ratified: true, said: 'SHIP', engine: 'v3' });
      const lines = recommendationLines({ seat: 'a', swap_candidate: true, eligible: true, occupant: { occupant: 'kiro:gpt-5.6-sol:high', source: 'config', since_round: null, since_at: null }, reasons: [], evidence });
      expect(lines.join('\n')).toContain(': SHIP (kiro engine v3); round verdict SHIP');
    } finally {
      store.close();
    }
  });
});
