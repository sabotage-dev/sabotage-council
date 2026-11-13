import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURSOR_FORBIDDEN_FLAGS,
  CURSOR_READ_TOOLS,
  classifyCursorText,
  councilHookScript,
  createCursorAdapter,
  cursorArgs,
  cursorEnv,
  cursorLegFiles,
  cursorPreflight,
  defaultCursorBin,
  parseCursorVersion,
  prepareCursorConfig,
  ratifyCursorLeg,
  type CursorRatifyInput,
} from '../src/adapters/cursor/index.js';
import type { Occupant, Ratification, RoundCtx } from '../src/adapters/types.js';
import type { CommandResult, CommandRunner } from '../src/transport/headless.js';
import { cleanScratchAfterAll, fixtureDir, materialize, readJsonl, scratch, writeJsonl } from './helpers/fixtures.js';

cleanScratchAfterAll();

interface CaseFile {
  nonce: string;
  model: string;
  cliVersion: string;
  expect: { status: string; failureClass: string | null; failed: string[] };
}

const c = JSON.parse(readFileSync(join(fixtureDir('cursor', 'success'), 'case.json'), 'utf8')) as CaseFile;
const failedNames = (r: Ratification): string[] => r.checks.filter((x) => !x.ok).map((x) => x.name).sort();

function legFor(edit?: (dir: string) => void, over: Partial<CursorRatifyInput> = {}): CursorRatifyInput {
  const { dir, root } = materialize('cursor', 'success');
  edit?.(dir);
  return {
    root,
    nonce: c.nonce,
    model: c.model,
    effort: null,
    cliVersion: c.cliVersion,
    streamFile: join(dir, 'stream.jsonl'),
    stderrFile: join(dir, 'stderr.log'),
    hookLog: join(dir, 'hooks.ndjson'),
    timedOut: false,
    rootUnchanged: () => ({ unchanged: true, changes: [] }),
    ...over,
  };
}

function edit(path: string, match: (r: Record<string, unknown>) => boolean, change: (r: Record<string, unknown>) => void): void {
  const rows = readJsonl(path);
  for (const r of rows) if (match(r)) change(r);
  writeJsonl(path, rows);
}
const append = (path: string, row: Record<string, unknown>): void => writeJsonl(path, [...readJsonl(path), row]);
const typeIs = (t: string) => (r: Record<string, unknown>) => r['type'] === t;
const allHooks = () => true;
const payload = (r: Record<string, unknown>) => r['payload'] as Record<string, unknown>;

describe('cursor replay (synthetic: D14, no live run)', () => {
  it('passes the documented shapes, and labels the leg weak', () => {
    const r = ratifyCursorLeg(legFor());
    expect(failedNames(r)).toEqual([]);
    expect(r).toMatchObject({ status: 'PASS', enforcement: 'weak', modelObserved: 'gpt-5.5-high', cwdOk: true, tokensIn: 4200 });
    expect(r.toolsUsed).toEqual(['grepToolCall', 'readToolCall']);
  });
});

describe('cursor ratification: each check fails on its own (mutation coverage)', () => {
  const cases: Array<[string, (dir: string) => void, string[], Partial<CursorRatifyInput>?]> = [
    ['a malformed stream line', (d) => writeFileSync(join(d, 'stream.jsonl'), readFileSync(join(d, 'stream.jsonl'), 'utf8').replace('\n', '\n{not json\n')), ['stream']],
    ['a result of another session', (d) => edit(join(d, 'stream.jsonl'), typeIs('result'), (r) => (r['session_id'] = 'other')), ['session']],
    ['an init cwd outside the root', (d) => edit(join(d, 'stream.jsonl'), typeIs('system'), (r) => (r['cwd'] = '/elsewhere')), ['cwd']],
    ['no hook record (the council hook did not run)', (d) => writeFileSync(join(d, 'hooks.ndjson'), ''), ['hook-log', 'model', 'workspace']],
    ['another cursor version in the hook', (d) => edit(join(d, 'hooks.ndjson'), allHooks, (r) => (payload(r)['cursor_version'] = '2026.12.01-0000000')), ['cli-version']],
    ['workspace roots beyond the root', (d) => edit(join(d, 'hooks.ndjson'), allHooks, (r) => (payload(r)['workspace_roots'] = ['__SC_ROOT__', '/home/user'])), ['workspace']],
    ['another model slug', (d) => edit(join(d, 'hooks.ndjson'), allHooks, (r) => (payload(r)['model'] = 'gpt-5.5-medium')), ['model']],
    ['no model_id', (d) => edit(join(d, 'hooks.ndjson'), allHooks, (r) => delete payload(r)['model_id']), ['model']],
    ['another effort than the pin', (d) => edit(join(d, 'hooks.ndjson'), allHooks, (r) => (payload(r)['model_params'] = [{ id: 'effort', value: 'medium' }])), ['effort'], { effort: 'high' }],
    ['a completed write call', (d) => append(join(d, 'stream.jsonl'), { type: 'tool_call', subtype: 'completed', call_id: 'w', tool_call: { writeToolCall: { args: { path: '__SC_ROOT__/x.txt' } } } }), ['tools-used']],
    ['a completed read outside the root', (d) => append(join(d, 'stream.jsonl'), { type: 'tool_call', subtype: 'completed', call_id: 'o', tool_call: { readToolCall: { args: { path: '/etc/hosts' } } } }), ['read-paths']],
    ['a file edit', (d) => append(join(d, 'hooks.ndjson'), { event: 'afterFileEdit', decision: null, payload: { file_path: '__SC_ROOT__/x.txt' } }), ['edits']],
    ['a result that is not a success', (d) => edit(join(d, 'stream.jsonl'), typeIs('result'), (r) => (r['subtype'] = 'error_max_turns')), ['result']],
    ['an empty answer', (d) => edit(join(d, 'stream.jsonl'), typeIs('result'), (r) => (r['result'] = '')), ['answer', 'nonce']],
    ['the nonce on the second line', (d) => edit(join(d, 'stream.jsonl'), typeIs('result'), (r) => (r['result'] = `Review.\n${String(r['result'])}`)), ['nonce']],
  ];
  it.each(cases)('fails on %s', (_what, change, expected, over) => {
    expect(failedNames(ratifyCursorLeg(legFor(change, over)))).toEqual([...expected].sort());
  });

  it('fails on a mutated root and with no residue sweep', () => {
    expect(failedNames(ratifyCursorLeg(legFor(undefined, { rootUnchanged: () => ({ unchanged: false, changes: ['x'] }) })))).toEqual(['root-unchanged']);
    expect(failedNames(ratifyCursorLeg(legFor(undefined, { rootUnchanged: undefined })))).toEqual(['root-unchanged']);
  });

  it('a read the council hook denied is not a violation; one it allowed outside the root is', () => {
    const denied = legFor((d) => append(join(d, 'hooks.ndjson'), { event: 'beforeReadFile', decision: 'deny', payload: { file_path: '/etc/hosts' } }));
    expect(failedNames(ratifyCursorLeg(denied))).toEqual([]);
    const allowed = legFor((d) => append(join(d, 'hooks.ndjson'), { event: 'beforeReadFile', decision: 'allow', payload: { file_path: '/etc/hosts' } }));
    expect(failedNames(ratifyCursorLeg(allowed))).toEqual(['read-paths']);
  });
});

describe('cursor council hook (deny all but in-root reads, before execution)', () => {
  function runHook(event: string, input: Record<string, unknown>): { code: number; out: string; root: string; log: string } {
    const dir = scratch('sc-cursor-hook-');
    const root = join(dir, 'root');
    mkdirSync(root);
    writeFileSync(join(dir, 'secret.txt'), 'x');
    symlinkSync(join(dir, 'secret.txt'), join(root, 'link-out.txt'));
    const script = join(dir, 'hook.mjs');
    writeFileSync(script, councilHookScript(CURSOR_READ_TOOLS));
    const log = join(dir, 'hooks.ndjson');
    try {
      const out = execFileSync(process.execPath, [script, event, root, log], { input: JSON.stringify(input).split('__ROOT__').join(root), encoding: 'utf8' });
      return { code: 0, out, root, log };
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      return { code: err.status ?? 1, out: String(err.stdout ?? ''), root, log };
    }
  }
  it.each([
    ['preToolUse', { tool_name: 'read' }, 0, 'allow'],
    ['preToolUse', { tool_name: 'Grep' }, 0, 'allow'],
    ['preToolUse', { tool_name: 'shell' }, 2, 'deny'],
    ['preToolUse', { tool_name: 'write' }, 2, 'deny'],
    ['preToolUse', { tool_name: 'mcp__x__y' }, 2, 'deny'],
    ['beforeReadFile', { file_path: '__ROOT__/inside.txt' }, 0, 'allow'],
    ['beforeReadFile', { file_path: '/etc/hosts' }, 2, 'deny'],
    ['beforeReadFile', { file_path: '__ROOT__/../secret.txt' }, 2, 'deny'],
    ['beforeReadFile', { file_path: '__ROOT__/link-out.txt' }, 2, 'deny'],
    ['beforeReadFile', { file_path: '~/.ssh/id_ed25519' }, 2, 'deny'],
    ['beforeShellExecution', { command: 'echo hi' }, 2, 'deny'],
    ['beforeMCPExecution', { tool_name: 'x' }, 2, 'deny'],
  ])('%s %j -> exit %d, %s', (event, input, code, decision) => {
    const r = runHook(event, input);
    expect(r.code).toBe(code);
    expect(JSON.parse(r.out)).toEqual({ permission: decision });
    expect(readJsonl(r.log)[0]).toMatchObject({ event, decision });
  });
  it('logs a non-gate event and answers nothing', () => {
    const r = runHook('stop', { status: 'completed', model_id: 'm' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(readJsonl(r.log)[0]).toMatchObject({ event: 'stop', decision: null, payload: { model_id: 'm' } });
  });
});

describe('cursor launch', () => {
  it('runs print mode read-only: trust (root sanitized first), ask mode, sandbox, workspace, slug, prompt; never a forbidden flag', () => {
    const args = cursorArgs({ root: '/root', model: 'gpt-5.5-high', prompt: 'NONCE: x' });
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', '/root', '--model', 'gpt-5.5-high', 'NONCE: x']);
    for (const f of CURSOR_FORBIDDEN_FLAGS) expect(args).not.toContain(f);
  });

  it('writes the council config dir outside the root and isolates HOME on the API-key route', () => {
    const dir = scratch('sc-cursor-leg-');
    const root = join(dir, 'root');
    mkdirSync(root);
    const files = cursorLegFiles(join(dir, 'leg'));
    prepareCursorConfig(files, root, '/usr/bin/node');
    const config = JSON.parse(readFileSync(files.cliConfig, 'utf8')) as Record<string, Record<string, unknown>>;
    expect(config['permissions']).toEqual({ allow: ['Read(**)'], deny: ['Write(**)', 'Write(/**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)'] });
    expect(config['sandbox']).toMatchObject({ readBoundary: 'workspace' });
    const hooks = (JSON.parse(readFileSync(files.hooksJson, 'utf8')) as { hooks: Record<string, Array<{ command: string }>> }).hooks;
    expect(Object.keys(hooks)).toEqual(expect.arrayContaining(['preToolUse', 'beforeReadFile', 'beforeShellExecution', 'beforeMCPExecution', 'afterFileEdit', 'stop']));
    expect(hooks['preToolUse']?.[0]?.command).toContain(files.hookScript);
    expect(files.configDir.startsWith(root)).toBe(false);
    expect(cursorEnv({ HOME: '/u', CURSOR_API_KEY: 'k' }, files)['HOME']).toBe(files.home);
    expect(cursorEnv({ HOME: '/u' }, files)).toMatchObject({ HOME: '/u', CURSOR_CONFIG_DIR: files.configDir, NO_OPEN_BROWSER: '1' });
  });

  it('finds the newest unpacked release by path, never agent on PATH', () => {
    const home = scratch('sc-cursor-home-');
    const versions = join(home, '.local', 'share', 'cursor-agent', 'versions');
    for (const v of ['2026.10.22-aaaaaaa', '2026.11.11-b912975']) {
      mkdirSync(join(versions, v), { recursive: true });
      writeFileSync(join(versions, v, 'cursor-agent'), '');
    }
    expect(defaultCursorBin({ HOME: home })).toBe(join(versions, '2026.11.11-b912975', 'cursor-agent'));
    expect(defaultCursorBin({ HOME: scratch('sc-cursor-empty-') })).toBeNull();
    expect(parseCursorVersion('2026.11.11-b912975')).toBe('2026.11.11');
    expect(parseCursorVersion('grok 1.0.70 (f50904eaee6c) [stable]')).toBeNull();
  });
});

describe('cursor failure classifier (4.4)', () => {
  it.each([
    ['ActionRequiredError: Total usage limit reached', 'usage_limit'],
    ["Your stored authentication is invalid. Please log in again.\nPlease run 'agent login' to authenticate.", 'auth'],
    ['AI Model Not Found Model name is not valid: "gpt-5.5"', 'model'],
    ['ERROR_RESOURCE_EXHAUSTED', 'capacity'],
  ])('%s -> %s', (text, cls) => {
    expect(classifyCursorText([text])).toBe(cls);
  });
});

function out(stdout: string, exitCode = 0): CommandResult {
  return { exitCode, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1, error: null };
}

async function preflight(o: Partial<Occupant> = {}, opts: { version?: string; status?: string; models?: string; env?: NodeJS.ProcessEnv; bin?: string | null; plant?: string } = {}) {
  const root = scratch('sc-cursor-root-');
  if (opts.plant) mkdirSync(join(root, opts.plant));
  const legDir = scratch('sc-cursor-leg-');
  const calls: string[][] = [];
  const run: CommandRunner = async (_b, args) => {
    calls.push([...args]);
    if (args[0] === '--version') return out(`${opts.version ?? '2026.11.11-b912975'}\n`);
    if (args[0] === 'status') return out(opts.status ?? 'Logged in\n');
    if (args[0] === 'models') return out(opts.models ?? 'gpt-5.5-high\nclaude-opus-5-high\n');
    return out('', 2);
  };
  const pre = await cursorPreflight({ backend: 'cursor', model: 'gpt-5.5-high', ...o }, { bin: opts.bin === undefined ? '/x/cursor-agent' : opts.bin, runner: run, env: opts.env ?? { HOME: scratch('sc-cursor-u-'), PATH: '/bin' }, root, legDir });
  return { pre, calls };
}

describe('cursor preflight (4.3), no model call', () => {
  it('passes with a weak label and a version warning (no version is tested in v1)', async () => {
    const { pre, calls } = await preflight();
    expect(pre.ok, pre.reason ?? '').toBe(true);
    expect(pre.enforcement).toBe('weak');
    expect(pre.checks.find((x) => x.name === 'version')?.status).toBe('warn');
    expect(calls).toEqual([['--version'], ['status'], ['models']]);
  });
  it.each([
    ['no unpacked release', {}, { bin: null }, 'cursor-agent not installed'],
    ["another vendor's agent", {}, { version: 'grok 1.0.70 (f50904eaee6c) [stable]' }, 'not a Cursor binary'],
    ['an old release', {}, { version: '2026.09.28-0000000' }, 'below the floor'],
    ['a logged-out CLI', {}, { status: 'Your stored authentication is invalid. Please log in again.' }, 'not logged in'],
    ['a slug the account does not list', { model: 'gpt-5.5-low' }, {}, 'not offered'],
    ['an effort that is not in the slug', { effort: 'low' }, {}, 'effort not in the slug'],
    ['auto routing', { model: 'auto' }, {}, 'bad model slug'],
    ['a root holding .cursor/', {}, { plant: '.cursor' }, 'root not sanitized'],
  ])('refuses %s', async (_w, o, opts, reason) => {
    const { pre } = await preflight(o, opts);
    expect(pre.ok).toBe(false);
    expect(pre.reason).toContain(reason);
  });
  it('lists the user HOME files Cursor imports on the keychain login; the API-key route skips status', async () => {
    const home = scratch('sc-cursor-u-');
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), '{}');
    const { pre } = await preflight({}, { env: { HOME: home } });
    expect(pre.userOwned).toEqual(['~/.claude/settings.json (Cursor imports it on the keychain login)']);
    const keyed = await preflight({}, { env: { HOME: home, CURSOR_API_KEY: 'never-read' } });
    expect(keyed.calls).toEqual([['--version'], ['models']]);
    expect(keyed.pre.userOwned).toEqual([]);
  });
});

const FAKE_CURSOR = new URL('./fixtures/bin/fake-cursor-agent.mjs', import.meta.url).pathname;

describe('cursor end to end, through a fake CLI that runs the council hooks', () => {
  async function run(over: Record<string, unknown> = {}) {
    const fixture = materialize('cursor', 'success');
    const outDir = scratch('sc-cursor-out-');
    const caseFile = join(outDir, 'fake.json');
    writeFileSync(caseFile, JSON.stringify({ fixture: fixture.dir, out: outDir, ...over }));
    const legDir = scratch('sc-cursor-leg-');
    const briefFile = join(legDir, 'BRIEF.md');
    writeFileSync(briefFile, `NONCE: ${c.nonce}\nReview.\n`);
    const ctx: RoundCtx = { root: fixture.root, legDir, nonce: c.nonce, briefFile, timeoutMs: 30_000, env: { HOME: scratch('sc-cursor-u-'), PATH: process.env['PATH'] ?? '', CURSOR_API_KEY: 'never-read' }, rootUnchanged: () => ({ unchanged: true, changes: [] }) };
    // The fake reads its case from FAKE_CURSOR, which the scrubbed env drops; pass it through PATH-free by the bin.
    const wrapper = join(outDir, 'cursor-agent');
    writeFileSync(wrapper, `#!/bin/sh\nFAKE_CURSOR=${JSON.stringify(caseFile)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CURSOR)} "$@"\n`, { mode: 0o755 });
    const adapter = createCursorAdapter({ bin: wrapper });
    const o: Occupant = { backend: 'cursor', model: 'gpt-5.5-high' };
    const pre = await adapter.preflight(o, ctx);
    expect(pre.ok, pre.reason ?? '').toBe(true);
    const h = await adapter.launch(o, ctx, pre);
    while ((await adapter.poll(h)).status !== 'done') await new Promise((r) => setTimeout(r, 50));
    return { r: await adapter.ratify(h, ctx), h, outDir, legDir, adapter, ctx };
  }

  it('runs a leg: the hooks Cursor calls write the model proof, and the leg ratifies', async () => {
    const { r, outDir, legDir, h, adapter } = await run();
    expect(failedNames(r)).toEqual([]);
    const decisions = JSON.parse(readFileSync(join(outDir, 'cursor-hook-decisions.json'), 'utf8')) as Array<{ event: string; out: string; code: number }>;
    expect(decisions.filter((d) => d.event === 'preToolUse').map((d) => d.code)).toEqual([0, 0]);
    expect(existsSync(join(legDir, 'hooks.ndjson'))).toBe(true);
    const argv = JSON.parse(readFileSync(join(outDir, 'cursor-argv.json'), 'utf8')) as { home: string; configDir: string; args: string[] };
    expect(argv.home).toBe(join(legDir, 'home'));
    expect(argv.configDir).toBe(join(legDir, 'cursor-config'));
    expect(argv.args.at(-1)).toContain(`NONCE: ${c.nonce}`);
    expect((await adapter.collect(h)).fromNonce).toBe(true);
  });

  it('ends a leg whose print mode hangs after the result (record-based done, then the group kill)', async () => {
    const started = Date.now();
    const { h } = await run({ hangAfterResult: true });
    expect(h.exit?.recordDone).toBe(true);
    expect(h.exit?.killedAfterDone).toBe(true);
    expect(Date.now() - started).toBeLessThan(25_000);
  }, 40_000);
});
