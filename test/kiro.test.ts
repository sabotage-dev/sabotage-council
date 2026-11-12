import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  KIRO_AGENT,
  classifyKiroText,
  createKiroAdapter,
  kiroProfile,
  kiroTokenStore,
  parseKiroModels,
  readTokenState,
} from '../src/adapters/kiro/index.js';
import type { LegHandle, Occupant, Ratification, RoundCtx } from '../src/adapters/types.js';
import { sqlite } from '../src/store/sqlite.js';
import type { CommandResult, CommandRunner } from '../src/transport/headless.js';
import { FAKE_ACP, caseOf, replayHandle } from './helpers/acp.js';
import { cleanScratchAfterAll, fixtureDir, scratch } from './helpers/fixtures.js';

cleanScratchAfterAll();

const failedNames = (r: Ratification): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();
const SESSION = '00000000-0000-4000-8000-0000000000b1';
const NONCE = 'c0ffee000002';
const MODEL = 'claude-sonnet-4.5';
const MODELS_JSON = JSON.stringify({ models: [{ model_id: 'auto' }, { model_id: 'claude-sonnet-4.5' }, { model_id: 'claude-haiku-4.5' }], default_model: 'auto' });

function out(stdout: string, exitCode = 0, stderr = ''): CommandResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false, durationMs: 1, error: null };
}

function runner(listModels: CommandResult = out(MODELS_JSON)): { run: CommandRunner; calls: Array<{ args: string[]; home: string | undefined }> } {
  const calls: Array<{ args: string[]; home: string | undefined }> = [];
  const run: CommandRunner = async (_cmd, args, options) => {
    calls.push({ args: [...args], home: options.env['HOME'] });
    if (args[0] === '--version') return out('kiro-cli 3.2.1\n');
    if (args[0] === 'chat' && args[1] === '--list-models') return listModels;
    return out('', 2, 'unexpected');
  };
  return { run, calls };
}

/** A token store under a HOME (darwin layout), with only the fields preflight reads. */
function tokenHome(token: Record<string, unknown> | null): string {
  const home = scratch('sc-kiro-home-');
  if (token === null) return home;
  const store = kiroTokenStore(home, 'darwin');
  mkdirSync(join(store, '..'), { recursive: true });
  const db = new (sqlite().DatabaseSync)(store);
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run('kirocli:odic:token', JSON.stringify(token));
  db.close();
  return home;
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();
const GOOD_TOKEN = { access_token: 'never-read', expires_at: FUTURE, refresh_token: 'never-read' };

function ctxFor(extraEnv: Record<string, string> = {}): RoundCtx & { outside: string } {
  const dir = scratch('sc-kiro-leg-');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'inside.txt'), 'inside\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  const legDir = join(dir, 'leg');
  mkdirSync(legDir);
  const briefFile = join(dir, 'BRIEF.md');
  writeFileSync(briefFile, `NONCE: ${NONCE}\nreview\n`);
  return { root, legDir, nonce: NONCE, briefFile, timeoutMs: 15_000, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/nonexistent-real-home', ...extraEnv }, rootUnchanged: () => ({ unchanged: true, changes: [] }), outside };
}

function sessionRecord(over: { agent?: string; model?: string; turnModel?: string; effort?: string | null; trusted?: string[] } = {}): Record<string, unknown> {
  return {
    session_id: '${SESSION}',
    cwd: '${CWD}',
    session_created_reason: 'subagent',
    session_state: {
      version: 'v1',
      agent_name: over.agent ?? KIRO_AGENT,
      rts_model_state: {
        model_info: { model_id: over.model ?? MODEL },
        ...(over.effort !== undefined && over.effort !== null ? { additional_fields: { overrides: { output_config: { effort: over.effort } } } } : {}),
      },
      conversation_metadata: { user_turn_metadatas: [{ model: over.turnModel ?? over.model ?? MODEL, metering_usage: [{ value: 0.02, unit: 'credit' }, { value: 0.03, unit: 'credit' }], turn_duration: { secs: 4, nanos: 0 } }] },
      permissions: { filesystem: { allowed_read_paths: ['${CWD}'], allowed_write_paths: [] }, trusted_tools: over.trusted ?? [] },
    },
  };
}

const REVIEW = [{ text: `NONCE: ${NONCE}\nVERDICT: SHIP\n` }];
const readStep = (id: string, path: string, ask = false) => ({ tool: { toolCallId: id, title: `Reading ${path}`, kind: 'read', rawInput: { operations: [{ mode: 'Line', path }] }, locations: [{ path }] }, ask });

interface Run {
  r: Ratification;
  handle: LegHandle;
  ctx: RoundCtx & { outside: string };
  home: string;
  cls: ReturnType<ReturnType<typeof createKiroAdapter>['classify']>;
}

async function launch(kase: Record<string, unknown>, opts: { o?: Partial<Occupant>; record?: Record<string, unknown> | null; plant?: (root: string, outside: string) => void; startedAt?: (ms: number) => void } = {}): Promise<Run> {
  const home = tokenHome(GOOD_TOKEN);
  const o: Occupant = { backend: 'kiro', model: MODEL, effort: 'low', authHome: home, ...opts.o };
  const record = opts.record === undefined ? sessionRecord({ effort: o.effort ?? null }) : opts.record;
  const full = {
    sessionId: SESSION,
    noConfigOptions: true,
    modes: { currentModeId: KIRO_AGENT, availableModes: [{ id: KIRO_AGENT }, { id: 'kiro_default' }] },
    models: { currentModelId: o.model, availableModels: [{ modelId: o.model }] },
    records: record === null ? [] : [{ path: '${KIRO_HOME}/sessions/cli/${SESSION}.json', json: record }],
    ...kase,
  };
  const ctx = ctxFor();
  opts.plant?.(ctx.root, ctx.outside);
  writeFileSync(join(home, 'fake-acp.json'), JSON.stringify(full).split('__ROOT__').join(ctx.root).split('__OUTSIDE__').join(ctx.outside));
  const adapter = createKiroAdapter({ bin: FAKE_ACP, runner: runner().run, platform: 'darwin' });
  const pre = await adapter.preflight(o, ctx);
  expect(pre.ok, pre.reason ?? '').toBe(true);
  const started = Date.now();
  const handle = await adapter.launch(o, ctx, pre);
  while ((await adapter.poll(handle)).status !== 'done') await new Promise((res) => setTimeout(res, 50));
  opts.startedAt?.(Date.now() - started);
  const r = await adapter.ratify(handle, ctx);
  return { r, handle, ctx, home, cls: adapter.classify(handle) };
}

describe('kiro replay: recorded live legs (sanitized)', () => {
  const recorded = readdirSync(fixtureDir('kiro', '')).filter((n) => existsSync(join(fixtureDir('kiro', n), 'case.json')));
  it('has the recorded smoke and both canary runs', () => {
    expect(recorded.sort()).toEqual(['canary-clean', 'canary-planted', 'smoke']);
  });
  it.each(recorded)('%s', async (name) => {
    const c = caseOf('kiro', name);
    const { handle, ctx } = replayHandle('kiro', name);
    const r = await createKiroAdapter().ratify(handle, ctx);
    expect({ status: r.status, failureClass: r.failureClass, failed: failedNames(r) }).toEqual({ status: c.expect.status, failureClass: c.expect.failureClass, failed: [...c.expect.failed].sort() });
  });
  it('records the fields 4.5 lists from the recorded smoke: model, credits, engine', async () => {
    const { handle, ctx } = replayHandle('kiro', 'smoke');
    const r = await createKiroAdapter().ratify(handle, ctx);
    expect(r).toMatchObject({ status: 'PASS', cliVersion: '3.2.1', modelObserved: 'claude-haiku-4.5', effortObserved: null, credits: 0.0646, toolsUsed: ['read'], nonceSeen: true });
    expect(r.detail['engine']).toBe('v2');
  });
  it('the recorded clean canary: the outside reads by path, through the symlink and the search were all rejected', async () => {
    const { handle, ctx } = replayHandle('kiro', 'canary-clean');
    const r = await createKiroAdapter().ratify(handle, ctx);
    const perms = r.detail['permissions'] as Array<{ decision: string; why: string }>;
    expect(perms.map((p) => p.decision)).toEqual(['reject', 'reject', 'reject']);
    expect(perms.some((p) => p.why.includes('its realpath leaves the root'))).toBe(true);
  });
});

describe('kiro through the fake agent (synthetic, every conformance case)', () => {
  it('a clean review on the auth_home login: PASS; flags, homes and the council profile', async () => {
    const { r, handle, home, ctx } = await launch({ steps: [readStep('t1', '__ROOT__/inside.txt'), ...REVIEW] });
    expect(failedNames(r)).toEqual([]);
    expect(r.status).toBe('PASS');
    expect(r.credits).toBe(0.05);
    const argv = JSON.parse(readFileSync(join(home, 'fake-acp-argv.json'), 'utf8')) as { args: string[]; env: string[] };
    expect(argv.args).toEqual(['acp', '--agent-engine', 'v2', '--agent', KIRO_AGENT, '--model', MODEL, '--effort', 'low']);
    expect(argv.env).toContain('KIRO_HOME');
    expect(argv.env.filter((n) => n.startsWith('XDG_'))).toEqual([]);
    expect(handle.data['home']).toBe(home);
    expect(JSON.parse(readFileSync(handle.files['profile'] ?? '', 'utf8'))).toEqual(kiroProfile(MODEL));
    expect(handle.files['profile']).toBe(join(ctx.legDir, 'kiro-home', 'agents', `${KIRO_AGENT}.json`));
  });

  it('a permission asked and refused, and a write asked and refused: the leg ratifies', async () => {
    const { r } = await launch({ steps: [readStep('t', '__OUTSIDE__/secret.txt', true), { tool: { toolCallId: 'w', title: 'Writing CANARY.txt', kind: 'edit', rawInput: { path: '__ROOT__/CANARY.txt' } }, ask: true }, ...REVIEW] });
    expect(failedNames(r)).toEqual([]);
    expect((r.detail['permissions'] as Array<{ decision: string }>).map((p) => p.decision)).toEqual(['reject', 'reject']);
  });

  it('a tool executed without asking ratifies contaminated', async () => {
    const { r } = await launch({ steps: [{ tool: { toolCallId: 'x', title: 'Running echo', kind: 'execute', rawInput: { command: 'echo canary' } }, ask: false }, ...REVIEW] });
    expect(failedNames(r)).toEqual(['tools-used']);
    expect(r.status).toBe('CONTAMINATED');
  });

  it('outside reads by path and through a symlink that ran unasked ratify contaminated', async () => {
    const byPath = await launch({ steps: [readStep('t', '__OUTSIDE__/secret.txt'), ...REVIEW] });
    expect(failedNames(byPath.r)).toEqual(['read-paths']);
    const plant = (root: string, outside: string): void => symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out.txt'));
    const viaLink = await launch({ steps: [readStep('t', '__ROOT__/link-out.txt'), ...REVIEW] }, { plant });
    expect(failedNames(viaLink.r)).toEqual(['read-paths']);
    const asked = await launch({ steps: [readStep('t', '__ROOT__/link-out.txt', true), ...REVIEW] }, { plant });
    expect(failedNames(asked.r)).toEqual([]);
  });

  it('a mode (agent) the engine does not run: refused before the prompt, setup', async () => {
    const { r, cls } = await launch({ modes: { currentModeId: 'kiro_default' }, steps: REVIEW }, { record: null });
    expect(failedNames(r)).toEqual(['answer', 'mode', 'nonce', 'prompt', 'refusal', 'session-record']);
    expect(r.failureClass).toBe('setup');
    expect(cls).toBe('setup');
  });

  it('a torn update stream: transport', async () => {
    const { r } = await launch({ steps: [{ raw: '{"jsonrpc":"2.0","method":"session/upd', noNewline: true }, { exit: 1 }] });
    expect(failedNames(r)).toContain('log');
    expect(r.failureClass).toBe('transport');
  });

  it('auth: a browser sign-in prompt kills the leg at once and classifies auth', async () => {
    let took = 0;
    const { r, cls, handle } = await launch({ stderr: 'Opening browser... | Press (^) + C to cancel\n', ignoreStdinClose: true, steps: [{ hang: true }] }, { startedAt: (ms) => (took = ms) });
    expect((handle.exit as { killedOn?: string }).killedOn).toContain('Opening browser');
    expect(took).toBeLessThan(10_000);
    expect(failedNames(r)).toEqual(['answer', 'handshake', 'nonce', 'prompt', 'session', 'session-record']);
    expect(r.failureClass).toBe('auth');
    expect(cls).toBe('auth');
  });

  it('auth: "Not logged in." at session/new classifies auth', async () => {
    const { cls } = await launch({ sessionNewError: { code: -32000, message: 'Not logged in. Set the KIRO_API_KEY environment variable or run `kiro-cli login` first.' } }, { record: null });
    expect(cls).toBe('auth');
  });

  it('usage limit: the monthly limit classifies usage_limit', async () => {
    const { r, cls } = await launch({ promptError: { code: -32603, message: 'Monthly request limit reached. The limits reset on 12/01.' } });
    expect(r.failureClass).toBe('usage_limit');
    expect(cls).toBe('usage_limit');
  });

  it('exit 4 (agent unavailable on the engine) is setup', async () => {
    const { cls } = await launch({ exitAtStart: 4 }, { record: null });
    expect(cls).toBe('setup');
  });

  it.each([
    ['another model in a turn', { turnModel: 'auto' }, 'record-model', 'model'],
    ['another agent', { agent: 'kiro_default' }, 'record-agent', 'contaminated'],
    ['another effort', { effort: 'high' }, 'record-effort', 'model'],
    ['a trusted tool', { trusted: ['fs_write'] }, 'record-permissions', 'contaminated'],
  ])('the session record with %s fails %s', async (_what, over, check, cls) => {
    const { r } = await launch({ steps: REVIEW }, { record: sessionRecord({ effort: 'low', ...over }) });
    expect(failedNames(r)).toEqual([check]);
    expect(r.failureClass).toBe(cls);
  });

  it('a missing session record fails closed', async () => {
    const { r } = await launch({ steps: REVIEW }, { record: null });
    expect(failedNames(r)).toEqual(['session-record']);
    expect(r.failureClass).toBe('setup');
  });
});

describe('kiro preflight (no model call, no browser risk)', () => {
  const o = (home: string, extra: Partial<Occupant> = {}): Occupant => ({ backend: 'kiro', model: MODEL, effort: 'low', authHome: home, ...extra });
  it('reads only expiry and refresh presence from the auth_home store, then lists models with HOME = auth_home', async () => {
    const home = tokenHome(GOOD_TOKEN);
    const { run, calls } = runner();
    const pre = await createKiroAdapter({ runner: run, platform: 'darwin' }).preflight(o(home), ctxFor());
    expect(pre.ok, pre.reason ?? '').toBe(true);
    expect(pre.enforcement).toBe('pending');
    expect(pre.data).toMatchObject({ home, authHome: home, engine: 'v2' });
    expect(calls.map((c) => [c.args.join(' '), c.home])).toEqual([
      ['--version', home],
      ['chat --list-models --format json', home],
    ]);
    expect(JSON.stringify(pre)).not.toContain('never-read');
    expect(pre.checks.find((c) => c.name === 'home')?.detail).toContain("the seat's auth_home");
  });
  it('defaults to the user HOME when no auth_home is set', async () => {
    const home = tokenHome(GOOD_TOKEN);
    const pre = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight({ backend: 'kiro', model: MODEL, effort: 'low' }, { ...ctxFor(), env: { PATH: '/usr/bin', HOME: home } });
    expect(pre.ok).toBe(true);
    expect(pre.checks.find((c) => c.name === 'home')?.detail).toContain("the user's HOME");
  });
  it('no token store: auth, and kiro-cli is never started', async () => {
    const { run, calls } = runner();
    const pre = await createKiroAdapter({ runner: run, platform: 'darwin' }).preflight(o(tokenHome(null)), ctxFor());
    expect(pre).toMatchObject({ ok: false, failureClass: 'auth' });
    expect(calls).toEqual([]);
  });
  it('an expired token with no refresh token: auth; with one: proceeds', async () => {
    const dead = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o(tokenHome({ expires_at: PAST, refresh_token: '' })), ctxFor());
    expect(dead).toMatchObject({ ok: false, failureClass: 'auth' });
    const refreshable = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o(tokenHome({ expires_at: PAST, refresh_token: 'never-read' })), ctxFor());
    expect(refreshable.ok).toBe(true);
  });
  it('KIRO_API_KEY skips the token store', async () => {
    const pre = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o(tokenHome(null)), ctxFor({ KIRO_API_KEY: 'k' }));
    expect(pre.ok).toBe(true);
  });
  it('a browser prompt in the model listing is auth', async () => {
    const pre = await createKiroAdapter({ runner: runner(out('Opening browser... | Press (^) + C to cancel')).run, platform: 'darwin' }).preflight(o(tokenHome(GOOD_TOKEN)), ctxFor());
    expect(pre).toMatchObject({ ok: false, failureClass: 'auth' });
  });
  it('a model the account does not list is model; an effort on a no-effort model or auto is refused', async () => {
    const a = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o(tokenHome(GOOD_TOKEN), { model: 'gpt-5.6-sol' }), ctxFor());
    expect(a).toMatchObject({ ok: false, failureClass: 'model' });
    const b = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o(tokenHome(GOOD_TOKEN), { model: 'claude-haiku-4.5' }), ctxFor());
    expect(b).toMatchObject({ ok: false, failureClass: 'setup' });
    const c = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o(tokenHome(GOOD_TOKEN), { model: 'auto', effort: undefined }), ctxFor());
    expect(c).toMatchObject({ ok: false, failureClass: 'setup' });
  });
  it('refuses an overlaid profile (the canary plant) and a root with .kiro', async () => {
    const a = await createKiroAdapter({ runner: runner().run, platform: 'darwin', profileOverlay: { allowedTools: ['fs_read'] } }).preflight(o(tokenHome(GOOD_TOKEN)), ctxFor());
    expect(a).toMatchObject({ ok: false, failureClass: 'setup' });
    const ctx = ctxFor();
    mkdirSync(join(ctx.root, '.kiro'));
    const b = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o(tokenHome(GOOD_TOKEN)), ctx);
    expect(b).toMatchObject({ ok: false, failureClass: 'setup' });
  });
  it('an auth_home that does not exist is refused', async () => {
    const pre = await createKiroAdapter({ runner: runner().run, platform: 'darwin' }).preflight(o('/nonexistent-kiro-home'), ctxFor());
    expect(pre).toMatchObject({ ok: false, failureClass: 'setup' });
  });
});

describe('kiro units', () => {
  it('never matches the remediation text alone as auth', () => {
    expect(classifyKiroText(['To sign in again, run `kiro-cli login`.'])).toBeNull();
    expect(classifyKiroText(['error: OAuth error: Auth portal timed out'])).toBe('auth');
    expect(classifyKiroText(['acp-exit-code 3'])).toBe('setup');
    expect(classifyKiroText(['acp-exit-code 1'])).toBeNull();
    expect(classifyKiroText(['Kiro is having trouble responding right now:'])).toBe('capacity');
    expect(classifyKiroText(["[warn] failed to set effort 'high': model 'glm-5' offers no effort levels"])).toBeNull();
  });
  it('reads the token state without its values', () => {
    const home = tokenHome(GOOD_TOKEN);
    const state = readTokenState(kiroTokenStore(home, 'darwin'));
    expect(state).toEqual({ present: true, expiresAt: FUTURE, expired: false, refreshToken: true, problem: null });
    expect(kiroTokenStore('/h', 'linux')).toBe('/h/.local/share/kiro-cli/data.sqlite3');
  });
  it('parses the model list', () => {
    expect(parseKiroModels(MODELS_JSON)).toEqual(['auto', 'claude-sonnet-4.5', 'claude-haiku-4.5']);
  });
});
