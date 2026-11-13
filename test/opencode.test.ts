import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executed, readAcpLog } from '../src/adapters/acp/log.js';
import {
  OPENCODE_AGENT,
  OPENCODE_DENIED_ACTIONS,
  OPENCODE_READS,
  canonical,
  classifyOpencodeText,
  createOpencodeAdapter,
  evaluateRules,
  familyOf,
  judgeConfigSources,
  judgeCouncilAgent,
  opencodeConfig,
  opencodeDenial,
  opencodeEnv,
  opencodeLegFiles,
  opencodePreflight,
  parseOpencodeModels,
  readOpencodeRecord,
} from '../src/adapters/opencode/index.js';
import type { LegHandle, Occupant, Ratification, RoundCtx } from '../src/adapters/types.js';
import { sqlite } from '../src/store/sqlite.js';
import type { CommandResult, CommandRunner } from '../src/transport/headless.js';
import { FAKE_ACP, recordedSession } from './helpers/acp.js';
import { cleanScratchAfterAll, fixtureDir, materialize, scratch } from './helpers/fixtures.js';

cleanScratchAfterAll();

interface CaseFile {
  nonce: string;
  model: string;
  effort: string | null;
  cliVersion: string;
  rootMutated: boolean;
  plantSymlink: boolean;
  expect: { status: string; failureClass: string | null; failed: string[] };
}

type Rows = Record<string, Array<Record<string, unknown>>>;

const caseOf = (name: string): CaseFile => JSON.parse(readFileSync(join(fixtureDir('opencode', name), 'case.json'), 'utf8')) as CaseFile;
const failedNames = (r: Ratification): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();

/** The tables the ratifier reads, with opencode 2.2.7's own column lists (from its migrations). */
const DDL = `
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text, parent_id text, fork_session_id text, fork_boundary text, slug text NOT NULL, directory text NOT NULL, path text, title text, version text NOT NULL, share_url text, summary_additions integer, summary_deletions integer, summary_files integer, summary_diffs text, metadata text, cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL, tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL, tokens_cache_write integer DEFAULT 0 NOT NULL, revert text, permission text, agent text, model text, time_created integer NOT NULL, time_updated integer NOT NULL, time_busy integer, time_idle integer, time_viewed integer, idle_outcome text, time_compacting integer, time_archived integer, time_suspended integer, resume_attempts integer DEFAULT 0 NOT NULL);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE session_part (message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL, call_id text, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL, PRIMARY KEY (message_id, ordinal));
CREATE TABLE instruction_entry (session_id text NOT NULL, key text NOT NULL, value text, removed integer DEFAULT false NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, PRIMARY KEY (session_id, key));
`;

function writeDb(path: string, rows: Rows): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const db = new (sqlite().DatabaseSync)(path);
  try {
    db.exec(DDL);
    for (const [table, list] of Object.entries(rows)) {
      for (const row of list) {
        const cols = Object.keys(row);
        db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c] as string | number | null));
      }
    }
  } finally {
    db.close();
  }
}

const dataOf = (row: Record<string, unknown>): Record<string, unknown> => JSON.parse(String(row['data'])) as Record<string, unknown>;
const withData = (row: Record<string, unknown>, change: (d: Record<string, unknown>) => void): void => {
  const d = dataOf(row);
  change(d);
  row['data'] = JSON.stringify(d);
};

/** A recorded leg as a handle the adapter can ratify: the fixture with real paths and the database rebuilt. */
function replay(name: string, edit?: (rows: Rows, sid: string) => void): { handle: LegHandle; ctx: RoundCtx; c: CaseFile; dir: string } {
  const c = caseOf(name);
  const { dir, root } = materialize('opencode', name);
  if (c.plantSymlink) symlinkSync(join(dirname(root), 'outside', 'secret.txt'), join(root, 'link-out.txt'));
  const rows = JSON.parse(readFileSync(join(dir, 'db.json'), 'utf8')) as Rows;
  const sid = recordedSession(dir);
  edit?.(rows, sid);
  writeDb(opencodeLegFiles(dir).db, rows);
  const exit = (JSON.parse(readFileSync(join(dir, 'process.json'), 'utf8')) as { exit: LegHandle['exit'] }).exit;
  const handle: LegHandle = {
    backend: 'opencode',
    occupant: { backend: 'opencode', model: c.model, effort: c.effort ?? undefined },
    legDir: dir,
    root,
    nonce: c.nonce,
    startedAt: new Date(),
    process: null,
    exit,
    files: { log: join(dir, 'updates.jsonl'), stderr: join(dir, 'stderr.log'), process: join(dir, 'process.json') },
    data: { expect: [{ id: 'mode', value: OPENCODE_AGENT, check: 'mode' }, { id: 'model', value: c.model, check: 'model' }], cliVersion: c.cliVersion },
  };
  const ctx: RoundCtx = { root, legDir: dir, nonce: c.nonce, briefFile: '/dev/null', timeoutMs: 1000, rootUnchanged: () => ({ unchanged: !c.rootMutated, changes: [] }) };
  return { handle, ctx, c, dir };
}

const adapter = createOpencodeAdapter();

describe('opencode replay: the recorded live legs (free model, over ACP)', () => {
  it.each(['smoke', 'canary-clean', 'canary-planted'])('%s ratifies to its recorded verdict', async (name) => {
    const { handle, ctx, c } = replay(name);
    const r = await adapter.ratify(handle, ctx);
    expect({ status: r.status, failureClass: r.failureClass, failed: failedNames(r) }).toEqual({ status: c.expect.status, failureClass: c.expect.failureClass, failed: [...c.expect.failed].sort() });
  });

  it('records the model, the tools and the totals from the database, and labels it pending', async () => {
    const { handle, ctx } = replay('smoke');
    const r = await adapter.ratify(handle, ctx);
    expect(r).toMatchObject({ status: 'PASS', modelObserved: 'opencode/big-pickle', cliVersion: '2.2.7', enforcement: 'pending', nonceSeen: true, cwdOk: true });
    expect(r.tokensIn).toBeGreaterThan(0);
    expect(r.toolsUsed.every((t) => ['read', 'glob', 'grep'].includes(t))).toBe(true);
  });

  it('counts the reads opencode refused itself as not run, and catches the read through the symlink (measured)', async () => {
    const { handle, ctx } = replay('canary-clean');
    const r = await adapter.ratify(handle, ctx);
    const detail = r.checks.find((c) => c.name === 'read-paths')?.detail ?? '';
    expect(detail).toContain('link-out.txt its realpath leaves the root');
    expect(detail).not.toContain('outside/secret.txt');
    const log = readAcpLog(handle.files['log'] ?? '');
    const refused = [...log.toolCalls.values()].filter((call) => call.snapshots.some(opencodeDenial));
    expect(refused.length).toBe(3);
    expect(refused.every((call) => !executed(call, OPENCODE_READS.denialNotice))).toBe(true);
    // The recorded denials, in the database too.
    const tools = r.detail['tools'] as Array<{ status: string; error: string | null }>;
    expect(tools.filter((t) => t.status === 'error').map((t) => t.error)).toEqual(Array(3).fill('Permission denied: external_directory'));
  });
});

describe('opencode record checks: each fails on its own (mutation coverage)', () => {
  const session = (rows: Rows, sid: string) => rows['session_v2']?.find((s) => s['id'] === sid) as Record<string, unknown>;
  const firstAssistant = (rows: Rows) => rows['session_message']?.find((m) => m['type'] === 'assistant') as Record<string, unknown>;
  const cases: Array<[string, (rows: Rows, sid: string) => void, string[]]> = [
    ['a missing session row', (rows) => (rows['session_v2'] = []), ['session-record']],
    ['another opencode version', (rows, sid) => (session(rows, sid)['version'] = '2.2.8'), ['record-version']],
    ['a session directory outside the root', (rows, sid) => (session(rows, sid)['directory'] = '/elsewhere'), ['record-directory']],
    ['a step on the build agent', (rows) => withData(firstAssistant(rows), (d) => (d['agent'] = 'build')), ['record-agent']],
    ['a step on another model', (rows) => withData(firstAssistant(rows), (d) => (d['model'] = { providerID: 'opencode', id: 'other-free' })), ['record-model']],
    ['a variant with no effort pinned', (rows) => withData(firstAssistant(rows), (d) => ((d['model'] as Record<string, unknown>)['variant'] = 'high')), ['record-effort']],
    ['a shell tool part', (rows) => withData(firstAssistant(rows), (d) => (d['content'] as unknown[]).push({ type: 'tool', id: 'x', name: 'shell', state: { status: 'completed', input: { command: 'echo' }, content: [] } })), ['record-tools']],
    [
      'a user shell message',
      (rows, sid) => rows['session_message']?.push({ id: 'msg_shell', session_id: sid, type: 'shell', seq: 999, time_created: 1, time_updated: 1, data: JSON.stringify({ command: 'echo' }) }),
      ['record-messages'],
    ],
    [
      'a child session',
      (rows, sid) => rows['session_v2']?.push({ ...session(rows, sid), id: 'ses_child', parent_id: sid }),
      ['record-children'],
    ],
    ['an injected AGENTS.md', (rows, sid) => (rows['instruction_entry'] = [{ session_id: sid, key: 'file:AGENTS.md', value: JSON.stringify({ path: 'AGENTS.md' }), removed: 0, time_created: 1, time_updated: 1 }]), ['record-instructions']],
    ['a failed turn', (rows, sid) => (session(rows, sid)['idle_outcome'] = 'failed'), ['record-outcome']],
  ];
  it.each(cases)('fails on %s', async (_what, change, expected) => {
    const { handle, ctx } = replay('smoke', change);
    expect(failedNames(await adapter.ratify(handle, ctx))).toEqual([...expected].sort());
  });

  it('fails a second root session in the leg database (one leg, one session)', async () => {
    const { handle, ctx } = replay('smoke', (rows, sid) => rows['session_v2']?.push({ ...session(rows, sid), id: 'ses_other' }));
    expect(failedNames(await adapter.ratify(handle, ctx))).toEqual(['session-record']);
  });

  it('a denied non-read tool part is not a violation; a completed one is', async () => {
    const denied = { type: 'tool', id: 'y', name: 'webfetch', state: { status: 'error', input: {}, error: { type: 'permission.rejected', message: 'Permission denied: webfetch' } } };
    const { handle, ctx } = replay('smoke', (rows) => withData(firstAssistant(rows), (d) => (d['content'] as unknown[]).push(denied)));
    expect(failedNames(await adapter.ratify(handle, ctx))).toEqual([]);
    const other = { ...denied, state: { ...denied.state, error: { type: 'provider.internal', message: 'Permission denied: webfetch (but it ran)' } } };
    const second = replay('smoke', (rows) => withData(firstAssistant(rows), (d) => (d['content'] as unknown[]).push(other)));
    expect(failedNames(await adapter.ratify(second.handle, second.ctx))).toEqual(['record-tools']);
  });

  it('reads the session parts table too', () => {
    const dir = scratch('sc-oc-db-');
    writeDb(join(dir, 'x.db'), {
      session_v2: [{ id: 's', project_id: 'p', slug: 'x', directory: '/r', version: '2.2.7', time_created: 1, time_updated: 1 }],
      session_part: [{ message_id: 'm', session_id: 's', ordinal: 0, type: 'tool', call_id: 'c', time_created: 1, time_updated: 1, data: JSON.stringify({ type: 'tool', name: 'edit', state: { status: 'completed', input: {} } }) }],
    });
    expect(readOpencodeRecord(join(dir, 'x.db'), 's').tools.map((t) => `${t.name}/${t.source}`)).toEqual(['edit/part']);
  });
});

describe('opencode helpers', () => {
  it('evaluates rules last-match-wins, and the council config denies every non-read action', () => {
    const council = (opencodeConfig()['agents'] as Record<string, { permissions: Array<{ action: string; resource: string; effect: string }> }>)[OPENCODE_AGENT]?.permissions ?? [];
    const rules = [{ action: '*', resource: '*', effect: 'allow' }, ...council];
    for (const a of OPENCODE_DENIED_ACTIONS) expect(evaluateRules(rules, a, '*'), a).toBe('deny');
    for (const a of ['read', 'glob', 'grep']) expect(evaluateRules(rules, a, '*')).toBe('allow');
    expect(evaluateRules([], 'read', '*')).toBe('ask');
  });

  it('knows opencode denial notices only on a failed call', () => {
    expect(opencodeDenial({ status: 'failed', rawOutput: { error: 'Permission denied: external_directory' } })).toBe(true);
    expect(opencodeDenial({ status: 'completed', rawOutput: { error: 'Permission denied: external_directory' } })).toBe(false);
    expect(opencodeDenial({ status: 'failed', rawOutput: { error: 'cat: x: Permission denied: yes' } })).toBe(false);
  });

  it('parses models and families', () => {
    expect(parseOpencodeModels('opencode/big-pickle\nanthropic/claude-sonnet-5-5\nnoise\n')).toEqual(['opencode/big-pickle', 'anthropic/claude-sonnet-5-5']);
    expect(familyOf('anthropic/claude-sonnet-5-5')).toBe('anthropic');
    expect(familyOf('opencode/deepseek-v4.1-flash-free')).toBe('deepseek');
    expect(familyOf('openrouter/openai/gpt-5.5')).toBe('openai');
  });

  it('builds the leg environment: own XDG dirs and database, PWD = root, HOME isolated, the council config, loopback kept off any proxy', () => {
    const files = opencodeLegFiles('/leg');
    const env = opencodeEnv({ PATH: '/bin', HOME: '/u', ANTHROPIC_API_KEY: 'k', SECRET: 'no', NO_PROXY: 'corp' }, files, '/root', false);
    expect(env).toMatchObject({
      HOME: '/leg/opencode/home',
      PWD: '/root',
      XDG_CONFIG_HOME: '/leg/opencode/config',
      XDG_DATA_HOME: '/leg/opencode/data',
      OPENCODE_DB: '/leg/opencode/opencode.db',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      ANTHROPIC_API_KEY: 'k',
      NO_PROXY: 'corp,localhost,127.0.0.1,::1',
    });
    expect(env['SECRET']).toBeUndefined();
    expect(env['OPENCODE_CONFIG']).toBeUndefined();
    expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT'] ?? '{}')).toEqual(opencodeConfig());
    expect(opencodeEnv({}, files, '/root', true)['OPENCODE_CONFIG']).toBe('/leg/opencode/planted.json');
  });
});

describe('opencode failure classifier (4.4)', () => {
  it.each([
    ['Internal error {"errorName":"provider.free-limit"} Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.', 'usage_limit'],
    ['provider.auth: 401', 'auth'],
    ['provider.no-route: Model unavailable', 'model'],
    ['Invalid params: effort not found: high', 'model'],
    ['provider.rate-limit', 'capacity'],
    ['database is locked', 'transport'],
  ])('%s -> %s', (text, cls) => {
    expect(classifyOpencodeText([text])).toBe(cls);
  });
});

// ---- preflight through a scripted runner ----

function out(stdout: string, exitCode = 0): CommandResult {
  return { exitCode, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1, error: null };
}

const DEFAULTS = [
  { action: '*', resource: '*', effect: 'allow' },
  { action: 'read', resource: '*.env', effect: 'ask' },
];
const TAIL = [
  { action: 'browser', resource: '*', effect: 'deny' },
  { action: 'skill', resource: 'browser', effect: 'deny' },
];

function councilAgents(extra: Array<Record<string, string>> = []): string {
  const council = (opencodeConfig()['agents'] as Record<string, { permissions: unknown[] }>)[OPENCODE_AGENT]?.permissions ?? [];
  return JSON.stringify([
    { id: 'build', permissions: DEFAULTS },
    { id: OPENCODE_AGENT, permissions: [...DEFAULTS, ...council, ...TAIL, ...extra] },
  ]);
}

interface Script {
  version?: string;
  config?: (configDir: string) => unknown[];
  agents?: string;
  models?: string;
  mcp?: string;
  plugins?: string;
}

function scriptedRunner(s: Script): { run: CommandRunner; calls: Array<{ args: string[]; env: Readonly<Record<string, string>>; cwd: string }> } {
  const calls: Array<{ args: string[]; env: Readonly<Record<string, string>>; cwd: string }> = [];
  const run: CommandRunner = async (_cmd, args, o) => {
    calls.push({ args: [...args], env: o.env, cwd: o.cwd });
    const key = args.filter((a) => !a.startsWith('--')).join(' ');
    const configDir = o.env['XDG_CONFIG_HOME'] ?? '';
    if (args[0] === '--version') return out(`opencode v${s.version ?? '2.2.7'}\n`);
    if (key === 'debug config') return out(JSON.stringify(s.config ? s.config(configDir) : [{ type: 'directory', path: `${configDir}/opencode` }, { type: 'document', info: opencodeConfig() }]));
    if (key === 'debug agents') return out(s.agents ?? councilAgents());
    if (key === 'models') return out(s.models ?? 'opencode/big-pickle\nopencode/beam-free\n');
    if (key === 'mcp list') return out(s.mcp ?? 'No MCP servers configured\n');
    if (key === 'plugin list') return out(s.plugins ?? 'No plugins found\n');
    if (key === 'auth list json') return out('[]');
    return out('', 2);
  };
  return { run, calls };
}

async function preflight(s: Script = {}, o: Partial<Occupant> = {}, extra: { planted?: Record<string, unknown>; plantRoot?: (root: string) => void } = {}) {
  const root = scratch('sc-oc-root-');
  extra.plantRoot?.(root);
  const legDir = scratch('sc-oc-leg-');
  const r = scriptedRunner(s);
  const pre = await opencodePreflight({ backend: 'opencode', model: 'opencode/big-pickle', ...o }, { bin: 'opencode', runner: r.run, env: { PATH: '/bin', HOME: '/u' }, root, legDir, planted: extra.planted });
  return { pre, calls: r.calls, root, legDir };
}

describe('opencode preflight (4.3), no model call', () => {
  it('passes: every command on the leg environment from the root, --standalone, the leg database warmed', async () => {
    const { pre, calls, root, legDir } = await preflight();
    expect(pre.ok, pre.reason ?? '').toBe(true);
    expect(pre.enforcement).toBe('pending');
    expect(calls.map((c) => c.args.join(' '))).toEqual(['--version', 'debug config --standalone', 'debug agents --standalone', 'mcp list --standalone', 'plugin list --standalone', 'models --standalone', 'auth list --format json']);
    expect(calls.every((c) => c.cwd === root && c.env['OPENCODE_DB'] === join(legDir, 'opencode', 'opencode.db') && c.env['PWD'] === root)).toBe(true);
  });

  it('refuses a config source beyond the council document, and reports one from the root (doctor --deep)', async () => {
    const { pre, root } = await preflight({ config: (dir) => [{ type: 'directory', path: `${dir}/opencode` }, { type: 'document', info: opencodeConfig() }] });
    expect(pre.ok).toBe(true);
    const r = scriptedRunner({});
    const legDir = scratch('sc-oc-leg-');
    const bad = await opencodePreflight({ backend: 'opencode', model: 'opencode/big-pickle' }, {
      bin: 'opencode',
      runner: async (cmd, args, o) => (args.join(' ') === 'debug config --standalone' ? out(JSON.stringify([{ type: 'file', path: `${root}/opencode.json` }, { type: 'document', info: opencodeConfig() }])) : r.run(cmd, args, o)),
      env: { PATH: '/bin' },
      root,
      legDir,
    });
    expect(bad.ok).toBe(false);
    expect(bad.data['loaded']).toEqual([`config ${root}/opencode.json`]);
  });

  it('refuses when the config document is not the council one', async () => {
    const changed = { ...opencodeConfig(), policies: [] };
    const { pre } = await preflight({ config: (dir) => [{ type: 'directory', path: `${dir}/opencode` }, { type: 'document', info: changed }] });
    expect(pre.ok).toBe(false);
    expect(pre.reason).toContain('council config document');
  });

  it.each([
    ['a council agent that allows skill', { agents: councilAgents([{ action: 'skill', resource: '*', effect: 'allow' }]) }, 'skill is allow'],
    ['no council agent', { agents: JSON.stringify([{ id: 'build', permissions: DEFAULTS }]) }, 'no council agent'],
    ['an MCP server', { mcp: 'github  connected\n' }, 'MCP servers configured'],
    ['a plugin', { plugins: 'x-plugin\n' }, 'plugins configured'],
  ])('refuses %s', async (_what, s, reason) => {
    const { pre } = await preflight(s);
    expect(pre.ok).toBe(false);
    expect(pre.failureClass).toBe('setup');
    expect(`${pre.reason ?? ''} ${pre.checks.map((c) => c.detail).join(' ')}`).toContain(reason);
  });

  it('separates a missing credential (auth) from a missing model (model)', async () => {
    expect((await preflight({}, { model: 'anthropic/claude-sonnet-5-5' })).pre.failureClass).toBe('auth');
    expect((await preflight({}, { model: 'opencode/not-a-model' })).pre.failureClass).toBe('model');
  });

  it('refuses a planted config, a root holding agent config, an old version and a bad model id', async () => {
    expect((await preflight({}, {}, { planted: { agents: {} } })).pre.reason).toBe('planted config');
    expect((await preflight({}, {}, { plantRoot: (root) => writeFileSync(join(root, 'AGENTS.md'), 'x') })).pre.reason).toBe('root not sanitized');
    expect((await preflight({ version: '1.19.5' })).pre.failureClass).toBe('setup');
    expect((await preflight({}, { model: 'big-pickle' })).pre.reason).toBe('bad model id');
  });

  it('judges config sources and the agent from their recorded shapes', () => {
    expect(judgeConfigSources('nope', '/c', '/r').problem).toContain('did not print JSON');
    expect(judgeCouncilAgent(councilAgents()).problems).toEqual([]);
    expect(canonical({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });
});

// ---- end to end through the fake ACP agent ----

describe('opencode end to end, through the fake ACP agent', () => {
  async function run(steps: unknown[], o: Partial<Occupant> = {}, kase: Record<string, unknown> = {}) {
    const dir = scratch('sc-oc-e2e-');
    const root = join(dir, 'root');
    const outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret\n');
    const legDir = join(dir, 'leg');
    const files = opencodeLegFiles(legDir);
    mkdirSync(files.home, { recursive: true });
    const nonce = 'c0ffee00000c';
    const sid = 'ses_fake0001';
    const occupant: Occupant = { backend: 'opencode', model: 'opencode/big-pickle', ...o };
    writeFileSync(
      join(files.home, 'fake-acp.json'),
      JSON.stringify({
        sessionId: sid,
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'opencode/beam-free', options: [{ value: 'opencode/big-pickle' }, { value: 'opencode/beam-free' }] },
          { id: 'mode', category: 'mode', currentValue: 'build', options: [{ value: OPENCODE_AGENT }, { value: 'build' }] },
        ],
        steps: [...steps, { text: `NONCE: ${nonce}\nVERDICT: SHIP\n` }],
        ...kase,
      }).split('__ROOT__').join(root).split('__OUTSIDE__').join(outside),
    );
    const briefFile = join(dir, 'BRIEF.md');
    writeFileSync(briefFile, `NONCE: ${nonce}\n`);
    const ctx: RoundCtx = { root, legDir, nonce, briefFile, timeoutMs: 15_000, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/nonexistent' }, rootUnchanged: () => ({ unchanged: true, changes: [] }) };
    const a = createOpencodeAdapter({ bin: FAKE_ACP });
    const h = await a.launch(occupant, ctx, { ok: true, backend: 'opencode', cliVersion: '2.2.7', enforcement: 'pending', checks: [], userOwned: [], failureClass: null, reason: null, data: {} });
    while ((await a.poll(h)).status !== 'done') await new Promise((res) => setTimeout(res, 50));
    writeDb(files.db, {
      session_v2: [{ id: sid, project_id: 'p', slug: 's', directory: root, version: '2.2.7', agent: OPENCODE_AGENT, idle_outcome: 'succeeded', time_created: 1, time_updated: 1 }],
      session_message: [{ id: 'm1', session_id: sid, type: 'assistant', seq: 1, time_created: 1, time_updated: 1, data: JSON.stringify({ agent: OPENCODE_AGENT, model: { providerID: 'opencode', id: 'big-pickle' }, content: [] }) }],
    });
    const r = await a.ratify(h, ctx);
    return { r, h, files, root, outside, cls: a.classify(h) };
  }

  it('applies the pins (model, then mode) before the prompt, on the leg environment, and ratifies', async () => {
    const { r, files, h } = await run([]);
    expect(failedNames(r)).toEqual([]);
    const argv = JSON.parse(readFileSync(join(files.home, 'fake-acp-argv.json'), 'utf8')) as { args: string[]; env: string[]; cwd: string };
    expect(argv.args).toEqual(['acp']);
    for (const name of ['PWD', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_DB', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_DISABLE_CLAUDE_CODE', 'OPENCODE_DISABLE_AUTOUPDATE']) expect(argv.env).toContain(name);
    const sets = readAcpLog(h.files['log'] ?? '').rpcs.filter((x) => x.method === 'session/set_config_option').map((x) => `${String(x.params['configId'])}=${String(x.params['value'])}`);
    expect(sets).toEqual(['model=opencode/big-pickle', 'mode=council']);
  });

  it('does not count an outside read opencode refused itself (failed, Permission denied) as run', async () => {
    const { r } = await run([
      { update: { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'read', kind: 'read', status: 'pending', rawInput: {} } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'read', status: 'in_progress', rawInput: { path: '__OUTSIDE__/secret.txt' } } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'read', status: 'failed', rawInput: { path: '__OUTSIDE__/secret.txt' }, content: [{ type: 'content', content: { type: 'text', text: 'Permission denied: external_directory' } }], rawOutput: { metadata: {}, error: 'Permission denied: external_directory' } } },
    ]);
    expect(failedNames(r)).toEqual([]);
  });

  it('counts the same failed read as run when its error is anything else (fail closed)', async () => {
    const { r } = await run([
      { update: { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'read', kind: 'read', status: 'pending', rawInput: {} } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'read', status: 'in_progress', rawInput: { path: '__OUTSIDE__/secret.txt' } } },
      { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', kind: 'read', status: 'failed', rawInput: { path: '__OUTSIDE__/secret.txt' }, rawOutput: { error: 'read failed after 10 bytes' } } },
    ]);
    expect(r.status).toBe('CONTAMINATED');
    expect(failedNames(r)).toEqual(['read-paths']);
  });

  it('refuses the session when the effort is not a variant of the model (no prompt sent)', async () => {
    const { r, cls } = await run([], { effort: 'high' });
    expect(failedNames(r)).toContain('refusal');
    expect(r.status).toBe('FAIL');
    expect(cls).not.toBeNull();
    expect(existsSync(join(opencodeLegFiles(join(dirname(r.recordPath ?? ''), '..')).home, 'fake-acp-prompt.json'))).toBe(false);
  });
});
