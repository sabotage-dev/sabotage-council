import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUSE_FORBIDDEN_FLAGS,
  MUSE_SAFETY_FLAGS,
  classifyMuseText,
  createMuseAdapter,
  museArgs,
  museEnv,
  museLegFiles,
  musePreflight,
  ratifyMuseLeg,
  type MuseRatifyInput,
} from '../src/adapters/muse/index.js';
import type { Occupant, Ratification, RoundCtx } from '../src/adapters/types.js';
import type { CommandResult, CommandRunner } from '../src/transport/headless.js';
import { cleanScratchAfterAll, fixtureDir, materialize, readJsonl, scratch, writeJsonl } from './helpers/fixtures.js';

cleanScratchAfterAll();

interface CaseFile {
  nonce: string;
  model: string;
  effort: string;
  sessionId: string;
  cliVersion: string;
  rootMutated: boolean;
  expect: { status: string; failureClass: string | null; failed: string[] };
}

const caseOf = (name: string): CaseFile => JSON.parse(readFileSync(join(fixtureDir('muse', name), 'case.json'), 'utf8')) as CaseFile;
const failedNames = (r: Ratification): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();
const logOf = (dir: string, sid: string): string => join(dir, 'data', 'muse', 'sessions', '2026', '11', '12', sid, 'session.jsonl');

function legFor(name: string, edit?: (dir: string, c: CaseFile) => void, rootMutated = false): { input: MuseRatifyInput; dir: string; c: CaseFile } {
  const c = caseOf(name);
  const { dir, root } = materialize('muse', name);
  edit?.(dir, c);
  return {
    dir,
    c,
    input: {
      root,
      nonce: c.nonce,
      model: c.model,
      effort: c.effort,
      sessionId: c.sessionId,
      cliVersion: c.cliVersion,
      streamFile: join(dir, 'stream.jsonl'),
      stderrFile: join(dir, 'stderr.log'),
      processFile: join(dir, 'process.json'),
      dataDir: join(dir, 'data'),
      exportFile: join(dir, 'export.json'),
      timedOut: false,
      exitCode: 0,
      rootUnchanged: () => ({ unchanged: !rootMutated, changes: rootMutated ? ['modified x'] : [] }),
    },
  };
}

const typeIs = (t: string) => (r: Record<string, unknown>) => r['payload_type'] === t;
function edit(path: string, match: (r: Record<string, unknown>) => boolean, change: (r: Record<string, unknown>) => void): void {
  const rows = readJsonl(path);
  for (const r of rows) if (match(r)) change(r);
  writeJsonl(path, rows);
}
const payload = (r: Record<string, unknown>): Record<string, unknown> => r['payload'] as Record<string, unknown>;
function editJson(path: string, change: (v: Record<string, unknown>) => void): void {
  const v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(v);
  writeFileSync(path, JSON.stringify(v));
}

/** The recorded echo run as a logged-in run would record it: the pinned model in run.usage, the NONCE answer first. */
function loggedIn(dir: string, c: CaseFile): void {
  edit(join(dir, 'stream.jsonl'), typeIs('run.usage'), (r) => ((payload(r)['models'] as Array<Record<string, unknown>>)[0] = { model: c.model, input_tokens: 1200, cached_tokens: 0, output_tokens: 300, reasoning_tokens: 0, calls: 1 }));
  edit(join(dir, 'stream.jsonl'), typeIs('run.terminal.completed'), (r) => (payload(r)['text'] = `NONCE: ${c.nonce}\nNo findings.\nVERDICT: SHIP\n`));
}

describe('muse replay: the recorded offline runs (echo provider) and their logged-in shape', () => {
  it.each(['echo-review', 'echo-canary'])('%s ratifies to its recorded verdict', (name) => {
    const c = caseOf(name);
    const r = ratifyMuseLeg(legFor(name).input);
    expect({ status: r.status, failureClass: r.failureClass, failed: failedNames(r) }).toEqual({ status: c.expect.status, failureClass: c.expect.failureClass, failed: [...c.expect.failed].sort() });
    expect(r.enforcement).toBe('weak');
  });

  it('passes the logged-in shape of the recorded run, and records usage', () => {
    const r = ratifyMuseLeg(legFor('echo-review', loggedIn).input);
    expect(failedNames(r)).toEqual([]);
    expect(r).toMatchObject({ status: 'PASS', modelObserved: 'muse-spark-1.3', cliVersion: '1.4.15', tokensIn: 1200, tokensOut: 300, cwdOk: true, enforcement: 'weak' });
  });
});

describe('muse ratification: each check fails on its own (mutation coverage)', () => {
  const cases: Array<[string, (dir: string, c: CaseFile) => void, string[], boolean?]> = [
    ['a malformed stream line', (dir) => writeFileSync(join(dir, 'stream.jsonl'), readFileSync(join(dir, 'stream.jsonl'), 'utf8').replace('\n', '\n{not json\n')), ['stream']],
    ['a record of another session', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('turn.input.user'), (r) => ((r['stream'] as Record<string, unknown>)['id'] = 'other')), ['session']],
    ['no session log in the leg data dir', (dir, c) => rmSync(logOf(dir, c.sessionId)), ['session-log']],
    ['an export with gaps', (dir) => editJson(join(dir, 'export.json'), (v) => ((v['diagnostics'] as Record<string, unknown>)['gaps'] = 1)), ['export']],
    ['another session build', (dir) => editJson(join(dir, 'export.json'), (v) => ((v['session_build'] as Record<string, unknown>)['semver'] = '1.4.16')), ['build']],
    ['an abnormal end', (dir) => editJson(join(dir, 'export.json'), (v) => (v['session_terminated_abnormally'] = true)), ['terminated']],
    ['an accepted subagent spawn', (dir) => editJson(join(dir, 'export.json'), (v) => ((v['sessions'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['accepted_spawns'] = [{ id: 'x' }]), ['subagents']],
    ['a workspace root outside the root', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('session.workspace_branch.observed'), (r) => (((payload(r)['record'] as Record<string, unknown>)['workspace_root'] = '/elsewhere'))), ['workspace']],
    ['contributor mode on in a record', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('run.lifecycle.started'), (r) => (payload(r)['contributor_mode'] = 'on')), ['contributor']],
    ['a leg run without --contributor-mode off', (dir) => editJson(join(dir, 'process.json'), (v) => (v['args'] = (v['args'] as string[]).filter((a, i, all) => a !== '--contributor-mode' && all[i - 1] !== '--contributor-mode'))), ['flags']],
    ['a leg run with --trust-workspace', (dir) => editJson(join(dir, 'process.json'), (v) => (v['args'] = [...(v['args'] as string[]), '--trust-workspace'])), ['flags']],
    ['another model in run.usage', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('run.usage'), (r) => (((payload(r)['models'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['model'] = 'muse-ember-1.0')), ['model']],
    ['another effort in a record', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('run.lifecycle.started'), (r) => (payload(r)['reasoning_effort'] = 'low')), ['effort']],
    ['a shell side effect', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('task.lifecycle.side_effect_intent'), (r) => (((payload(r)['event'] as Record<string, unknown>)['operation'] = 'tool.bash'))), ['side-effects']],
    ['a terminal record that did not complete', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('run.terminal.completed'), (r) => (payload(r)['terminal'] = 'cancelled')), ['terminal']],
    ['an empty answer', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('run.terminal.completed'), (r) => (payload(r)['text'] = '')), ['answer', 'nonce']],
    ['the nonce on the second line', (dir, c) => edit(join(dir, 'stream.jsonl'), typeIs('run.terminal.completed'), (r) => (payload(r)['text'] = `Review.\nNONCE: ${c.nonce}`)), ['nonce']],
    ['a mutated root', () => undefined, ['root-unchanged'], true],
  ];
  it.each(cases)('fails on %s', (_what, change, expected, mutated) => {
    const r = ratifyMuseLeg(legFor('echo-review', (dir, c) => {
      loggedIn(dir, c);
      change(dir, c);
    }, mutated).input);
    expect(failedNames(r)).toEqual([...expected].sort());
  });

  it('fails closed with no export, as setup', () => {
    const r = ratifyMuseLeg(legFor('echo-review', (dir, c) => {
      loggedIn(dir, c);
      rmSync(join(dir, 'export.json'));
    }).input);
    expect(failedNames(r)).toEqual(['export']);
    expect(r.failureClass).toBe('setup');
  });
});

describe('muse launch', () => {
  it('passes every safety flag, never a forbidden one, contributor mode off, the session id and workspace', () => {
    const args = museArgs({ sessionId: 's', root: '/root', model: 'muse-spark-1.3', effort: 'high', briefFile: '/leg/BRIEF.md' });
    expect(args.slice(0, 6)).toEqual(['exec', '--json', '--session-id', 's', '--workspace', '/root']);
    for (const f of MUSE_SAFETY_FLAGS) expect(args).toContain(f);
    for (const f of MUSE_FORBIDDEN_FLAGS) expect(args).not.toContain(f);
    expect(args).not.toContain('--sandbox-network');
    expect(args).not.toContain('--approval-judge');
    expect(args[args.indexOf('--contributor-mode') + 1]).toBe('off');
    expect(args[args.indexOf('--prompt-file') + 1]).toBe('/leg/BRIEF.md');
  });

  it('isolates XDG config and data per leg, reads the login through MUSE_AUTH_PATH, and pins contributor mode off', () => {
    const files = museLegFiles('/leg');
    const env = museEnv({ HOME: '/u', PATH: '/bin', SECRET: 'no' }, files);
    expect(env).toMatchObject({ XDG_CONFIG_HOME: '/leg/muse/config', XDG_DATA_HOME: '/leg/muse/data', MUSE_AUTH_PATH: '/u/.config/muse/auth.json', MUSE_CONTRIBUTOR_MODE: '0', MUSE_NO_AUTO_UPDATE: '1', MUSE_LOGIN: '0' });
    expect(env['SECRET']).toBeUndefined();
    expect(museEnv({ HOME: '/u', XDG_CONFIG_HOME: '/x' }, files)['MUSE_AUTH_PATH']).toBe('/x/muse/auth.json');
  });
});

describe('muse failure classifier (4.4)', () => {
  it.each([
    ['muse usage: not logged in: run `muse login` first', 'auth'],
    ['{"error":{"kind":"modelError","quota":{"limitKind":"tierLimit"}}}', 'usage_limit'],
    ['--permission-profile cannot be used with --sandbox-network.', 'setup'],
    ['model_not_found', 'model'],
    ['rate_limit_exceeded', 'capacity'],
  ])('%s -> %s', (text, cls) => {
    expect(classifyMuseText([text])).toBe(cls);
  });
});

// ---- preflight through a scripted runner ----

function out(stdout: string, exitCode = 0): CommandResult {
  return { exitCode, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1, error: null };
}

async function preflight(o: Partial<Occupant> = {}, opts: { loggedIn?: boolean; version?: string; env?: NodeJS.ProcessEnv; plant?: string } = {}) {
  const root = scratch('sc-muse-root-');
  if (opts.plant) mkdirSync(join(root, opts.plant));
  const legDir = scratch('sc-muse-leg-');
  const calls: string[][] = [];
  const run: CommandRunner = async (_c, args, options) => {
    calls.push([...args]);
    expect(options.env['XDG_CONFIG_HOME']).toBe(join(legDir, 'muse', 'config'));
    if (args[0] === '--version') return out(`Muse Code ${opts.version ?? '1.4.15'} (1.4.15-R8339.1)\n`);
    if (args[0] === 'usage') return opts.loggedIn === false ? out('muse usage: not logged in: run `muse login` first\n', 1) : out('window 3%\n');
    return out('', 2);
  };
  const pre = await musePreflight({ backend: 'muse', model: 'muse-spark-1.3', effort: 'high', ...o }, { bin: 'muse', runner: run, env: opts.env ?? { HOME: '/u', PATH: '/bin' }, root, legDir });
  return { pre, calls, legDir };
}

describe('muse preflight (4.3), no model call', () => {
  it('passes, labels weak, and writes the leg settings (schema_version 1 only)', async () => {
    const { pre, calls, legDir } = await preflight();
    expect(pre.ok, pre.reason ?? '').toBe(true);
    expect(pre.enforcement).toBe('weak');
    expect(calls).toEqual([['--version'], ['usage']]);
    expect(JSON.parse(readFileSync(join(legDir, 'muse', 'config', 'muse', 'settings.json'), 'utf8'))).toEqual({ schema_version: 1 });
  });

  it.each([
    ['a contributor model', { model: 'muse-spark-1.3-contributor' }, {}, 'contributor model'],
    ['an undeclared model', { model: 'muse-spark-9' }, {}, 'model muse-spark-9 not declared'],
    ['no effort', { effort: undefined }, {}, 'muse seats need an effort'],
    ['a logged-out muse', {}, { loggedIn: false }, 'muse is not logged in'],
    ['an old version', {}, { version: '1.4.0' }, 'below the tested floor'],
    ['a root holding .agents/', {}, { plant: '.agents' }, 'root not sanitized'],
  ])('refuses %s', async (_what, o, opts, reason) => {
    const { pre } = await preflight(o, opts);
    expect(pre.ok).toBe(false);
    expect(pre.reason).toContain(reason);
  });

  it('names META_API_KEY as pay-as-you-go and skips the login check', async () => {
    const { pre, calls } = await preflight({}, { env: { HOME: '/u', META_API_KEY: 'never-read' } });
    expect(pre.ok).toBe(true);
    expect(pre.data['credential']).toBe('META_API_KEY (pay-as-you-go)');
    expect(calls).toEqual([['--version']]);
  });
});

// ---- end to end through a fake muse ----

const FAKE_MUSE = new URL('./fixtures/bin/fake-muse.mjs', import.meta.url).pathname;

describe('muse end to end, through a fake CLI', () => {
  it('runs a leg: preflight, launch, record-based done, collect, export at ratify, ratify', async () => {
    const fixture = materialize('muse', 'echo-review');
    const c = caseOf('echo-review');
    loggedIn(fixture.dir, c);
    const home = scratch('sc-muse-home-');
    const out = scratch('sc-muse-out-');
    const caseFile = join(home, 'fake-muse.json');
    writeFileSync(caseFile, JSON.stringify({ fixture: fixture.dir, sessionId: c.sessionId, out }));
    const legDir = scratch('sc-muse-leg-');
    const briefFile = join(legDir, 'BRIEF.md');
    writeFileSync(briefFile, 'brief');
    const ctx: RoundCtx = { root: fixture.root, legDir, nonce: c.nonce, briefFile, timeoutMs: 30_000, env: { HOME: home, PATH: process.env['PATH'] ?? '' }, rootUnchanged: () => ({ unchanged: true, changes: [] }) };
    const adapter = createMuseAdapter({ bin: FAKE_MUSE });
    const o: Occupant = { backend: 'muse', model: 'muse-spark-1.3', effort: 'high' };
    const pre = await adapter.preflight(o, ctx);
    expect(pre.ok, pre.reason ?? '').toBe(true);
    const h = await adapter.launch(o, ctx, pre);
    while ((await adapter.poll(h)).status !== 'done') await new Promise((r) => setTimeout(r, 50));
    expect((await adapter.collect(h)).fromNonce).toBe(true);
    const r = await adapter.ratify(h, ctx);
    expect(failedNames(r)).toEqual([]);
    expect(existsSync(join(legDir, 'export.json'))).toBe(true);
    const argv = JSON.parse(readFileSync(join(out, 'muse-argv.json'), 'utf8')) as { args: string[]; xdgConfig: string; auth: string };
    expect(argv.xdgConfig).toBe(join(legDir, 'muse', 'config'));
    expect(argv.auth).toBe(join(home, '.config', 'muse', 'auth.json'));
    expect(argv.args).toContain('--no-foreign-personal-context');
  });
});
