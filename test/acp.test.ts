import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acpAnswer, readAcpLog } from '../src/adapters/acp/log.js';
import { judgeCall, readOnlyPolicy, str, toolCallPaths, type ReadSet } from '../src/adapters/acp/policy.js';
import { ratifyAcpCommon, type AcpPinExpect } from '../src/adapters/acp/ratify.js';
import { verdictOf } from '../src/adapters/types.js';
import { ACP_CLASS_OF_CHECK, acpFailureClass } from '../src/adapters/acp/ratify.js';
import { startAcp, type AcpExit, type AcpPin } from '../src/transport/acp.js';
import { groupAlive } from '../src/transport/headless.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';

cleanScratchAfterAll();

/*
 * ACP conformance (brief P3 item 2): the real client against a scripted fake agent, then the common ratifier on
 * the update log the client wrote. One case per behaviour the brief names.
 */

const FAKE = new URL('./fixtures/bin/fake-acp-agent.mjs', import.meta.url).pathname;
const NONCE = 'a1b2c3d4e5f6';
const PINS: AcpPin[] = [
  { via: 'set_config_option', configId: 'model', value: 'fake-model' },
  { via: 'set_config_option', configId: 'thought_level', value: 'low' },
  { via: 'set_config_option', configId: 'mode', value: 'default' },
];
const EXPECT: AcpPinExpect[] = [
  { id: 'model', value: 'fake-model', check: 'model' },
  { id: 'thought_level', value: 'low', check: 'effort' },
  { id: 'mode', value: 'default', check: 'mode' },
];
const REVIEW = [{ text: `NONCE: ${NONCE}\nVERDICT: SHIP\n` }];
/** The conformance agent's read tools, by name (agy-shaped: the name in `name`). */
const READS: ReadSet = { kinds: ['read', 'search'], names: ['read_file', 'grep'], nameOf: (s) => str(s['name']), cwdDefault: ['grep'] };

interface Leg {
  dir: string;
  root: string;
  outside: string;
  exit: AcpExit;
  logFile: string;
}

async function runCase(
  kase: Record<string, unknown>,
  opts: {
    timeoutMs?: number;
    pins?: AcpPin[];
    killOn?: RegExp;
    plant?: (root: string, outside: string) => void;
    sessionCwd?: (root: string, outside: string) => string;
    allowAll?: boolean;
    logFileIn?: string;
  } = {},
): Promise<Leg> {
  const dir = opts.logFileIn ?? scratch('sc-acp-');
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'inside.txt'), 'inside\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  opts.plant?.(root, outside);
  const caseFile = join(dir, 'case.json');
  writeFileSync(caseFile, JSON.stringify(kase).split('__ROOT__').join(root).split('__OUTSIDE__').join(outside));
  const home = join(dir, 'home');
  mkdirSync(home);
  const logFile = join(dir, 'updates.jsonl');
  const proc = startAcp({
    command: process.execPath,
    args: [FAKE],
    cwd: root,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, FAKE_ACP_CASE: caseFile },
    logFile,
    stderrFile: join(dir, 'stderr.log'),
    recordFile: join(dir, 'process.json'),
    sessionCwd: opts.sessionCwd?.(root, outside) ?? root,
    promptText: `NONCE: ${NONCE}\nreview`,
    pins: opts.pins ?? PINS,
    onPermission: opts.allowAll ? () => ({ allow: true, why: 'a broken policy (test)' }) : readOnlyPolicy(root, READS),
    timeoutMs: opts.timeoutMs ?? 15_000,
    killGraceMs: 300,
    cancelGraceMs: 300,
    exitGraceMs: 500,
    killOn: opts.killOn,
  });
  const exit = await proc.exited;
  return { dir, root, outside, exit, logFile };
}

function ratify(leg: Leg, unchanged = true) {
  const r = ratifyAcpCommon({
    logFile: leg.logFile,
    root: leg.root,
    nonce: NONCE,
    pins: EXPECT,
    reads: READS,
    transportError: leg.exit.recordError,
    timedOut: leg.exit.timedOut,
    rootUnchanged: () => ({ unchanged, changes: [] }),
  });
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name).sort();
  const cls = acpFailureClass(failed, ACP_CLASS_OF_CHECK, null, leg.exit.timedOut);
  return { ...r, failed, cls, status: verdictOf(r.checks, cls).status };
}

const read = (id: string, path: string, ask = true) => ({ tool: { toolCallId: id, name: 'read_file', title: `Read ${path}`, kind: 'read', rawInput: { path }, locations: [{ path }] }, ask });

describe('ACP conformance against the fake agent', () => {
  it('a clean read-only review: in-root read allowed, answer ratifies', async () => {
    const leg = await runCase({ steps: [read('t1', '__ROOT__/inside.txt'), ...REVIEW] });
    const r = ratify(leg);
    expect(r.failed).toEqual([]);
    expect(r.status).toBe('PASS');
    expect(leg.exit.doneBy).toBe('record');
    expect(r.log.permissions.map((p) => p.decision)).toEqual(['allow']);
    expect(r.log.permissions[0]?.option).toBe('allow_once');
    // The session was opened with the root and no MCP servers, and the client declared no capabilities.
    const init = r.log.initialize?.params as { clientCapabilities: { fs: Record<string, boolean>; terminal: boolean } };
    expect(init.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    expect(r.log.sessionNew?.params).toMatchObject({ cwd: leg.root, mcpServers: [] });
    expect(r.answer?.startsWith(`NONCE: ${NONCE}`)).toBe(true);
  });

  it('a permission asked and refused: an outside read by path is rejected, and the leg still ratifies', async () => {
    const leg = await runCase({ steps: [read('t1', '__OUTSIDE__/secret.txt'), ...REVIEW] });
    const r = ratify(leg);
    expect(r.log.permissions.map((p) => [p.decision, p.option])).toEqual([['reject', 'reject_once']]);
    expect(r.log.permissions[0]?.why).toContain('resolves outside the root');
    expect(r.failed).toEqual([]);
    expect(r.log.toolCalls.get('t1')?.statuses).toEqual(['pending', 'failed']);
  });

  it('a write asked: refused, never an always option', async () => {
    const leg = await runCase({
      steps: [{ tool: { toolCallId: 'w1', name: 'write_file', title: 'Write CANARY.txt', kind: 'edit', rawInput: { path: '__ROOT__/CANARY.txt', content: 'x' } }, ask: true }, ...REVIEW],
    });
    const r = ratify(leg);
    expect(r.log.permissions.map((p) => [p.decision, p.option])).toEqual([['reject', 'reject_once']]);
    expect(r.log.permissions[0]?.why).toContain('kind edit is not a read');
    expect(r.failed).toEqual([]);
  });

  it('a tool executed without asking ratifies contaminated', async () => {
    const leg = await runCase({ steps: [{ tool: { toolCallId: 'x1', name: 'run_command', title: 'Run echo canary', kind: 'execute', rawInput: { command: 'echo canary' } }, ask: false }, ...REVIEW] });
    const r = ratify(leg);
    expect(r.failed).toEqual(['tools-used']);
    expect(r.status).toBe('CONTAMINATED');
    expect(r.cls).toBe('contaminated');
    expect(r.unasked).toEqual([{ id: 'x1', title: 'Run echo canary', kinds: ['execute'] }]);
  });

  it('an outside read that ran with no request (a user rule) ratifies contaminated, by path', async () => {
    const leg = await runCase({ steps: [read('t1', '__OUTSIDE__/secret.txt', false), ...REVIEW] });
    const r = ratify(leg);
    expect(r.failed).toEqual(['read-paths']);
    expect(r.status).toBe('CONTAMINATED');
  });

  it('a read through a symlink that leaves the root is rejected when asked, and contaminated when it ran unasked', async () => {
    const plant = (root: string, outside: string): void => symlinkSync(join(outside, 'secret.txt'), join(root, 'link-out.txt'));
    const asked = await runCase({ steps: [read('t1', '__ROOT__/link-out.txt'), ...REVIEW] }, { plant });
    const a = ratify(asked);
    expect(a.log.permissions[0]?.decision).toBe('reject');
    expect(a.log.permissions[0]?.why).toContain('its realpath leaves the root');
    expect(a.failed).toEqual([]);
    const unasked = await runCase({ steps: [read('t1', 'link-out.txt', false), ...REVIEW] }, { plant });
    const u = ratify(unasked);
    expect(u.failed).toEqual(['read-paths']);
    expect(u.status).toBe('CONTAMINATED');
  });

  it('a mode the agent does not accept: the session is refused and no prompt is sent', async () => {
    const leg = await runCase({ refuseConfig: ['mode'], steps: REVIEW });
    const r = ratify(leg);
    expect(leg.exit.refused).toContain('did not accept mode=default');
    expect(r.log.prompt).toBeNull();
    expect(r.failed).toEqual(['answer', 'nonce', 'prompt', 'refusal']);
    expect(r.cls).toBe('setup');
  });

  it('a mode the agent reports differently: refused before the prompt, class setup', async () => {
    const leg = await runCase({ forceConfig: { mode: 'auto' }, steps: REVIEW });
    const r = ratify(leg);
    expect(leg.exit.refused).toContain('reports mode = auto, not default');
    expect(r.log.prompt).toBeNull();
    expect(r.failed).toEqual(['answer', 'mode', 'nonce', 'prompt', 'refusal']);
    expect(r.cls).toBe('setup');
  });

  it('a mode switched after the prompt ratifies contaminated', async () => {
    const leg = await runCase({ steps: [{ configUpdate: { mode: 'auto' } }, ...REVIEW] });
    expect(ratify(leg).failed).toEqual(['mode-held']);
  });

  it('a torn update stream: the agent dies mid-line', async () => {
    const leg = await runCase({ steps: [{ text: 'NONCE' }, { raw: '{"jsonrpc":"2.0","method":"session/upd', noNewline: true }, { exit: 1 }] });
    const r = ratify(leg);
    expect(r.log.tornLine).toContain('session/upd');
    expect(r.failed).toEqual(['log', 'nonce', 'prompt']);
    expect(r.cls).toBe('transport');
    expect(leg.exit.doneBy).toBe('exit');
  });

  it('auth failure at session/new: the error text reaches the log for the classifier', async () => {
    const leg = await runCase({ sessionNewError: { code: -32000, message: 'Authentication required' } });
    const r = ratify(leg);
    expect(r.log.errorTexts).toEqual(['Authentication required']);
    expect(r.failed).toEqual(['answer', 'nonce', 'prompt', 'session']);
    expect(leg.exit.phase).toBe('session');
  });

  it('usage limit on the prompt: the error text reaches the log', async () => {
    const leg = await runCase({ promptError: { code: -32603, message: 'Internal error', data: 'RESOURCE_EXHAUSTED: quota exceeded' } });
    const r = ratify(leg);
    expect(r.log.errorTexts.join(' ')).toContain('RESOURCE_EXHAUSTED');
    expect(r.failed).toEqual(['answer', 'nonce', 'prompt']);
  });

  it('refuses fs and terminal client methods, and records them', async () => {
    const leg = await runCase({
      steps: [{ clientRequest: { method: 'fs/read_text_file', params: { path: '__ROOT__/inside.txt' } } }, { clientRequest: { method: 'terminal/create', params: { command: 'echo' } } }, ...REVIEW],
    });
    const r = ratify(leg);
    expect(r.log.refusedClientMethods).toEqual(['fs/read_text_file', 'terminal/create']);
    expect(r.failed).toEqual([]);
    const reply = JSON.parse(readFileSync(join(leg.dir, 'home', 'fake-acp-client-response.json'), 'utf8')) as { error: { code: number } };
    expect(reply.error.code).toBe(-32601);
  });

  it('a call the client rejected that runs anyway ratifies contaminated (denials-held)', async () => {
    const leg = await runCase({ steps: [{ ...read('t1', '__OUTSIDE__/secret.txt'), runAnyway: true }, ...REVIEW] });
    const r = ratify(leg);
    expect(r.failed).toEqual(['denials-held']);
    expect(r.status).toBe('CONTAMINATED');
  });

  it('never picks an allow_always option; with no allow_once on offer, an in-root read is rejected', async () => {
    const leg = await runCase({
      steps: [
        {
          ...read('t1', '__ROOT__/inside.txt'),
          options: [
            { optionId: 'aa', name: 'Always', kind: 'allow_always' },
            { optionId: 'ro', name: 'No', kind: 'reject_once' },
          ],
        },
        ...REVIEW,
      ],
    });
    const r = ratify(leg);
    expect(r.log.permissions.map((p) => [p.decision, p.option])).toEqual([['reject', 'reject_once']]);
  });

  it('the wall-clock cap kills the group and sends session/cancel', async () => {
    const leg = await runCase({ steps: [{ hang: true }] }, { timeoutMs: 1500 });
    expect(leg.exit.timedOut).toBe(true);
    expect(leg.exit.doneBy).toBe('timeout');
    expect(existsSync(join(leg.dir, 'home', 'fake-acp-cancelled'))).toBe(true);
    expect(groupAlive(leg.exit.pgid as number)).toBe(false);
  });

  it('a kill pattern on stderr ends the leg at once (a browser sign-in prompt)', async () => {
    const started = Date.now();
    const leg = await runCase({ steps: [{ stderr: 'Opening browser... | Press (^) + C to cancel\n' }, { hang: true }] }, { timeoutMs: 20_000, killOn: /Opening browser/ });
    expect(leg.exit.killedOn).toContain('Opening browser');
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(leg.exit.timedOut).toBe(false);
  });
});

describe('ACP ratification: each check on its own', () => {
  it('handshake: initialize refused', async () => {
    const leg = await runCase({ initializeError: { code: -32600, message: 'unsupported protocol' } });
    expect(ratify(leg).failed).toEqual(['answer', 'handshake', 'nonce', 'prompt', 'session']);
  });
  it('cwd: a session opened somewhere else than the root', async () => {
    const leg = await runCase({ steps: REVIEW }, { sessionCwd: (_root, outside) => outside });
    expect(ratify(leg).failed).toEqual(['cwd']);
    expect(ratify(leg).cls).toBe('contaminated');
  });
  it('model and effort: the agent reports other values than the pins', async () => {
    const model = await runCase({ forceConfig: { model: 'other-model' }, steps: REVIEW });
    expect(ratify(model).failed).toEqual(['answer', 'model', 'nonce', 'prompt', 'refusal']);
    expect(ratify(model).cls).toBe('model');
    const effort = await runCase({ forceConfig: { thought_level: 'high' }, steps: REVIEW });
    expect(ratify(effort).failed).toEqual(['answer', 'effort', 'nonce', 'prompt', 'refusal']);
  });
  it('permissions: a grant the record shows was not an in-root read (a broken live policy)', async () => {
    const leg = await runCase(
      { steps: [{ tool: { toolCallId: 'w', name: 'write_file', title: 'Write x', kind: 'edit', rawInput: { path: '__ROOT__/x' } }, ask: true, failAfterAllow: true }, ...REVIEW] },
      { allowAll: true },
    );
    const r = ratify(leg);
    expect(r.failed).toEqual(['permissions']);
    expect(r.status).toBe('CONTAMINATED');
  });
  it('prompt: a turn that stopped for another reason than end_turn', async () => {
    const leg = await runCase({ stopReason: 'max_tokens', steps: REVIEW });
    expect(ratify(leg).failed).toEqual(['prompt']);
  });
  it('root-unchanged: the residue sweep saw a change', async () => {
    const leg = await runCase({ steps: REVIEW });
    expect(ratify(leg, false).failed).toEqual(['root-unchanged']);
    expect(ratify(leg, false).cls).toBe('contaminated');
  });
});

describe('ACP round 1: path evidence, execution evidence, log integrity', () => {
  const tool = (id: string, extra: Record<string, unknown>) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, name: 'read_file', kind: 'read', ...extra });
  it('an in-root location with an outside operations[].path that ran unasked fails the leg', async () => {
    const leg = await runCase({
      steps: [{ update: tool('t', { status: 'completed', locations: [{ path: '__ROOT__/inside.txt' }], rawInput: { operations: [{ mode: 'Line', path: '__OUTSIDE__/secret.txt' }] } }) }, ...REVIEW],
    });
    expect(ratify(leg).failed).toEqual(['read-paths']);
    expect(ratify(leg).status).toBe('CONTAMINATED');
  });
  it('an outside path in an early update, replaced by an in-root one later, still fails', async () => {
    const leg = await runCase({
      steps: [{ update: tool('t', { status: 'in_progress', locations: [{ path: '__OUTSIDE__/secret.txt' }] }) }, { update: tool('t', { status: 'completed', locations: [{ path: '__ROOT__/inside.txt' }] }) }, ...REVIEW],
    });
    expect(ratify(leg).failed).toEqual(['read-paths']);
  });
  it('a permission request whose fsReadPaths names an outside file is rejected', async () => {
    const leg = await runCase({
      steps: [{ update: tool('t', { status: 'pending', locations: [{ path: '__ROOT__/inside.txt' }] }) }, { askFor: { toolCallId: 't' }, requestMeta: { fsReadPaths: ['__OUTSIDE__/secret.txt'] } }, ...REVIEW],
    });
    const r = ratify(leg);
    expect(r.log.permissions.map((p) => p.decision)).toEqual(['reject']);
    expect(r.log.permissions[0]?.why).toContain('resolves outside the root');
    expect(r.failed).toEqual([]);
  });
  it('completed before a request and a rejection: the call ran, so the leg is contaminated', async () => {
    const leg = await runCase({
      steps: [{ update: tool('t', { status: 'completed', locations: [{ path: '__OUTSIDE__/secret.txt' }] }) }, { askFor: { toolCallId: 't' } }, ...REVIEW],
    });
    const r = ratify(leg);
    expect(r.failed).toEqual(['denials-held']);
    expect(r.status).toBe('CONTAMINATED');
  });
  it('a call whose only status is failed but which carries output ran', async () => {
    const leg = await runCase({ steps: [{ update: { sessionUpdate: 'tool_call', toolCallId: 'x', name: 'run_command', kind: 'execute', status: 'failed', rawOutput: { output: 'canary-shell' } } }, ...REVIEW] });
    expect(ratify(leg).failed).toEqual(['tools-used']);
  });
  it("agy's bare in_progress before and after a rejection, with no output, did not run", async () => {
    const leg = await runCase({
      steps: [
        { update: tool('t', { status: 'in_progress', locations: [{ path: '__OUTSIDE__/secret.txt' }] }) },
        { askFor: { toolCallId: 't' } },
        { update: tool('t', { status: 'in_progress' }) },
        { update: tool('t', { status: 'failed' }) },
        ...REVIEW,
      ],
    });
    expect(ratify(leg).failed).toEqual([]);
  });
  it('a tool update with no toolCallId is a malformed line and fails log', async () => {
    const leg = await runCase({ steps: [{ update: { sessionUpdate: 'tool_call', name: 'run_command', kind: 'execute', status: 'completed' } }, ...REVIEW] });
    expect(ratify(leg).failed).toEqual(['log']);
  });
  it('a failed append to the update log makes a PASS impossible', async () => {
    const dir = scratch('sc-acp-append-');
    const pending = runCase({ steps: [{ sleep: 600 }, ...REVIEW] }, { logFileIn: dir });
    const logFile = join(dir, 'updates.jsonl');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(existsSync(logFile) && readFileSync(logFile, 'utf8').includes('session/prompt'))) await new Promise((res) => setTimeout(res, 20));
    chmodSync(logFile, 0o444);
    const leg = await pending;
    chmodSync(logFile, 0o644);
    expect(leg.exit.recordError).toMatch(/EACCES|permission denied/i);
    const r = ratify(leg);
    expect(r.failed).toContain('log');
    expect(r.status).not.toBe('PASS');
  });
  it('log: an exit record that reports a write failure, a missing exit record, or a transport error each fail', async () => {
    const leg = await runCase({ steps: REVIEW });
    expect(ratify(leg).failed).toEqual([]);
    const lines = readFileSync(leg.logFile, 'utf8').split('\n').filter((l) => l !== '');
    const isExit = (l: string): boolean => l.includes('"event":"exit"');
    // The exit record reports a lost line (an append that failed and then recovered).
    writeFileSync(leg.logFile, lines.map((l) => (isExit(l) ? l.replace('"recordError":null', '"recordError":"exit: EIO"') : l)).join('\n') + '\n');
    expect(ratify(leg).failed).toEqual(['log']);
    // No exit record at all: the log is incomplete.
    writeFileSync(leg.logFile, lines.filter((l) => !isExit(l)).join('\n') + '\n');
    expect(ratify(leg).failed).toEqual(['log']);
    // An intact log, but the handle's exit record says a write failed.
    writeFileSync(leg.logFile, lines.join('\n') + '\n');
    expect(ratify({ ...leg, exit: { ...leg.exit, recordError: 'start: EACCES' } }).failed).toEqual(['log']);
  });

  it('a multibyte character split across two stdout chunks reaches the log intact', async () => {
    const name = 'caf\u00e9-\u6587.txt';
    const leg = await runCase(
      { steps: [{ splitInside: '\u6587', line: tool('t', { status: 'completed', locations: [{ path: `__ROOT__/${name}` }] }) }, ...REVIEW] },
      { plant: (root) => writeFileSync(join(root, name), 'x') },
    );
    const r = ratify(leg);
    expect(r.failed).toEqual([]);
    expect(JSON.stringify(r.log.toolCalls.get('t')?.snapshots)).toContain(name);
  });
  it('output a process of the group writes after the agent exits is kept (the leg ends on close)', async () => {
    const leg = await runCase({ steps: REVIEW, lateAfterExit: 'LATE-LINE' });
    const r = ratify(leg);
    expect(r.answer).toContain('LATE-LINE');
  });
  it('with only allow_always and reject_always on offer, the answer is cancelled', async () => {
    const leg = await runCase({
      steps: [
        {
          ...read('t1', '__ROOT__/inside.txt'),
          options: [
            { optionId: 'aa', name: 'Always', kind: 'allow_always' },
            { optionId: 'ra', name: 'Never', kind: 'reject_always' },
          ],
          record: true,
        },
        ...REVIEW,
      ],
    });
    const r = ratify(leg);
    expect(r.log.permissions.map((p) => [p.decision, p.option])).toEqual([['reject', 'cancelled']]);
    const reply = JSON.parse(readFileSync(join(leg.dir, 'home', 'fake-acp-permission-t1.json'), 'utf8')) as { result: { outcome: unknown } };
    expect(reply.result.outcome).toEqual({ outcome: 'cancelled' });
  });
});

describe('ACP permission policy', () => {
  const dir = scratch('sc-acp-policy-');
  const root = join(dir, 'root');
  mkdirSync(root);
  writeFileSync(join(root, 'a.txt'), 'a');
  const call = (rawInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => [{ toolCallId: 't', name: 'read_file', kind: 'read', rawInput, ...extra }];
  it('finds paths under every path-like key at any depth, and judges globs and patterns that climb', () => {
    expect(toolCallPaths({ rawInput: { AbsolutePath: '/x', SearchPath: 'y', file_path: 'z', paths: ['p', 'q'], query: '/api/v1' }, locations: [{ path: 'l' }] }).sort()).toEqual(['/x', 'l', 'p', 'q', 'y', 'z'].sort());
    expect(toolCallPaths({ rawInput: { glob: '/etc/*', pattern: '../**' } }).sort()).toEqual(['../**', '/etc/*']);
    expect(toolCallPaths({ rawInput: { pattern: 'foo/bar', __tool_use_purpose: 'read /etc/hosts' } })).toEqual([]);
    // kiro's recorded shape, deeper nesting, endpoint keys, and contextPath (no longer skipped as "text").
    expect(toolCallPaths({ rawInput: { operations: [{ mode: 'Line', path: '/o' }], nested: { deeper: [{ src: '/s', to: '/t' }] }, contextPath: '/c' } }).sort()).toEqual(['/c', '/o', '/s', '/t']);
  });
  it('rejects a read that names no path, a non-read kind, and a call whose kind changed', () => {
    expect(judgeCall([{ name: 'read_file', kind: 'read', rawInput: { query: 'x' } }], [], root, READS).judgeable).toBe(false);
    expect(judgeCall([{ name: 'read_file', kind: 'fetch', rawInput: { url: 'https://example.com' } }], [], root, READS).read).toBe(false);
    expect(judgeCall([{ name: 'read_file', kind: 'read', rawInput: { path: join(root, 'a.txt') } }, { kind: 'execute' }], [], root, READS).read).toBe(false);
  });
  it('a declared name is required: run_command with kind read, an unknown name, a missing name and an MCP name are not reads', () => {
    const inRoot = { rawInput: { path: join(root, 'a.txt') }, kind: 'read' };
    expect(judgeCall([{ ...inRoot, name: 'run_command' }], [], root, READS).read).toBe(false);
    expect(judgeCall([{ ...inRoot, name: 'mystery_tool' }], [], root, READS).why).toContain('not a declared read');
    expect(judgeCall([inRoot], [], root, READS).why).toContain('no tool name');
    expect(judgeCall([{ ...inRoot, name: 'mcp__srv__read_file' }], [], root, READS).why).toContain('MCP-shaped');
    expect(judgeCall([{ ...inRoot, name: 'read_file' }], [], root, READS).inside).toBe(true);
  });
  it('a non-file URL is outside; an unjudgeable path value is rejected; a file: URI that does not decode never throws', () => {
    expect(judgeCall(call({ uri: 'https://example.com/x' }), [], root, READS)).toMatchObject({ read: true, judgeable: true, inside: false });
    expect(judgeCall(call({ path: { nested: 1 } }), [], root, READS)).toMatchObject({ judgeable: false });
    expect(judgeCall(call({ path: 42 }), [], root, READS)).toMatchObject({ judgeable: false });
    expect(() => judgeCall(call({ uri: 'file:///a/100%.md' }), [], root, READS)).not.toThrow();
    expect(judgeCall(call({ uri: `file://${root}/100%.md` }), [], root, READS).inside).toBe(true);
  });
  it('an unjudgeable value under a path-like key rejects the call even beside an in-root path', () => {
    expect(judgeCall(call({ path: join(root, 'a.txt'), target: 42 }), [], root, READS)).toMatchObject({ read: true, judgeable: false, inside: false });
    expect(judgeCall(call({ path: join(root, 'a.txt'), destination: { mode: 'x' } }), [], root, READS)).toMatchObject({ judgeable: false });
    expect(judgeCall(call({ path: join(root, 'a.txt') }), [], root, READS)).toMatchObject({ judgeable: true, inside: true });
  });
  it('a $ in a tool-call path is a file-name character', () => {
    mkdirSync(join(root, 'routes'), { recursive: true });
    writeFileSync(join(root, 'routes', '$id.tsx'), 'x');
    expect(judgeCall(call({ path: join(root, 'routes', '$id.tsx') }), [], root, READS)).toMatchObject({ judgeable: true, inside: true });
  });
  it('a path-less grep is judged at the cwd only for a tool that documents that default', () => {
    expect(judgeCall([{ name: 'grep', kind: 'search', rawInput: { pattern: 'x' } }], [], root, READS)).toMatchObject({ judgeable: true, inside: true });
    expect(judgeCall([{ name: 'read_file', kind: 'read', rawInput: { pattern: 'x' } }], [], root, READS)).toMatchObject({ judgeable: false });
  });
  it('judges the union of every snapshot and the request: an earlier outside path is never erased, fsReadPaths count', () => {
    const policy = readOnlyPolicy(root, READS);
    const inside = { toolCallId: 't', name: 'read_file', kind: 'read', locations: [{ path: join(root, 'a.txt') }] };
    const outside = { toolCallId: 't', name: 'read_file', kind: 'read', locations: [{ path: '/etc/hosts' }] };
    const known = (snapshots: Array<Record<string, unknown>>) => () => ({ fields: {}, kinds: ['read'], snapshots });
    expect(policy({ toolCall: { toolCallId: 't' } }, known([inside])).allow).toBe(true);
    expect(policy({ toolCall: { toolCallId: 't' } }, known([outside, inside])).allow).toBe(false);
    expect(policy({ toolCall: { toolCallId: 't' }, _meta: { fsReadPaths: ['/etc/hosts'] } }, known([inside])).allow).toBe(false);
    // An in-root location with an outside operations[].path (kiro's shape): rejected.
    expect(policy({ toolCall: { ...inside, rawInput: { operations: [{ mode: 'Line', path: '/etc/hosts' }] } } }, known([])).allow).toBe(false);
    expect(policy({ toolCall: { toolCallId: 't', title: 'Read' } }, () => undefined).allow).toBe(false);
  });
});

describe('ACP log reader', () => {
  it('splits the message text at tool calls, and the answer is the whole turn', () => {
    const dir = scratch('sc-acp-log-');
    const file = join(dir, 'u.jsonl');
    const upd = (u: Record<string, unknown>) => JSON.stringify({ t: 0, dir: 'recv', msg: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: u } } });
    writeFileSync(
      file,
      [
        upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look.' } }),
        upd({ sessionUpdate: 'tool_call', toolCallId: 'a', kind: 'read', status: 'pending' }),
        upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'NONCE: x\n' } }),
        upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'VERDICT: SHIP' } }),
      ].join('\n') + '\n',
    );
    const log = readAcpLog(file);
    expect(log.messageSegments).toEqual(['Let me look.', 'NONCE: x\nVERDICT: SHIP']);
    expect(acpAnswer(log)).toBe('Let me look.\n\nNONCE: x\nVERDICT: SHIP');
  });
});
