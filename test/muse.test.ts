import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MUSE_FORBIDDEN_FLAGS,
  MUSE_SAFETY_FLAGS,
  classifyMuseText,
  createMuseAdapter,
  defaultMuseBin,
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

/** Applies one edit to every record source the ratifier reads: the stream, the session log and the export's events. */
function editAll(dir: string, c: CaseFile, match: (r: Record<string, unknown>) => boolean, change: (r: Record<string, unknown>) => void): void {
  edit(join(dir, 'stream.jsonl'), match, change);
  edit(logOf(dir, c.sessionId), match, change);
  editJson(join(dir, 'export.json'), (v) => {
    for (const e of (v['events'] as Array<Record<string, unknown>> | undefined) ?? []) if (match(e['envelope'] as Record<string, unknown>)) change(e['envelope'] as Record<string, unknown>);
  });
}

/**
 * Synthetic, never a recorded shape: the export gains `events[]` built from the stream's session envelopes, for
 * the tests of the optional corroboration (the recorded 1.4.15 export has only `first_events`).
 */
function withSyntheticEvents(dir: string): void {
  const rows = readJsonl(join(dir, 'stream.jsonl')).filter((r) => (r['stream'] as Record<string, unknown>)['kind'] === 'session');
  editJson(join(dir, 'export.json'), (v) => (v['events'] = rows.map((envelope) => ({ kind: 'record', synthetic: true, envelope }))));
}

const event = (r: Record<string, unknown>): Record<string, unknown> => payload(r)['event'] as Record<string, unknown>;

/**
 * The recorded echo run as a logged-in run would record it: the pinned model in run.usage and in the model step's
 * kind and operation, the NONCE answer first.
 */
function loggedIn(dir: string, c: CaseFile): void {
  edit(join(dir, 'stream.jsonl'), typeIs('run.usage'), (r) => ((payload(r)['models'] as Array<Record<string, unknown>>)[0] = { model: c.model, input_tokens: 1200, cached_tokens: 0, output_tokens: 300, reasoning_tokens: 0, calls: 1 }));
  edit(join(dir, 'stream.jsonl'), typeIs('run.terminal.completed'), (r) => (payload(r)['text'] = `NONCE: ${c.nonce}\nNo findings.\nVERDICT: SHIP\n`));
  editAll(dir, c, typeIs('task.lifecycle.proposed'), (r) => (event(r)['task_kind'] = `model.${c.model}.response`));
  editAll(dir, c, typeIs('task.lifecycle.side_effect_intent'), (r) => (event(r)['operation'] = `model.${c.model}.response`));
}

/** Adds one task (proposed, intent, completed) with the given kind and input to every record source. */
function addTask(dir: string, c: CaseFile, kind: string, input: Record<string, unknown>): void {
  const base = { schema_version: 1, stream: { kind: 'session', id: c.sessionId }, record_type: 'event', durability: 'durable', payload_schema_version: 1 };
  const rows = ['proposed', 'side_effect_intent', 'completed'].map((k, i) => ({
    ...base,
    id: `t-${kind}-${i}`,
    sequence: 900 + i,
    recorded_at: 1780531400000900 + i,
    payload_type: `task.lifecycle.${k}`,
    payload: { kind: 'task_lifecycle', task_id: 'task-x', event: { kind: k, task_id: 'task-x', ...(k === 'proposed' ? { task_kind: kind } : {}), ...(k === 'side_effect_intent' ? { operation: kind, input } : {}) } },
  }));
  writeJsonl(join(dir, 'stream.jsonl'), [...readJsonl(join(dir, 'stream.jsonl')), ...rows]);
  writeJsonl(logOf(dir, c.sessionId), [...readJsonl(logOf(dir, c.sessionId)), ...rows]);
  editJson(join(dir, 'export.json'), (v) => (v['events'] as unknown[] | undefined)?.push(...rows.map((envelope) => ({ kind: 'record', envelope }))));
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

  it('ratifies the recorded export shape (a summary with first_events, no events[]) on the stream and the session log', () => {
    for (const name of ['echo-review', 'echo-canary']) {
      const recorded = JSON.parse(readFileSync(join(fixtureDir('muse', name), 'export.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(recorded).sort()).toEqual(['diagnostics', 'export_schema_version', 'exporter_version', 'first_events', 'session_build', 'session_terminated_abnormally', 'sessions']);
      const r = ratifyMuseLeg(legFor(name, loggedIn).input);
      expect(r.checks.find((c) => c.name === 'export')).toMatchObject({ ok: true });
      expect(r.checks.find((c) => c.name === 'export')?.detail).toContain('no events[]');
      expect(failedNames(r)).toEqual([]);
    }
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
    ['a shell side effect', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('task.lifecycle.side_effect_intent'), (r) => (((payload(r)['event'] as Record<string, unknown>)['operation'] = 'tool.bash'))), ['tools-used']],
    ['a read task outside the root', (dir, c) => addTask(dir, c, 'tool.read_file', { path: '/etc/hosts' }), ['read-paths']],
    ['a read task inside the root', (dir, c) => addTask(dir, c, 'tool.read_file', { path: 'planted/calc/rangesum.py' }), []],
    ['a read task with no path', (dir, c) => addTask(dir, c, 'tool.grep', { pattern: 'x' }), ['activity']],
    ['an MCP task', (dir, c) => addTask(dir, c, 'mcp.github.search', { query: 'x' }), ['mcp']],
    ['an unrecognised task shape', (dir, c) => addTask(dir, c, 'agent.spawn', {}), ['tools-used']],
    ['a model step on another model', (dir, c) => editAll(dir, c, typeIs('task.lifecycle.side_effect_intent'), (r) => (event(r)['operation'] = 'model.muse-ember-1.0.response')), ['model-steps']],
    ['a task with no kind or operation', (dir, c) => {
      editAll(dir, c, typeIs('task.lifecycle.proposed'), (r) => delete event(r)['task_kind']);
      editAll(dir, c, typeIs('task.lifecycle.side_effect_intent'), (r) => delete event(r)['operation']);
    }, ['activity']],
    ['model calls with no task record', (dir, c) => {
      const keep = (r: Record<string, unknown>) => !String(r['payload_type']).startsWith('task.lifecycle.');
      writeJsonl(join(dir, 'stream.jsonl'), readJsonl(join(dir, 'stream.jsonl')).filter(keep));
      writeJsonl(logOf(dir, c.sessionId), readJsonl(logOf(dir, c.sessionId)).filter(keep));
      editJson(join(dir, 'export.json'), (v) => {
        if (Array.isArray(v['events'])) v['events'] = (v['events'] as Array<Record<string, unknown>>).filter((e) => keep(e['envelope'] as Record<string, unknown>));
      });
    }, ['activity']],
    ['an export whose events carry no envelope (synthetic events)', (dir) => {
      withSyntheticEvents(dir);
      editJson(join(dir, 'export.json'), (v) => delete ((v['events'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>)['envelope']);
    }, ['export']],
    ['contributor mode "enabled" in the export events only (synthetic events)', (dir) => {
      withSyntheticEvents(dir);
      editJson(join(dir, 'export.json'), (v) => (((v['events'] as Array<Record<string, unknown>>)[0] as Record<string, Record<string, unknown>>)['envelope'] as Record<string, unknown>)['contributor_mode'] = 'enabled');
    }, ['contributor']],
    ['synthetic export events that agree with the stream', (dir) => withSyntheticEvents(dir), []],
    ['a permission profile other than read-only in a record', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('run.lifecycle.started'), (r) => (payload(r)['permission_profile'] = ':auto-review')), ['flags']],
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

  it('requires effort, contributor mode and the profile in the records of a version not declared to omit them (claude F3)', () => {
    const { input } = legFor('echo-review', (dir, c) => {
      loggedIn(dir, c);
      editJson(join(dir, 'export.json'), (v) => ((v['session_build'] as Record<string, unknown>)['semver'] = '1.4.16'));
    });
    expect(failedNames(ratifyMuseLeg({ ...input, cliVersion: '1.4.16' }))).toEqual(['contributor', 'effort', 'flags']);
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
    expect(env).toMatchObject({ HOME: '/leg/muse/home', XDG_CONFIG_HOME: '/leg/muse/config', XDG_DATA_HOME: '/leg/muse/data', MUSE_AUTH_PATH: '/u/.config/muse/auth.json', MUSE_CONTRIBUTOR_MODE: '0', MUSE_NO_AUTO_UPDATE: '1', MUSE_LOGIN: '0' });
    expect(env['SECRET']).toBeUndefined();
    expect(museEnv({ HOME: '/u', XDG_CONFIG_HOME: '/x' }, files)['MUSE_AUTH_PATH']).toBe('/x/muse/auth.json');
  });
});

describe('muse binary', () => {
  it('calls the native binary the launcher records, by path, else the launcher', () => {
    const home = scratch('sc-muse-bin-');
    const bin = join(home, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'muse'), '#!/bin/sh\n');
    expect(defaultMuseBin({ HOME: home })).toBe(join(bin, 'muse'));
    writeFileSync(join(bin, '.muse-version'), '1.4.15-R8339.1\n');
    writeFileSync(join(bin, 'muse-bin-1.4.15-R8339.1'), '');
    expect(defaultMuseBin({ HOME: home })).toBe(join(bin, 'muse-bin-1.4.15-R8339.1'));
    expect(defaultMuseBin({ HOME: scratch('sc-muse-none-') })).toBe('muse');
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

async function preflight(o: Partial<Occupant> = {}, opts: { loggedIn?: boolean; version?: string; env?: NodeJS.ProcessEnv; plant?: string; file?: boolean } = {}) {
  const root = scratch('sc-muse-root-');
  if (opts.plant !== undefined && opts.file === true) {
    mkdirSync(dirname(join(root, opts.plant)), { recursive: true });
    writeFileSync(join(root, opts.plant), 'x');
  } else if (opts.plant !== undefined) mkdirSync(join(root, opts.plant), { recursive: true });
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
    ['a root holding a nested .muse/', {}, { plant: 'pkg/.muse', file: false }, 'root not sanitized'],
    ['a root holding a nested CLAUDE.md', {}, { plant: 'pkg/docs/CLAUDE.md', file: true }, 'root not sanitized'],
    ['a root holding a stray MEMORY.md', {}, { plant: 'notes/MEMORY.md', file: true }, 'root not sanitized'],
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
    // The leg's HOME is its own, so the fake reads its case from FAKE_MUSE, set by a wrapper (the env is scrubbed).
    const wrapper = join(out, 'muse');
    writeFileSync(wrapper, `#!/bin/sh\nFAKE_MUSE=${JSON.stringify(caseFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_MUSE)} "$@"\n`, { mode: 0o755 });
    const adapter = createMuseAdapter({ bin: wrapper });
    const o: Occupant = { backend: 'muse', model: 'muse-spark-1.3', effort: 'high' };
    const pre = await adapter.preflight(o, ctx);
    expect(pre.ok, pre.reason ?? '').toBe(true);
    const h = await adapter.launch(o, ctx, pre);
    while ((await adapter.poll(h)).status !== 'done') await new Promise((r) => setTimeout(r, 50));
    expect((await adapter.collect(h)).fromNonce).toBe(true);
    const r = await adapter.ratify(h, ctx);
    expect(failedNames(r)).toEqual([]);
    expect(existsSync(join(legDir, 'export.json'))).toBe(true);
    const argv = JSON.parse(readFileSync(join(out, 'muse-argv.json'), 'utf8')) as { args: string[]; xdgConfig: string; auth: string; home: string };
    expect(argv.xdgConfig).toBe(join(legDir, 'muse', 'config'));
    expect(argv.home).toBe(join(legDir, 'muse', 'home'));
    expect(argv.auth).toBe(join(home, '.config', 'muse', 'auth.json'));
    expect(argv.args).toContain('--no-foreign-personal-context');
  });
});
