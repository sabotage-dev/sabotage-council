import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGY_FAILURE_PATTERNS,
  agyRuleProblems,
  classifyAgyText,
  createAntigravityAdapter,
  parseAgyModels,
  parseAgyUsage,
  readAgyGenerations,
} from '../src/adapters/antigravity/index.js';
import type { LegHandle, Occupant, Ratification, RoundCtx } from '../src/adapters/types.js';
import type { CommandResult, CommandRunner } from '../src/transport/headless.js';
import { FAKE_ACP, caseOf, fakeHome, replayHandle, writeGenDb } from './helpers/acp.js';
import { cleanScratchAfterAll, fixtureDir, scratch } from './helpers/fixtures.js';

cleanScratchAfterAll();

const failedNames = (r: Ratification): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();
const O: Occupant = { backend: 'antigravity', model: 'gemini-3.8-flash', effort: 'low' };
const LABEL = 'Gemini 3.8 Flash (Low)';
const SLUG = 'gemini-3.8-flash-low';
const SESSION = '00000000-0000-4000-8000-0000000000a1';
const NONCE = 'c0ffee000001';
const TOOLS = ['read_file', 'run_command', 'write_file', 'edit_file', 'search_web', 'ask_question'];

const USAGE_OK = JSON.stringify({
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        { name: 'Gemini Models', description: 'Gemini Flash, Gemini Pro', buckets: [{ id: 'gemini-weekly', remaining_fraction: 0.8, reset_time: '2026-11-19T00:00:00Z' }] },
        { name: 'Claude and GPT models', description: 'Claude, GPT-OSS', buckets: [{ id: '3p-weekly', remaining_fraction: 0, reset_time: '2026-11-19T00:00:00Z' }] },
      ],
    },
  },
});
const MODELS = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\n';

function out(stdout: string, exitCode = 0, stderr = ''): CommandResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false, durationMs: 1, error: null };
}

function runner(overrides: { version?: string; usage?: CommandResult; models?: CommandResult } = {}): { run: CommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: CommandRunner = async (_cmd, args) => {
    calls.push([...args]);
    if (args[0] === '--version') return out(`${overrides.version ?? '1.5.7'}\n`);
    if (args[0] === '-p' && args[1] === '/usage') return overrides.usage ?? out(USAGE_OK);
    if (args[0] === 'models') return overrides.models ?? out(MODELS, 0, 'Fetching available models...\n');
    return out('', 2, `unexpected ${args.join(' ')}`);
  };
  return { run, calls };
}

function ctxFor(home: string, extraEnv: Record<string, string> = {}): RoundCtx & { outside: string } {
  const dir = scratch('sc-agy-leg-');
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
  return {
    root,
    legDir,
    nonce: NONCE,
    briefFile,
    timeoutMs: 15_000,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, ...extraEnv },
    rootUnchanged: () => ({ unchanged: true, changes: [] }),
    outside,
  };
}

const AGY_LOG = [
  'I1112 00:00:00.000000 1 server.go:1] Language server version: 1.5.7',
  'E1112 00:00:00.000000 1 errorreport.go:1] error getting token source: You are not logged into Antigravity.',
  'I1112 00:00:00.000000 1 launcher.go:1] ACP app data directory: ${GEMINI_DIR}/antigravity-cli (cliDir="", mode=ccpa)',
  'I1112 00:00:00.000000 1 server.go:1] Created conversation ${SESSION} (backend=BACKEND_TYPE_UNSPECIFIED)',
  'I1112 00:00:00.000000 1 server.go:1] Setting default model override: Gemini 3.8 Flash (High)',
].join('\n');

const REVIEW = [{ text: `NONCE: ${NONCE}\nVERDICT: SHIP\n` }];
const readStep = (id: string, path: string, ask = false) => ({ tool: { toolCallId: id, name: 'read_file', title: `File ${path}`, kind: 'read', args: { Path: path }, locations: [{ path }] }, ask });

interface Run {
  r: Ratification;
  handle: LegHandle;
  ctx: RoundCtx & { outside: string };
  home: string;
  cls: ReturnType<ReturnType<typeof createAntigravityAdapter>['classify']>;
}

/** Runs the fake agent through the real adapter (preflight on a fake runner), then rebuilds the conversation DB. */
async function launch(kase: Record<string, unknown>, opts: { gen?: Array<{ label: string | null; slug: string | null; tools: string[] | null }>; env?: Record<string, string>; plant?: (root: string, outside: string) => void; agyLog?: string } = {}): Promise<Run> {
  const full = { sessionId: SESSION, configOptions: undefined, startRecords: [{ path: '${LOG_FILE}', content: opts.agyLog ?? AGY_LOG }], ...kase };
  const home = fakeHome(JSON.parse(JSON.stringify(full)));
  const ctx = ctxFor(home, opts.env);
  opts.plant?.(ctx.root, ctx.outside);
  // Placeholders the case uses for this leg's own dirs.
  writeFileSync(join(home, 'fake-acp.json'), readFileSync(join(home, 'fake-acp.json'), 'utf8').split('__ROOT__').join(ctx.root).split('__OUTSIDE__').join(ctx.outside));
  const adapter = createAntigravityAdapter({ bin: FAKE_ACP, runner: runner().run });
  const pre = await adapter.preflight(O, ctx);
  expect(pre.ok, pre.reason ?? '').toBe(true);
  const handle = await adapter.launch(O, ctx, pre);
  while ((await adapter.poll(handle)).status !== 'done') await new Promise((res) => setTimeout(res, 50));
  writeGenDb(join(ctx.legDir, 'gemini', 'antigravity-cli', 'conversations', `${SESSION}.db`), opts.gen ?? [{ label: LABEL, slug: null, tools: null }, { label: LABEL, slug: SLUG, tools: TOOLS }]);
  const r = await adapter.ratify(handle, ctx);
  return { r, handle, ctx, home, cls: adapter.classify(handle) };
}

describe('antigravity replay: recorded live legs (sanitized)', () => {
  const recorded = readdirSync(fixtureDir('antigravity', '')).filter((n) => existsSync(join(fixtureDir('antigravity', n), 'case.json')));
  it('has the recorded smoke and both canary runs', () => {
    expect(recorded.sort()).toEqual(['canary-clean', 'canary-planted', 'smoke']);
  });
  it.each(recorded)('%s', async (name) => {
    const c = caseOf('antigravity', name);
    const { handle, ctx } = replayHandle('antigravity', name);
    const r = await createAntigravityAdapter().ratify(handle, ctx);
    expect({ status: r.status, failureClass: r.failureClass, failed: failedNames(r) }).toEqual({ status: c.expect.status, failureClass: c.expect.failureClass, failed: [...c.expect.failed].sort() });
  });
  it('records the fields 4.5 lists from the recorded smoke', async () => {
    const { handle, ctx } = replayHandle('antigravity', 'smoke');
    const r = await createAntigravityAdapter().ratify(handle, ctx);
    expect(r).toMatchObject({ status: 'PASS', cliVersion: '1.5.7', modelObserved: LABEL, effortObserved: 'low', toolsUsed: ['read_file'], tokensIn: 52506, tokensOut: 648, nonceSeen: true, cwdOk: true });
    expect(r.toolsOffered).toContain('run_command');
    expect(r.detail['modelCalls']).toBe(5);
  });
  it('the recorded canary: the outside read was asked and rejected, and nothing ran after the rejection', async () => {
    const { handle, ctx } = replayHandle('antigravity', 'canary-clean');
    const r = await createAntigravityAdapter().ratify(handle, ctx);
    const perms = r.detail['permissions'] as Array<{ decision: string; why: string }>;
    expect(perms.map((p) => p.decision)).toEqual(['reject']);
    expect(perms[0]?.why).toContain('resolves outside the root');
    expect(r.checks.find((c) => c.name === 'denials-held')?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'tools-used')?.ok).toBe(true);
  });
  it('fails the recorded smoke on a model call at another label', async () => {
    const { handle, ctx } = replayHandle('antigravity', 'smoke', (dir) => {
      const gen = JSON.parse(readFileSync(join(dir, 'gen.json'), 'utf8')) as { rows: Array<{ label: string }> };
      (gen.rows[1] as { label: string }).label = 'Gemini 3.8 Flash (High)';
      writeGenDb(join(dir, 'gemini', 'antigravity-cli', 'conversations', '79be01f1-fff3-4733-9a43-5e32adca500f.db'), gen.rows as never);
    });
    // The helper wrote the DB first; the edit above rewrote it, so the replay sees the High call.
    const r = await createAntigravityAdapter().ratify(handle, ctx);
    expect(failedNames(r)).toEqual(['record-model']);
    expect(r.failureClass).toBe('model');
  });
});

describe('antigravity through the fake agent (synthetic, every conformance case)', () => {
  it('a clean review: in-root reads ran unasked, PASS; launch flags, env and leg settings', async () => {
    const { r, handle, home, ctx } = await launch({ steps: [readStep('t1', '__ROOT__/inside.txt'), ...REVIEW] });
    expect(failedNames(r)).toEqual([]);
    expect(r.status).toBe('PASS');
    const argv = JSON.parse(readFileSync(join(home, 'fake-acp-argv.json'), 'utf8')) as { args: string[]; env: string[]; cwd: string };
    expect(argv.args.slice(0, 4)).toEqual(['acp', '--disable-telemetry', '--sandbox', '--include-default-customizations=false']);
    expect(argv.args).toContain('--gemini-dir');
    expect(argv.args[argv.args.indexOf('--gemini-dir') + 1]).toBe(join(ctx.legDir, 'gemini'));
    expect(argv.env).toContain('AGY_CLI_DISABLE_AUTO_UPDATE');
    expect(argv.env).not.toContain('GEMINI_API_KEY');
    expect(JSON.parse(readFileSync(handle.files['settings'] ?? '', 'utf8'))).toEqual({ allowNonWorkspaceAccess: false });
    const pins = JSON.parse(readFileSync(handle.files['log'] ?? '', 'utf8').split('\n').find((l) => l.includes('pins-held')) ?? '{}') as { pins: unknown };
    expect(pins.pins).toEqual([
      { via: 'set_config_option', configId: 'model', value: 'gemini-3.8-flash' },
      { via: 'set_config_option', configId: 'thought_level', value: 'low' },
      { via: 'set_config_option', configId: 'mode', value: 'default' },
    ]);
  });

  it('the API-key route: GEMINI_API_KEY passes through by name and the leg settings carry modelProvider gemini', async () => {
    const { handle, home } = await launch({ steps: REVIEW }, { env: { GEMINI_API_KEY: 'k' } });
    expect(JSON.parse(readFileSync(handle.files['settings'] ?? '', 'utf8'))).toEqual({ allowNonWorkspaceAccess: false, modelProvider: 'gemini' });
    expect((JSON.parse(readFileSync(join(home, 'fake-acp-argv.json'), 'utf8')) as { env: string[] }).env).toContain('GEMINI_API_KEY');
  });

  it('a permission asked and refused: the outside read is rejected and the leg ratifies', async () => {
    const { r } = await launch({ steps: [readStep('t1', '__OUTSIDE__/secret.txt', true), ...REVIEW] });
    expect(failedNames(r)).toEqual([]);
    expect((r.detail['permissions'] as Array<{ decision: string }>).map((p) => p.decision)).toEqual(['reject']);
  });

  it('a write asked: refused', async () => {
    const { r } = await launch({ steps: [{ tool: { toolCallId: 'w', name: 'write_file', title: 'File CANARY.txt', kind: 'edit', args: { TargetFile: '__ROOT__/CANARY.txt' } }, ask: true }, ...REVIEW] });
    expect(failedNames(r)).toEqual([]);
  });

  it('a tool executed without asking ratifies contaminated', async () => {
    const { r } = await launch({ steps: [{ tool: { toolCallId: 'x', name: 'run_command', title: 'echo canary', kind: 'execute', args: { CommandLine: 'echo canary' } }, ask: false }, ...REVIEW] });
    expect(failedNames(r)).toEqual(['tools-used']);
    expect(r.status).toBe('CONTAMINATED');
    expect(r.detail['unasked']).toEqual([{ id: 'x', title: 'echo canary', kinds: ['execute'] }]);
  });

  it('an outside read by path that ran unasked ratifies contaminated', async () => {
    const { r } = await launch({ steps: [readStep('t', '__OUTSIDE__/secret.txt'), ...REVIEW] });
    expect(failedNames(r)).toEqual(['read-paths']);
    expect(r.status).toBe('CONTAMINATED');
  });

  it('a read through a symlink that leaves the root: rejected when asked, contaminated when it ran unasked', async () => {
    const plant = (root: string, outside: string): void => symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out.txt'));
    const asked = await launch({ steps: [readStep('t', '__ROOT__/link-out.txt', true), ...REVIEW] }, { plant });
    expect(failedNames(asked.r)).toEqual([]);
    const unasked = await launch({ steps: [readStep('t', '__ROOT__/link-out.txt'), ...REVIEW] }, { plant });
    expect(failedNames(unasked.r)).toEqual(['read-paths']);
  });

  it('a mode the agent does not accept: refused before the prompt, setup', async () => {
    const { r, cls } = await launch({ refuseConfig: ['mode'], steps: REVIEW });
    expect(failedNames(r)).toEqual(['answer', 'nonce', 'prompt', 'refusal']);
    expect(r.failureClass).toBe('setup');
    expect(cls).toBe('setup');
  });

  it('a torn update stream: transport', async () => {
    const { r } = await launch({ steps: [{ raw: '{"jsonrpc":"2.0","method":"session/upd', noNewline: true }, { exit: 1 }] });
    expect(failedNames(r)).toContain('log');
    expect(r.failureClass).toBe('transport');
  });

  it('auth failure: "authentication required" at session/new classifies auth', async () => {
    const { r, cls } = await launch({ sessionNewError: { code: -32000, message: 'authentication required' } });
    expect(r.failureClass).toBe('auth');
    expect(cls).toBe('auth');
  });

  it('usage limit: RESOURCE_EXHAUSTED on the prompt classifies usage_limit', async () => {
    const { r, cls } = await launch({ promptError: { code: -32603, message: 'AGY_ERROR', data: '{"canonical_status":"RESOURCE_EXHAUSTED","code":429}' } });
    expect(r.failureClass).toBe('usage_limit');
    expect(cls).toBe('usage_limit');
  });

  it('the benign startup line "You are not logged into Antigravity." never classifies as auth', async () => {
    const { r, cls } = await launch({ stderr: 'error getting token source: You are not logged into Antigravity.\n', steps: REVIEW });
    expect(r.status).toBe('PASS');
    expect(cls).toBeNull();
    expect(classifyAgyText(['W1112 cache.go:157] error getting token source: You are not logged into Antigravity.'])).toBeNull();
  });

  it('a model call at another label (silent reroute) fails record-model', async () => {
    const { r } = await launch({ steps: REVIEW }, { gen: [{ label: LABEL, slug: null, tools: null }, { label: 'Gemini 3.8 Flash (High)', slug: 'gemini-3.8-flash-high', tools: TOOLS }] });
    expect(failedNames(r)).toEqual(['record-model']);
    expect(r.failureClass).toBe('model');
  });

  it('the leg ran on the user gemini dir, not its own: contaminated', async () => {
    const { r } = await launch({ steps: REVIEW }, { agyLog: AGY_LOG.replace('${GEMINI_DIR}/antigravity-cli', '/home/user/.gemini/antigravity-cli') });
    expect(failedNames(r)).toEqual(['gemini-dir']);
    expect(r.status).toBe('CONTAMINATED');
  });

  it('a log that never names the conversation: agy-log', async () => {
    const { r } = await launch({ steps: REVIEW }, { agyLog: AGY_LOG.split('\n').filter((l) => !l.includes('Created conversation')).join('\n') });
    expect(failedNames(r)).toEqual(['agy-log']);
    expect(r.failureClass).toBe('setup');
  });

  it('another CLI version in the log than preflight saw: setup', async () => {
    const { r } = await launch({ steps: REVIEW }, { agyLog: AGY_LOG.replace('version: 1.5.7', 'version: 1.5.9') });
    expect(failedNames(r)).toEqual(['cli-version']);
  });

  it('a mode switched after the prompt: contaminated', async () => {
    const { r } = await launch({ steps: [{ configUpdate: { mode: 'auto' } }, ...REVIEW] });
    expect(failedNames(r)).toEqual(['mode-held']);
  });
});

describe('antigravity preflight (no model call)', () => {
  const ctx = (): RoundCtx => ctxFor(scratch('sc-agy-home-'));
  it('passes on a signed-in account, maps the model and effort to the slug and label, and reads quota', async () => {
    const { run, calls } = runner();
    const pre = await createAntigravityAdapter({ runner: run }).preflight(O, ctx());
    expect(pre.ok).toBe(true);
    expect(pre.enforcement).toBe('pending');
    expect(pre.data).toMatchObject({ slug: SLUG, label: LABEL, apiKey: false });
    expect(calls).toEqual([['--version'], ['-p', '/usage', '--output-format', 'json'], ['models']]);
  });
  it('refuses below the version floor', async () => {
    const pre = await createAntigravityAdapter({ runner: runner({ version: '1.5.5' }).run }).preflight(O, ctx());
    expect(pre).toMatchObject({ ok: false, failureClass: 'setup' });
  });
  it('a failed /usage with the auth text is auth', async () => {
    const pre = await createAntigravityAdapter({ runner: runner({ usage: out('', 1, 'Error: authentication required') }).run }).preflight(O, ctx());
    expect(pre).toMatchObject({ ok: false, failureClass: 'auth' });
  });
  it('a used-up quota group is usage_limit', async () => {
    const pre = await createAntigravityAdapter({ runner: runner().run }).preflight({ backend: 'antigravity', model: 'claude-sonnet-4-6' }, ctx());
    expect(pre).toMatchObject({ ok: false, failureClass: 'usage_limit' });
  });
  it('a model the account does not list, or a Gemini model with no effort, is refused', async () => {
    const a = await createAntigravityAdapter({ runner: runner().run }).preflight({ backend: 'antigravity', model: 'gemini-4-argon', effort: 'low' }, ctx());
    expect(a).toMatchObject({ ok: false, failureClass: 'model' });
    const b = await createAntigravityAdapter({ runner: runner().run }).preflight({ backend: 'antigravity', model: 'gemini-3.8-flash' }, ctx());
    expect(b).toMatchObject({ ok: false, failureClass: 'model' });
  });
  it('refuses a planted allow rule in the leg settings (the canary overlay)', async () => {
    const pre = await createAntigravityAdapter({ runner: runner().run, settingsOverlay: { permissions: { allow: ['command(*)'] } } }).preflight(O, ctx());
    expect(pre).toMatchObject({ ok: false, failureClass: 'setup' });
    expect(pre.reason).toContain('permissions.allow');
  });
  it('refuses a root that still holds agent config', async () => {
    const c = ctx();
    writeFileSync(join(c.root, 'GEMINI.md'), 'x');
    const pre = await createAntigravityAdapter({ runner: runner().run }).preflight(O, c);
    expect(pre).toMatchObject({ ok: false, failureClass: 'setup' });
  });
  it('the API-key route skips /usage', async () => {
    const { run, calls } = runner();
    const pre = await createAntigravityAdapter({ runner: run }).preflight(O, { ...ctx(), env: { PATH: '/usr/bin', HOME: '/tmp', GEMINI_API_KEY: 'k' } });
    expect(pre.ok).toBe(true);
    expect(calls.map((c) => c[0])).toEqual(['--version', 'models']);
  });
});

describe('antigravity units', () => {
  it('parses agy models and /usage', () => {
    expect(parseAgyModels(MODELS).map((m) => m.slug)).toEqual(['gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-sonnet-4-6']);
    expect(parseAgyUsage(USAGE_OK)?.groups.map((g) => g.remaining)).toEqual([0.8, 0]);
  });
  it('rule problems: any allow, an auto mode, a tool permission other than request-review, outside access', () => {
    expect(agyRuleProblems({ allowNonWorkspaceAccess: false })).toEqual([]);
    expect(agyRuleProblems({ allowNonWorkspaceAccess: false, permissions: { allow: ['read_file(.)'] } })).toHaveLength(1);
    expect(agyRuleProblems({ allowNonWorkspaceAccess: false, agentMode: 'auto' })).toHaveLength(1);
    expect(agyRuleProblems({ allowNonWorkspaceAccess: false, toolPermission: 'always-proceed' })).toHaveLength(1);
    expect(agyRuleProblems({})).toEqual(['allowNonWorkspaceAccess is not false']);
  });
  it('failure signatures: each class from its own text', () => {
    expect(classifyAgyText(['Authentication expired. Please log back in.'])).toBe('auth');
    expect(classifyAgyText(['invalid model selection (--model "x")'])).toBe('model');
    expect(classifyAgyText(['AGY_ERROR: {"canonical_status":"UNAVAILABLE","code":503}'])).toBe('capacity');
    expect(classifyAgyText(['Error: --settings: unknown setting "x"'])).toBe('setup');
    expect(AGY_FAILURE_PATTERNS.length).toBeGreaterThan(0);
  });
  it('reads a missing conversation DB as absent, not as a pass', () => {
    expect(readAgyGenerations('/nonexistent.db')).toMatchObject({ exists: false, rows: 0 });
  });
});
