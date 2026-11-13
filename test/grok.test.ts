import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GROK_DENY_RULES,
  GROK_READ_TOOLS,
  classifyGrokText,
  createGrokAdapter,
  grokArgs,
  grokEffortMenu,
  grokEnv,
  grokLabel,
  grokLegFiles,
  grokModelMatches,
  grokPreflight,
  legGrokHome,
  parseGrokInspect,
  parseGrokModels,
  ratifyGrokLeg,
  type GrokRatifyInput,
} from '../src/adapters/grok/index.js';
import type { Occupant, Ratification, RoundCtx } from '../src/adapters/types.js';
import type { CommandResult, CommandRunner } from '../src/transport/headless.js';
import { cleanScratchAfterAll, fixtureDir, materialize, readJsonl, scratch, writeJsonl } from './helpers/fixtures.js';

cleanScratchAfterAll();

interface CaseFile {
  nonce: string;
  model: string;
  effort: string;
  sandbox: 'read-only' | 'off';
  cliVersion: string;
  sessionId: string;
  rootMutated: boolean;
  plantSymlink: boolean;
  expect: { status: string; failureClass: string | null; failed: string[] };
}

const CASES = ['smoke', 'canary-clean', 'canary-planted'];
const caseOf = (name: string): CaseFile => JSON.parse(readFileSync(join(fixtureDir('grok', name), 'case.json'), 'utf8')) as CaseFile;
const failedNames = (r: Ratification): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();

/** The recorded leg laid out as grok left it: the session dir under `<grok home>/sessions/<encoded root>/<id>/`. */
function legFor(name: string, edit?: (dir: string, session: string) => void, rootMutated?: boolean): { input: GrokRatifyInput; dir: string; session: string } {
  const c = caseOf(name);
  const { dir, root } = materialize('grok', name);
  const tmp = join(dir, '..');
  if (c.plantSymlink) symlinkSync(join(tmp, 'outside', 'secret.txt'), join(root, 'link-out.txt'));
  const grokHome = join(tmp, 'grok-home');
  const session = join(grokHome, 'sessions', encodeURIComponent(root), c.sessionId);
  mkdirSync(join(session, '..'), { recursive: true });
  renameSync(join(dir, 'session'), session);
  edit?.(dir, session);
  const mutated = rootMutated ?? c.rootMutated;
  return {
    dir,
    session,
    input: {
      root,
      nonce: c.nonce,
      model: c.model,
      effort: c.effort,
      sandbox: c.sandbox,
      sessionId: c.sessionId,
      cliVersion: c.cliVersion,
      streamFile: join(dir, 'stream.jsonl'),
      stderrFile: join(dir, 'stderr.log'),
      grokHome,
      timedOut: false,
      rootUnchanged: () => ({ unchanged: !mutated, changes: mutated ? ['modified planted/calc/rangesum.py'] : [] }),
    },
  };
}

function edit(path: string, match: (row: Record<string, unknown>) => boolean, change: (row: Record<string, unknown>) => void): void {
  const rows = readJsonl(path);
  for (const row of rows) if (match(row)) change(row);
  writeJsonl(path, rows);
}

function editJson(path: string, change: (v: Record<string, unknown>) => void): void {
  const v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(v);
  writeFileSync(path, JSON.stringify(v));
}

/** Adds an update for the first read_file call: before its first snapshot, or after its last. */
function insertUpdate(session: string, make: (id: string) => Record<string, unknown>, before: boolean): void {
  const rows = readJsonl(join(session, 'updates.jsonl'));
  const updateOf = (r: Record<string, unknown>) => (r['params'] as { update?: Record<string, unknown> } | undefined)?.update;
  const first = rows.findIndex((r) => updateOf(r)?.['sessionUpdate'] === 'tool_call' && updateOf(r)?.['title'] === 'read_file');
  const id = String(updateOf(rows[first] as Record<string, unknown>)?.['toolCallId']);
  let last = first;
  rows.forEach((r, i) => {
    if (updateOf(r)?.['toolCallId'] === id) last = i;
  });
  const row = { method: 'session/update', params: { sessionId: 'x', update: make(id) } };
  rows.splice(before ? first + 1 : last + 1, 0, row);
  writeJsonl(join(session, 'updates.jsonl'), rows);
}

/** The recorded smoke with the user MCP server's events removed: the leg a machine with no MCP config gets. */
function noMcp(_dir: string, session: string): void {
  const rows = readJsonl(join(session, 'events.jsonl')).filter((e) => !String(e['type']).startsWith('mcp_'));
  writeJsonl(join(session, 'events.jsonl'), rows);
}

const typeIs = (t: string) => (row: Record<string, unknown>) => row['type'] === t;
const initRow = (row: Record<string, unknown>) => row['subtype'] === 'init';
const toolCallRow = (row: Record<string, unknown>) => (row['params'] as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === 'tool_call';

describe('grok replay: the recorded live legs', () => {
  it.each(CASES)('%s ratifies to its recorded verdict', (name) => {
    const c = caseOf(name);
    const r = ratifyGrokLeg(legFor(name).input);
    expect({ status: r.status, failureClass: r.failureClass, failed: failedNames(r) }).toEqual({ status: c.expect.status, failureClass: c.expect.failureClass, failed: [...c.expect.failed].sort() });
  });

  it('records the fields 4.5 lists from the smoke, and labels a sandbox-off leg weak', () => {
    const r = ratifyGrokLeg(legFor('smoke').input);
    expect(r).toMatchObject({ modelObserved: 'grok-4.7-build', effortObserved: 'low', cwdOk: true, nonceSeen: true, rootMutated: false, enforcement: 'weak' });
    expect(r.toolsOffered.sort()).toEqual([...GROK_READ_TOOLS].sort());
    expect(r.toolsUsed.every((t) => (GROK_READ_TOOLS as readonly string[]).includes(t))).toBe(true);
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.tokensIn).toBeGreaterThan(0);
    expect(r.detail['mcpStarted']).toEqual(['context7']);
    expect(r.checks.find((c) => c.name === 'mcp-started')?.detail).toContain('context7 (source local)');
  });

  it('passes the smoke once the user MCP server is gone', () => {
    const r = ratifyGrokLeg(legFor('smoke', noMcp).input);
    expect(failedNames(r)).toEqual([]);
    expect(r.status).toBe('PASS');
  });

  it('catches the canary reads that ran outside the root, by path, through the symlink and by grep (N9: updates.jsonl rawInput)', () => {
    const r = ratifyGrokLeg(legFor('canary-clean').input);
    const detail = r.checks.find((c) => c.name === 'read-paths')?.detail ?? '';
    expect(detail).toContain('secret.txt (resolves outside the root)');
    expect(detail).toContain('link-out.txt (its realpath leaves the root)');
    expect(detail).toMatch(/grep .*outside/);
  });
});

describe('grok ratification: each check fails on its own (mutation coverage)', () => {
  const cases: Array<[string, (dir: string, session: string) => void, string[], boolean?]> = [
    ['a malformed stream line', (dir) => writeFileSync(join(dir, 'stream.jsonl'), readFileSync(join(dir, 'stream.jsonl'), 'utf8').replace('\n', '\n{not json\n')), ['stream']],
    ['another session id in init', (dir) => edit(join(dir, 'stream.jsonl'), initRow, (r) => (r['session_id'] = '11111111-1111-4111-8111-111111111111')), ['session']],
    ['a missing usage.json', (_d, s) => rmSync(join(s, 'usage.json')), ['session-dir']],
    ['an interactive session', (_d, s) => editJson(join(s, 'summary.json'), (v) => (v['session_kind'] = 'interactive')), ['session-kind']],
    ['a summary cwd outside the root', (_d, s) => editJson(join(s, 'summary.json'), (v) => ((v['info'] as Record<string, unknown>)['cwd'] = '/elsewhere')), ['cwd']],
    ['the fast model served', (_d, s) => editJson(join(s, 'usage.json'), (v) => ((v['session'] as Record<string, unknown>)['primaryModelId'] = 'grok-4.7-build-fast')), ['model']],
    ['another effort on a turn', (_d, s) => edit(join(s, 'chat_history.jsonl'), typeIs('assistant'), (r) => (r['reasoning_effort'] = 'high')), ['effort']],
    ['a shell tool offered', (_d, s) => writeFileSync(join(s, 'tool_definitions.json'), JSON.stringify([...GROK_READ_TOOLS, 'run_terminal_command'].map((name) => ({ type: 'function', function: { name } })))), ['offered']],
    ['permissionMode auto', (dir) => edit(join(dir, 'stream.jsonl'), initRow, (r) => (r['permissionMode'] = 'auto')), ['permission-mode']],
    ['yolo mode on', (_d, s) => edit(join(s, 'events.jsonl'), typeIs('turn_started'), (r) => (r['yolo_mode'] = true)), ['permission-mode']],
    ['the read-only sandbox recorded while the seat asked for off', (_d, s) => editJson(join(s, 'summary.json'), (v) => (v['sandbox_profile'] = 'read-only')), ['sandbox']],
    ['a shell tool started', (_d, s) => writeJsonl(join(s, 'events.jsonl'), [...readJsonl(join(s, 'events.jsonl')), { type: 'tool_started', tool_name: 'run_terminal_command' }]), ['tools-used']],
    [
      'a read of /etc/hosts in updates.jsonl',
      (_d, s) => edit(join(s, 'updates.jsonl'), toolCallRow, (r) => (((r['params'] as Record<string, Record<string, unknown>>)['update'] as Record<string, unknown>)['rawInput'] = { target_file: '/etc/hosts' })),
      ['read-paths'],
    ],
    ['a stream tool use missing from updates.jsonl', (_d, s) => writeJsonl(join(s, 'updates.jsonl'), readJsonl(join(s, 'updates.jsonl')).filter((r) => !JSON.stringify(r).includes('"toolCallId":"call-02343e4e'))), ['read-paths-known']],
    ['an injected instruction file', (_d, s) => editJson(join(s, 'prompt_context.json'), (v) => (v['agents_md_files'] = [{ file_name: 'AGENTS.md', source: 'project' }])), ['instructions']],
    ['a hook that ran', (_d, s) => writeJsonl(join(s, 'updates.jsonl'), [...readJsonl(join(s, 'updates.jsonl')), { method: '_x.ai/session/update', params: { update: { sessionUpdate: 'hook_execution', event_name: 'stop', runs: [{ name: 'project:stop[0]', status: 'ok' }] } } }]), ['hooks']],
    [
      'a project MCP server started',
      (_d, s) =>
        writeJsonl(join(s, 'events.jsonl'), [
          { type: 'mcp_config_resolved', servers: [{ name: 'planted', transport: 'stdio', source: 'mcpJson' }], disabled: [] },
          { type: 'mcp_server_starting', server_name: 'planted', transport: 'stdio' },
          ...readJsonl(join(s, 'events.jsonl')),
        ]),
      ['mcp-project', 'mcp-started'],
    ],
    ['a turn that ended in error', (_d, s) => edit(join(s, 'events.jsonl'), typeIs('turn_ended'), (r) => (r['outcome'] = 'error')), ['outcome']],
    ['an error result subtype', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('result'), (r) => (r['subtype'] = 'error_during_execution')), ['result']],
    [
      'no answer at all',
      (dir) => {
        edit(join(dir, 'stream.jsonl'), typeIs('result'), (r) => (r['result'] = ''));
        edit(join(dir, 'stream.jsonl'), typeIs('assistant'), (r) => {
          const m = r['message'] as { content: Array<Record<string, unknown>> };
          m.content = m.content.filter((b) => b['type'] !== 'text');
        });
      },
      ['answer', 'nonce'],
    ],
    ['the nonce on the second line', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('result'), (r) => (r['result'] = `Review.\n${String(r['result'])}`)), ['nonce']],
    ['a mutated root', () => undefined, ['root-unchanged'], true],
    ['an earlier snapshot naming an outside path, later rewritten inside (never merged, codex F4)', (_d, s) => insertUpdate(s, (id) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, rawInput: { target_file: '/etc/hosts' } }), true), ['read-paths']],
    ['a read whose own output names an outside file (grok F5)', (_d, s) => insertUpdate(s, (id) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { type: 'ReadFile', FileContent: { absolute_path: '/etc/hosts' } } }), false), ['read-paths']],
    ['a grep output listing an outside match', (_d, s) => insertUpdate(s, (id) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: { type: 'GrepSearch', file_matches: [{ path: '/etc/hosts' }] } }), false), ['read-paths']],
    ['a completion of a shell tool (every reported name counts)', (_d, s) => writeJsonl(join(s, 'events.jsonl'), [...readJsonl(join(s, 'events.jsonl')), { type: 'tool_completed', tool_name: 'run_terminal_command', tool_call_id: 'x' }]), ['read-paths-known', 'tools-used']],
    ['a call reported under two tool names', (_d, s) => insertUpdate(s, (id) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, _meta: { 'x.ai/tool': { name: 'grep' } } }), false), ['tools-used']],
    [
      'a shell call only updates.jsonl reports (no stream use, no started or completed event)',
      (_d, s) =>
        writeJsonl(join(s, 'updates.jsonl'), [
          ...readJsonl(join(s, 'updates.jsonl')),
          { method: 'session/update', params: { sessionId: 'x', update: { sessionUpdate: 'tool_call', toolCallId: 'call_update_only', title: 'run_terminal_cmd', _meta: { 'x.ai/tool': { name: 'run_terminal_cmd', input: { command: 'ls' } } }, rawInput: { command: 'ls' } } } },
        ]),
      ['read-paths-known', 'tools-used'],
    ],
    ['a stream tool use naming a path updates.jsonl does not', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('assistant'), (r) => {
      for (const b of (r['message'] as { content: Array<Record<string, unknown>> }).content) if (b['type'] === 'tool_use' && b['name'] === 'read_file') b['input'] = { target_file: 'planted/README.md' };
    }), ['read-paths-known']],
    ['a stream tool use whose path cannot be judged', (dir) => edit(join(dir, 'stream.jsonl'), typeIs('assistant'), (r) => {
      for (const b of (r['message'] as { content: Array<Record<string, unknown>> }).content) if (b['type'] === 'tool_use' && b['name'] === 'read_file') b['input'] = { target_file: 42 };
    }), ['read-paths-known']],
  ];
  it.each(cases)('fails on %s', (_what, change, expected, rootMutated) => {
    const r = ratifyGrokLeg(legFor('smoke', (dir, session) => {
      noMcp(dir, session);
      change(dir, session);
    }, rootMutated).input);
    expect(failedNames(r)).toEqual([...expected].sort());
  });

  it('fails closed with no residue sweep', () => {
    const { input } = legFor('smoke', noMcp);
    expect(failedNames(ratifyGrokLeg({ ...input, rootUnchanged: undefined }))).toEqual(['root-unchanged']);
  });

  it('fails a session dir that is not under the root key (a record from another cwd)', () => {
    const { input, session } = legFor('smoke', noMcp);
    const other = join(input.grokHome, 'sessions', encodeURIComponent('/elsewhere'), input.sessionId);
    mkdirSync(join(other, '..'), { recursive: true });
    renameSync(session, other);
    expect(failedNames(ratifyGrokLeg(input))).toEqual(['cwd']);
  });

  it('fails when no session dir exists, as setup, not contaminated', () => {
    const { input, session } = legFor('smoke', noMcp);
    rmSync(session, { recursive: true });
    const r = ratifyGrokLeg(input);
    expect(r.failureClass).toBe('setup');
    expect(failedNames(r)).toContain('session-dir');
    expect(failedNames(r)).not.toContain('cwd');
  });

  it('labels a read-only leg with no MCP pending, and an MCP leg weak (N1)', () => {
    const { input } = legFor('smoke', (dir, s) => {
      noMcp(dir, s);
      editJson(join(s, 'summary.json'), (v) => (v['sandbox_profile'] = 'read-only'));
    });
    expect(ratifyGrokLeg({ ...input, sandbox: 'read-only' }).enforcement).toBe('pending');
    expect(grokLabel('1.0.70', 'read-only', true)).toBe('weak');
    expect(grokLabel('1.0.70', 'off', false)).toBe('weak');
    expect(grokLabel('9.9.9', 'read-only', false)).toBe('weak');
  });
});

describe('grok helpers', () => {
  it('maps a requested model to its served id, never to the fast model', () => {
    expect(grokModelMatches('grok-4.7-build', 'grok-4.7')).toBe(true);
    expect(grokModelMatches('grok-4.7', 'grok-4.7')).toBe(true);
    expect(grokModelMatches('grok-4.7-build-fast', 'grok-4.7')).toBe(false);
    expect(grokModelMatches('grok-4.7-build-fast', 'grok-4.7-build-fast')).toBe(true);
  });

  it('reads grok models and the effort menu', () => {
    expect(parseGrokModels('You are logged in with grok.com.\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n')).toEqual({ loggedIn: true, models: ['grok-4.7', 'grok-4.6'] });
    expect(parseGrokModels('You are not logged in.').loggedIn).toBe(false);
    const cache = JSON.stringify({ models: { 'grok-4.7': { info: { id: 'grok-4.7', reasoning_efforts: [{ id: 'high' }, { id: 'low' }] } } } });
    expect(grokEffortMenu(cache, 'grok-4.7')).toEqual(['high', 'low']);
    expect(grokEffortMenu(cache, 'grok-4.5')).toBeNull();
  });

  /** A recorded inspect output with its placeholders back to absolute paths, as grok prints them. */
  const inspectFixture = (name: string, root: string): string =>
    readFileSync(join(fixtureDir('grok', 'inspect'), name), 'utf8').split('__SC_ROOT__').join(root).split('__SC_GROK_HOME__').join('/home/user/.grok');

  it('reads the recorded inspect outputs: a user MCP server, and the planted root items', () => {
    const root = '/sc/root';
    const clean = parseGrokInspect(inspectFixture('clean.json', root), root);
    expect(clean.mcpServers.map((m) => m.name)).toEqual(['context7']);
    expect(clean.fromRoot).toEqual([]);
    const planted = parseGrokInspect(inspectFixture('planted.json', root), root);
    expect(planted.mcpServers.map((m) => m.name).sort()).toEqual(['context7', 'planted', 'plantedgrok']);
    expect(planted.fromRoot).toEqual([`MCP server planted (${root}/.mcp.json)`, `project config ${root}/.grok/config.toml`]);
    expect(parseGrokInspect('not json', root).problem).toContain('did not print JSON');
    // A path printed relative is relative to the cwd, the root (grok F7): it counts as loaded from the root.
    const relative = JSON.parse(inspectFixture('planted.json', root)) as { mcpServers: Array<{ source: { path: string } }> };
    for (const m of relative.mcpServers) if (m.source.path.startsWith(root)) m.source.path = m.source.path.slice(root.length + 1);
    expect(parseGrokInspect(JSON.stringify(relative), root).fromRoot).toContain('MCP server planted (.mcp.json)');
  });
});

describe('grok failure classifier (4.4)', () => {
  it.each([
    ['Error: Internal error: { "message": "API error (status 402 Payment Required): Grok Build usage balance exhausted", "http_status": 402 }', 'usage_limit'],
    ['Not signed in', 'auth'],
    ["Couldn't set model 'does-not-exist-model': Invalid params: \"unknown model id\". Run 'grok models' to see available models.", 'model'],
    ['API error (status 500 Internal Server Error): The model is currently at capacity due to high demand.', 'capacity'],
    ["error: could not apply the 'read-only' sandbox profile; see the warning above for the cause. Refusing to start with its protections missing.", 'setup'],
    ['error_max_turns', 'timeout'],
  ])('%s -> %s', (text, cls) => {
    expect(classifyGrokText([text])).toBe(cls);
  });

  it('never reads the answer', () => {
    expect(classifyGrokText(['the review mentions status 402 and Not signed in'].slice(1))).toBeNull();
  });
});

describe('grok launch', () => {
  it('builds the working leg command: allowlist, deny rules, switches, the seat sandbox, prompt file', () => {
    const args = grokArgs({ briefFile: '/leg/BRIEF.md', root: '/root', sessionId: 's', model: 'grok-4.7', effort: 'low', sandbox: 'off', maxTurns: 30 });
    expect(args.slice(0, 10)).toEqual(['--prompt-file', '/leg/BRIEF.md', '--cwd', '/root', '-s', 's', '-m', 'grok-4.7', '--effort', 'low']);
    expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-messages-json');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--tools') + 1]).toBe('read_file,grep,list_dir');
    expect(args.filter((a, i) => args[i - 1] === '--deny')).toEqual([...GROK_DENY_RULES]);
    for (const s of ['--disable-web-search', '--no-subagents', '--no-plan', '--no-memory', '--no-auto-update', '--no-wait-for-background']) expect(args).toContain(s);
    expect(args[args.indexOf('--sandbox') + 1]).toBe('off');
    expect(args).not.toContain('--allow');
    expect(args).not.toContain('--always-approve');
  });

  it('isolates HOME per leg; the login route keeps the user grok home, the API-key route gets an empty one', () => {
    const files = grokLegFiles('/leg');
    expect(legGrokHome({ HOME: '/u' }, files)).toEqual({ grokHome: '/u/.grok', route: 'login' });
    expect(legGrokHome({ HOME: '/u', GROK_HOME: '/g' }, files)).toEqual({ grokHome: '/g', route: 'login' });
    expect(legGrokHome({ HOME: '/u', XAI_API_KEY: 'x' }, files)).toEqual({ grokHome: '/leg/grok-home', route: 'api-key' });
    const env = grokEnv({ HOME: '/u', PATH: '/bin', SECRET: 'no', XAI_API_KEY: 'k' }, files.home, '/g');
    expect(env).toMatchObject({ HOME: '/leg/home', GROK_HOME: '/g', GROK_DISABLE_AUTOUPDATER: '1', GROK_MEMORY: '0', GROK_SUBAGENTS: '0', GROK_WEB_FETCH: '0', PATH: '/bin' });
    expect(env['SECRET']).toBeUndefined();
  });
});

// ---- preflight through a scripted runner (no CLI) ----

function out(stdout: string, exitCode = 0, stderr = ''): CommandResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false, durationMs: 1, error: null };
}

function preflightRunner(options: { inspect?: string; models?: string; version?: string } = {}): { run: CommandRunner; calls: Array<{ args: string[]; env: Readonly<Record<string, string>>; cwd: string }> } {
  const calls: Array<{ args: string[]; env: Readonly<Record<string, string>>; cwd: string }> = [];
  const run: CommandRunner = async (_cmd, args, o) => {
    calls.push({ args: [...args], env: o.env, cwd: o.cwd });
    if (args[0] === '--version') return out(`grok ${options.version ?? '1.0.70'} (f50904eaee6c) [stable]\n`);
    if (args[0] === 'models') return out(options.models ?? 'You are logged in with grok.com.\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n');
    if (args[0] === 'inspect') return out(options.inspect ?? JSON.stringify(isolatedInspect()));
    return out('', 2, 'unexpected');
  };
  return { run, calls };
}

function isolatedInspect(): Record<string, unknown> {
  const v = JSON.parse(readFileSync(join(fixtureDir('grok', 'inspect'), 'clean.json'), 'utf8')) as Record<string, unknown>;
  v['mcpServers'] = [];
  return v;
}

function preflightFor(o: Partial<Occupant>, options: { inspect?: string; models?: string; version?: string; env?: NodeJS.ProcessEnv; allowRules?: string[]; dockerSocket?: string; root?: string } = {}) {
  const userHome = scratch('sc-grok-user-');
  mkdirSync(join(userHome, '.grok'));
  writeFileSync(join(userHome, '.grok', 'models_cache.json'), JSON.stringify({ models: { 'grok-4.7': { info: { id: 'grok-4.7', reasoning_efforts: [{ id: 'low' }, { id: 'high' }] } } } }));
  const root = options.root ?? scratch('sc-grok-root-');
  const legDir = scratch('sc-grok-leg-');
  const r = preflightRunner(options);
  const noSocket = join(root, 'no-socket');
  const p = grokPreflight({ backend: 'grok', model: 'grok-4.7', effort: 'low', sandbox: 'off', ...o }, {
    bin: 'grok',
    runner: r.run,
    env: options.env ?? { HOME: userHome, PATH: '/usr/bin' },
    root,
    legDir,
    allowRules: options.allowRules,
    dockerSocket: options.dockerSocket ?? noSocket,
  });
  return { p, calls: r.calls, userHome, legDir, root };
}

describe('grok preflight (4.3), no model call', () => {
  it('passes with an isolated inspect: HOME is the leg home, inspect runs from the root, sandbox off is weak', async () => {
    const { p, calls, legDir, root } = preflightFor({});
    const pre = await p;
    expect(pre.ok).toBe(true);
    expect(pre.enforcement).toBe('weak');
    expect(calls.map((c) => c.args[0])).toEqual(['--version', 'models', 'inspect']);
    expect(calls.every((c) => c.env['HOME'] === join(legDir, 'home'))).toBe(true);
    expect(calls.find((c) => c.args[0] === 'inspect')?.cwd).toBe(root);
  });

  it('labels read-only with no MCP pending (N1)', async () => {
    expect((await preflightFor({ sandbox: 'read-only' }).p).enforcement).toBe('pending');
  });

  it('refuses a leg whose grok config would start an MCP server, naming it (owner ruling)', async () => {
    const pre = await preflightFor({}, { inspect: readFileSync(join(fixtureDir('grok', 'inspect'), 'clean.json'), 'utf8') }).p;
    expect(pre.ok).toBe(false);
    expect(pre.failureClass).toBe('setup');
    expect(pre.reason).toContain('context7');
    expect(pre.enforcement).toBe('weak');
  });

  it('refuses a planted root and reports what grok would load from it (doctor --deep)', async () => {
    const root = scratch('sc-grok-planted-');
    const { p } = preflightFor({}, { inspect: readFileSync(join(fixtureDir('grok', 'inspect'), 'planted.json'), 'utf8').split('__SC_ROOT__').join(root).split('__SC_GROK_HOME__').join('/home/user/.grok'), root });
    const pre = await p;
    expect(pre.ok).toBe(false);
    expect(pre.data['loaded']).toEqual([`MCP server planted (${root}/.mcp.json)`, `project config ${root}/.grok/config.toml`]);
    expect(String(pre.data['dumped'])).toContain('grok inspect --json');
  });

  it('refuses read-only beside a Docker Desktop socket symlink, naming the fix', async () => {
    const dir = scratch('sc-grok-sock-');
    symlinkSync(join(dir, 'target.sock'), join(dir, 'docker.sock'));
    const pre = await preflightFor({ sandbox: 'read-only' }, { dockerSocket: join(dir, 'docker.sock') }).p;
    expect(pre.ok).toBe(false);
    expect(pre.reason).toContain('sandbox cannot start');
    expect(pre.checks.find((c) => c.name === 'sandbox')?.detail).toContain('sandbox = "off"');
  });

  it.each([
    ['not logged in', { models: 'You are not logged in.\n' }, 'auth'],
    ['a model the account does not list', { models: 'You are logged in with grok.com.\n  * grok-4.6\n' }, 'model'],
    ['a version below the floor', { version: '1.0.60' }, 'setup'],
  ])('refuses %s', async (_what, options, cls) => {
    expect((await preflightFor({}, options).p).failureClass).toBe(cls);
  });

  it('refuses an effort outside the model menu, and a seat with no effort', async () => {
    expect((await preflightFor({ effort: 'max' }).p).failureClass).toBe('model');
    expect((await preflightFor({ effort: undefined }).p).failureClass).toBe('setup');
  });

  it('refuses planted allow rules (the canary)', async () => {
    const pre = await preflightFor({}, { allowRules: ['Read(/**)'] }).p;
    expect(pre.ok).toBe(false);
    expect(pre.reason).toBe('allow rules planted');
  });

  it('runs on the seat auth_home as GROK_HOME (owner ruling): its own login and config, XAI_API_KEY not passed', async () => {
    const own = scratch('sc-grok-own-');
    const { p, calls } = preflightFor({ authHome: own }, { env: { HOME: '/nonexistent', PATH: '/usr/bin', XAI_API_KEY: 'never-read' } });
    const pre = await p;
    expect(pre.ok, pre.reason ?? '').toBe(true);
    expect(pre.data).toMatchObject({ route: 'auth_home', grokHome: own });
    expect(calls.every((c) => c.env['GROK_HOME'] === own && c.env['XAI_API_KEY'] === undefined)).toBe(true);
    expect(pre.checks.find((c) => c.name === 'home')?.detail).toContain("the seat's auth_home");
  });

  it('names the login command for the seat auth_home when it holds no login, and refuses a missing auth_home', async () => {
    const own = scratch('sc-grok-own-');
    const pre = await preflightFor({ authHome: own }, { models: 'You are not logged in.\n' }).p;
    expect(pre.failureClass).toBe('auth');
    expect(pre.checks.find((c) => c.name === 'auth')?.detail).toContain(`GROK_HOME=${own} grok login`);
    expect((await preflightFor({ authHome: join(own, 'missing') }).p).reason).toBe('auth_home is not a directory');
  });

  it('refuses an auth_home whose grok config would start an MCP server', async () => {
    const own = scratch('sc-grok-own-');
    const pre = await preflightFor({ authHome: own }, { inspect: readFileSync(join(fixtureDir('grok', 'inspect'), 'clean.json'), 'utf8') }).p;
    expect(pre.ok).toBe(false);
    expect(pre.reason).toContain('context7');
  });

  it('takes the API-key route with an empty grok home of its own', async () => {
    const { p, legDir } = preflightFor({}, { env: { HOME: '/nonexistent', XAI_API_KEY: 'never-read', PATH: '/usr/bin' } });
    const pre = await p;
    expect(pre.ok).toBe(true);
    expect(pre.data['route']).toBe('api-key');
    expect(pre.data['grokHome']).toBe(join(legDir, 'grok-home'));
  });
});

// ---- end to end through a fake grok binary ----

const FAKE_GROK = new URL('./fixtures/bin/fake-grok.mjs', import.meta.url).pathname;

describe('grok end to end, through a fake CLI', () => {
  it('runs a leg: preflight, launch, record-based done, collect from the nonce, ratify, copy the session', async () => {
    const userHome = scratch('sc-grok-e2e-');
    const grokHome = join(userHome, '.grok');
    mkdirSync(grokHome);
    const fixture = materialize('grok', 'smoke');
    noMcp('', join(fixture.dir, 'session'));
    const c = caseOf('smoke');
    const inspect = join(userHome, 'inspect.json');
    writeFileSync(inspect, JSON.stringify(isolatedInspect()));
    writeFileSync(join(grokHome, 'fake-grok.json'), JSON.stringify({ fixture: fixture.dir, sessionId: c.sessionId, inspect }));
    // The fixture's paths name its own root; the leg's root is the materialized one.
    const root = fixture.root;
    const legDir = scratch('sc-grok-leg-');
    const briefFile = join(legDir, 'BRIEF.md');
    writeFileSync(briefFile, 'brief');
    const ctx: RoundCtx = { root, legDir, nonce: c.nonce, briefFile, timeoutMs: 30_000, env: { HOME: userHome, PATH: process.env['PATH'] ?? '' }, rootUnchanged: () => ({ unchanged: true, changes: [] }) };
    const adapter = createGrokAdapter({ bin: FAKE_GROK, dockerSocket: join(userHome, 'none') });
    const o: Occupant = { backend: 'grok', model: 'grok-4.7', effort: 'low', sandbox: 'off' };
    const pre = await adapter.preflight(o, ctx);
    expect(pre.ok, pre.reason ?? '').toBe(true);
    const h = await adapter.launch(o, ctx, pre);
    for (;;) {
      const s = await adapter.poll(h);
      if (s.status === 'done') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const text = await adapter.collect(h);
    expect(text.fromNonce).toBe(true);
    const r = await adapter.ratify(h, ctx);
    expect(failedNames(r)).toEqual([]);
    expect(adapter.classify(h)).toBeNull();
    expect(existsSync(join(legDir, 'session', 'summary.json'))).toBe(true);
    const argv = JSON.parse(readFileSync(join(grokHome, 'grok-argv.json'), 'utf8')) as { env: string[]; home: string; cwd: string };
    expect(argv.home).toBe(join(legDir, 'home'));
    expect(argv.cwd).toBe(root);
    expect(argv.env).toContain('GROK_HOME');
    expect(readdirSync(join(legDir, 'home'))).toEqual([]);
  });

  it('kills a leg that never starts (a sign-in wait) and classifies it auth', async () => {
    const userHome = scratch('sc-grok-hang-');
    const grokHome = join(userHome, '.grok');
    mkdirSync(grokHome);
    const fixture = materialize('grok', 'smoke');
    writeFileSync(join(grokHome, 'fake-grok.json'), JSON.stringify({ fixture: fixture.dir, sessionId: caseOf('smoke').sessionId, hang: true }));
    const legDir = scratch('sc-grok-leg-');
    writeFileSync(join(legDir, 'BRIEF.md'), 'brief');
    const ctx: RoundCtx = { root: fixture.root, legDir, nonce: 'c0ffee000001', briefFile: join(legDir, 'BRIEF.md'), timeoutMs: 30_000, env: { HOME: userHome, PATH: process.env['PATH'] ?? '' } };
    const adapter = createGrokAdapter({ bin: FAKE_GROK, startupMs: 300 });
    const o: Occupant = { backend: 'grok', model: 'grok-4.7', effort: 'low', sandbox: 'off' };
    const started = Date.now();
    const h = await adapter.launch(o, ctx, { ok: true, backend: 'grok', cliVersion: '1.0.70', enforcement: 'weak', checks: [], userOwned: [], failureClass: null, reason: null, data: {} });
    for (;;) {
      if ((await adapter.poll(h)).status === 'done') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(adapter.classify(h)).toBe('auth');
  });
});
