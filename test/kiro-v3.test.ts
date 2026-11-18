import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeCall, requestPaths } from '../src/adapters/acp/policy.js';
import type { AcpToolCall } from '../src/adapters/acp/log.js';
import {
  KIRO_UPDATE_OFF_TEXT,
  KIRO_V3_AGENT_SHA256,
  KIRO_V3_AGENT_TEXT,
  KIRO_V3_NOTICE,
  KIRO_V3_READS,
  createKiroAdapter,
  isLoopGuard,
  kiroArgs,
  kiroSettingsText,
  kiroV3Policy,
  kiroV3Ran,
  noPresets,
} from '../src/adapters/kiro/index.js';
import type { Occupant } from '../src/adapters/types.js';
import type { KnownToolCall } from '../src/transport/acp.js';
import { FAKE_ACP } from './helpers/acp.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import {
  AGENT_FILE_BYTES,
  FAKE_V3,
  GATE,
  LOG_LINE,
  NONCE_CHUNK,
  SIGNED_OUT,
  V3_MODEL,
  call,
  chunk,
  happyCase,
  happySteps,
  keepIterating,
  launchV3,
  messagesFor,
  msg,
  segments,
  sessionJson,
  tokenHome,
  turnCompletion,
  turnEnd,
  update,
  usedToolsOf,
  v3Case,
  v3Ctx,
  v3Runner,
  type Step,
} from './helpers/kiro-v3.js';

cleanScratchAfterAll();

/*
 * kiro on the v3 engine (plan 4.6, P11): the real ACP client and the kiro adapter against a fake v3 agent that plays
 * the scrubbed P11 recordings (kiro-cli 3.5.0). Each `describe` below is a group of the P11 row of plan section 10.
 */

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const REFUSED = ['answer', 'nonce', 'prompt', 'refusal'];
const refusedWith = (...checks: string[]): string[] => [...checks, ...REFUSED].sort();

interface Gate {
  sessionNew: { before: Json[]; result: Json; after: Json[] };
  onSet: Record<string, Json[]>;
  config: Json[];
}
/** The recorded gate with an edit: the case's `extra`. */
function gateWith(edit: (g: Gate) => void): Json {
  const g = clone({ sessionNew: GATE['sessionNew'], onSet: GATE['onSet'], config: GATE['config'] }) as Gate;
  edit(g);
  return { sessionNew: g.sessionNew, onSet: g.onSet, config: g.config };
}
/** The params of a recorded notification (`update` for a session/update). */
function paramsOf(list: Json[], method: string, kind?: string): Json {
  const m = list.find((x) => x['method'] === method && (kind === undefined || ((x['params'] as Json)['update'] as Json | undefined)?.['sessionUpdate'] === kind));
  if (m === undefined) throw new Error(`no ${method} ${kind ?? ''}`);
  const p = m['params'] as Json;
  return kind !== undefined ? (p['update'] as Json) : p;
}
const without = (list: Json[], method: string): Json[] => list.filter((x) => x['method'] !== method);
const DEFAULT_TAGS = (): Json[] => clone(paramsOf((GATE['sessionNew'] as Gate['sessionNew']).before, '_kiro/tools/didChange')['tags'] as Json[]);
/** A refused leg's case: the happy steps (never reached) and the gate edit. */
const refusedCase = (edit: (g: Gate) => void): Json => v3Case({ ...happyCase(), extra: gateWith(edit) });
/** A turn of steps after the NONCE line, closed with kiro's completion (usedTools from the steps) and end. */
function turn(body: Step[], opts: { usedTools?: string[]; nonce?: boolean } = {}): Step[] {
  const steps = [...(opts.nonce === false ? [] : [NONCE_CHUNK]), ...body];
  return [...steps, chunk('review done'), turnCompletion(opts.usedTools ?? usedToolsOf(steps)), turnEnd()];
}
/** The pinned config as kiro reports it after every pin, with values changed. */
function configAfter(values: Record<string, string>): Json[] {
  const pinned: Record<string, string> = { mode: 'sabotage-council', model: V3_MODEL, autopilot: 'off', contentCollection: 'disabled', memoryReflection: 'off', sessionToolsMessaging: 'off', ...values };
  return (clone(GATE['config']) as Json[]).map((o) => ({ ...o, currentValue: pinned[String(o['id'])] ?? o['currentValue'] }));
}
const EFFORT_OPTION = { type: 'select', id: 'effortLevel', name: 'Effort', category: 'thought_level', currentValue: 'medium', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] };
const READ_NOTES = (id: string, origin?: string): Step[] => call(id, 'Read File', 'read', { path: 'NOTES.md' }, { locations: [{ path: '${CWD}/NOTES.md' }], output: '# Notes', ...(origin !== undefined ? { origin } : {}) });

describe('ratifies (P11 row)', () => {
  it('the v3 happy path, with an outside read the client rejected (the v3 denial notice)', async () => {
    const run = await launchV3(v3Case(happyCase()));
    expect(run.failed).toEqual([]);
    expect(run.r).toMatchObject({ status: 'PASS', failureClass: null, cliVersion: '3.5.0', modelObserved: V3_MODEL, credits: 0.2294, toolsOffered: ['builtin:read'], toolsUsed: ['grep_search', 'list_directory', 'read_file'] });
    expect(run.r.detail['engine']).toBe('v3');
    expect(run.r.detail['creditSplit']).toEqual({ main: 0.2293535290215589, delegated: 0, auxiliary: 0.006000130679933665 });
    // The outside read asked once, with `_meta.kiro.consent.resource`, and the client answered `reject`.
    expect(run.answers).toEqual([{ toolCallId: 'tooluse_0004', answer: 'reject' }]);
    const perm = run.log.permissions[0];
    expect(perm).toMatchObject({ decision: 'reject', option: 'reject_once', optionId: 'reject' });
    expect(perm?.why).toContain('outside.txt');
  });

  it('launches `kiro-cli acp --agent-engine v3` with no agent, model or effort flag, and pins in the plan order', async () => {
    const run = await launchV3(v3Case(happyCase()));
    expect(run.argv.args).toEqual(['acp', '--agent-engine', 'v3']);
    // macOS adds __CF_USER_TEXT_ENCODING to every spawned process; nothing else beyond the scrubbed set.
    expect(run.argv.env.filter((n) => n !== '__CF_USER_TEXT_ENCODING')).toEqual(['HOME', 'KIRO_HOME', 'NO_COLOR', 'PATH', 'TERM']);
    const sets = run.log.rpcs.filter((x) => x.method === 'session/set_config_option').map((x) => `${String(x.params['configId'])}=${String(x.params['value'])}`);
    expect(sets).toEqual(['mode=sabotage-council', `model=${V3_MODEL}`, 'autopilot=off', 'contentCollection=disabled', 'memoryReflection=off', 'sessionToolsMessaging=off']);
    expect(run.log.clientEvents.some((e) => e['event'] === 'gate-passed')).toBe(true);
    // The agent file is the declared bytes on disk; the settings file has the three keys (3.5.0 declares them).
    expect(readFileSync(run.handle.files['profile'] ?? '')).toEqual(AGENT_FILE_BYTES);
    expect(JSON.parse(readFileSync(run.handle.files['settings'] ?? '', 'utf8'))).toEqual({ 'app.disableAutoupdates': true, 'telemetry.enabled': false, 'codeWhisperer.shareCodeWhispererContentWithAWS': false });
    expect(run.handle.data['agentHash']).toBe(KIRO_V3_AGENT_SHA256);
  });

  it('a Load Resource that went in_progress then failed with the catalogue error, and a File Search', async () => {
    const s = segments();
    const steps = turn([...(s['preamble'] ?? []), ...(s['fileSearch'] ?? []), ...(s['loadResource'] ?? [])]);
    expect(usedToolsOf(steps)).toEqual(['file_search', 'load_resource', 'load_resource', 'load_resource']);
    const run = await launchV3(v3Case({ steps }));
    expect(run.failed).toEqual([]);
    expect(run.r.status).toBe('PASS');
    expect(run.r.toolsUsed).toEqual(['file_search']);
  });

  it('the log reader keeps every _kiro/* notification and available_commands_update', async () => {
    const run = await launchV3(v3Case(happyCase()));
    const methods = new Set(run.log.notes.map((n) => (n.kind !== null ? `${n.method}:${n.kind}` : n.method)));
    for (const m of ['_kiro/mcp/status', '_kiro/powers/items_changed', '_kiro/progressive_context/items_changed', '_kiro/tools/didChange', '_kiro/policy/changed', '_kiro/steering/documents_changed', '_kiro/memory/syncStatus', '_kiro/governance/state', 'session/update:available_commands_update', 'session/update:session_info_update']) {
      expect(methods.has(m), m).toBe(true);
    }
  });
});

describe('refused before the prompt (P11 row)', () => {
  const mode = (g: Gate): Json[] => g.onSet['mode'] ?? [];
  it.each<[string, (g: Gate) => void, string]>([
    ['tags []', (g) => (paramsOf(mode(g), '_kiro/tools/didChange')['tags'] = []), 'gate-tags'],
    ['the four default tags', (g) => (paramsOf(mode(g), '_kiro/tools/didChange')['tags'] = DEFAULT_TAGS()), 'gate-tags'],
    ['a non-builtin tag', (g) => (paramsOf(mode(g), '_kiro/tools/didChange')['tags'] = [{ source: 'mcp', tag: 'read', description: 'x' }]), 'gate-tags'],
    ['a listed MCP server', (g) => (paramsOf(g.sessionNew.before, '_kiro/mcp/status')['servers'] = [{ name: 'decoy', status: 'running' }]), 'gate-mcp'],
    [
      'a non-empty preset store at session/new',
      (g) => (((((g.sessionNew.result['_meta'] as Json)['kiro'] as Json)['presetStores'] as Json[])[0] as Json)['read'] = { ok: true, presets: [{ name: 'decoy' }] }),
      'gate-presets',
    ],
    ['a preset store outside the leg KIRO_HOME', (g) => ((((g.sessionNew.result['_meta'] as Json)['kiro'] as Json)['presetStores'] as Json[])[0] as Json)['file'] = '${PARENT}/permissions.yaml', 'gate-presets'],
    ['a non-empty preset store after the mode pin', (g) => ((paramsOf(mode(g), '_kiro/policy/changed')['presetStores'] as Json[])[1] as Json)['read'] = { ok: true, presets: [{ name: 'decoy' }] }, 'gate-policy'],
    [
      'a non-bundled steering document',
      (g) =>
        (paramsOf(mode(g), '_kiro/steering/documents_changed')['documents'] as Json[]).push({ name: 'decoy', type: 'steering', scope: 'global', uri: 'file:///x/decoy.md', inclusion: 'always', _meta: { kiro: { resource: { resourceType: 'steering', source: { origin: 'user' } } } } }),
      'gate-steering',
    ],
    ['a power', (g) => (paramsOf(g.sessionNew.before, '_kiro/powers/items_changed')['powers'] = [{ name: 'decoy-power' }]), 'gate-context'],
    ['a progressive-context item', (g) => (paramsOf(g.sessionNew.after, '_kiro/progressive_context/items_changed')['items'] = [{ id: 'decoy' }]), 'gate-context'],
    [
      'another command after the pin',
      (g) => (paramsOf(mode(g), 'session/update', 'available_commands_update')['availableCommands'] = [{ name: 'general-task-execution', description: 'x' }, { name: 'sabotage-council', description: 'y' }]),
      'gate-commands',
    ],
  ])('%s', async (_what, edit, check) => {
    const run = await launchV3(refusedCase(edit));
    expect(run.failed).toEqual(refusedWith(check));
    expect(run.r.failureClass).toBe('setup');
    expect(run.log.prompt).toBeNull();
    expect(run.log.refused).toContain(check);
  });

  it.each<[string, string, string, string]>([
    ['mode', 'vibe', 'mode', 'setup'],
    ['model', 'auto', 'model', 'model'],
    ['effortLevel', 'low', 'effort', 'model'],
    ['autopilot', 'on', 'autopilot', 'setup'],
    ['contentCollection', 'enabled', 'contentCollection', 'setup'],
    ['memoryReflection', 'on', 'memoryReflection', 'setup'],
    ['sessionToolsMessaging', 'on', 'sessionToolsMessaging', 'setup'],
  ])('the %s pin unconfirmed (reported %s): %s, class %s', async (id, reported, check, cls) => {
    const effort = id === 'effortLevel';
    const extra = { ...gateWith((g) => (effort ? g.config.push(clone(EFFORT_OPTION)) : undefined)), forceConfig: { [id]: reported } };
    const run = await launchV3(v3Case({ ...happyCase(), extra }), { o: effort ? { model: 'claude-sonnet-4.5', effort: 'high' } : {} });
    expect(run.failed).toEqual(refusedWith(check));
    expect(run.r.failureClass).toBe(cls);
    expect(run.log.refused).toContain(`${id} = ${reported}`);
  });

  it('an effort with no effortLevel option advertised after the model pin: model, and the effortLevel set is never sent', async () => {
    const run = await launchV3(v3Case(happyCase()), { o: { model: 'claude-sonnet-4.5', effort: 'high' } });
    expect(run.r.failureClass).toBe('model');
    expect(run.failed).toContain('effort-offered');
    expect(run.failed).toContain('effort');
    expect(run.log.refused).toBe('no effortLevel option is advertised, so effortLevel=high cannot be pinned');
    expect(run.log.rpcs.some((x) => x.method === 'session/set_config_option' && x.params['configId'] === 'effortLevel')).toBe(false);
    expect(run.log.prompt).toBeNull();
  });

  it('an effort whose effortLevel option is advertised is pinned and ratifies', async () => {
    const extra = gateWith((g) => g.config.push(clone(EFFORT_OPTION)));
    const run = await launchV3(v3Case({ ...happyCase(), session: sessionJson({ modelId: 'claude-sonnet-4.5', modelNamedBy: { modelId: 'claude-sonnet-4.5', by: 'client' } }), messages: messagesFor(happyCase().steps, { model: 'claude-sonnet-4.5' }), extra }), {
      o: { model: 'claude-sonnet-4.5', effort: 'high' },
    });
    expect(run.failed).toEqual([]);
    expect(run.r.effortObserved).toBe('high');
  });

  it('a pin kiro refuses to set (sessionToolsMessaging): setup', async () => {
    const run = await launchV3(v3Case({ ...happyCase(), extra: { refuseSet: ['sessionToolsMessaging'] } }));
    expect(run.r.failureClass).toBe('setup');
    expect(run.log.refused).toContain('sessionToolsMessaging=off');
    expect(run.log.prompt).toBeNull();
  });

  it('the model option listed late (after session/new) is waited for, then pinned', async () => {
    const extra = { ...gateWith((g) => (g.config = g.config.filter((o) => o['id'] !== 'model'))), lateConfig: { delayMs: 120, add: [(GATE['config'] as Json[]).find((o) => o['id'] === 'model')] } };
    const run = await launchV3(v3Case({ ...happyCase(), extra }));
    expect(run.failed).toEqual([]);
  });
});

describe('contaminated (P11 row)', () => {
  it('a pinned option changed after the prompt', async () => {
    const steps = turn([...READ_NOTES('t1'), update({ sessionUpdate: 'config_option_update', configOptions: configAfter({ autopilot: 'on' }) })]);
    const run = await launchV3(v3Case({ steps }));
    expect(run.failed).toEqual(['mode-held']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it.each<[string, Step, string]>([
    ['tags', msg('_kiro/tools/didChange', { sessionId: '${SESSION}', tags: DEFAULT_TAGS() }), 'tags-held'],
    [
      'policy',
      msg('_kiro/policy/changed', { sessionId: '${SESSION}', status: 'success', presetStores: [{ scope: 'user', file: '${KIRO_HOME}/settings/permissions.yaml', read: { ok: true, presets: [{ name: 'decoy' }] } }] }),
      'policy-held',
    ],
    ['steering', msg('_kiro/steering/documents_changed', { sessionId: '${SESSION}', status: 'success', documents: [{ name: 'decoy', uri: 'file:///x/decoy.md', scope: 'workspace', inclusion: 'always' }] }), 'steering-held'],
  ])('a later %s notification that would fail the gate', async (_what, note, check) => {
    const run = await launchV3(v3Case({ steps: turn([note, ...READ_NOTES('t1')]) }));
    expect(run.failed).toEqual([check]);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it('a completed Load Resource', async () => {
    const steps = turn(call('lr1', 'Load Resource', 'other', { id: 'builtin:quick-spec' }, { output: '# Quick spec' }));
    const run = await launchV3(v3Case({ steps }));
    expect(run.failed).toEqual(['load-resource', 'tools-used']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it('an unknown title', async () => {
    const steps = turn(call('x1', 'Execute Command', 'execute', { command: 'echo hi' }, { output: 'hi' }));
    const run = await launchV3(v3Case({ steps }));
    expect(run.failed).toEqual(['messages-calls', 'tool-titles', 'tools-used']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it.each(['mcp', 'remote'])('a toolOrigin other than default or acp (%s)', async (origin) => {
    const run = await launchV3(v3Case({ steps: turn(READ_NOTES('t1', origin)) }));
    expect(run.failed).toEqual(['tool-origin']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it.each<[string, (used: string[]) => string[]]>([
    ['an extra name', (u) => [...u, 'read_file']],
    ['a missing name', (u) => u.slice(1)],
    ['a reordered list', (u) => [...u].reverse()],
  ])('a usedTools list with %s', async (_what, edit) => {
    const body = [...READ_NOTES('t1'), ...call('g1', 'Grep Search', 'search', { query: 'needle' })];
    const run = await launchV3(v3Case({ steps: turn(body, { usedTools: edit(['read_file', 'grep_search']) }), messages: messagesFor(turn(body)) }));
    expect(run.failed).toEqual(['used-tools']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it('the recorded grep whose includePattern climbs out of the root (it ran, matched nothing)', async () => {
    const s = segments();
    const run = await launchV3(v3Case({ steps: turn([...(s['outsideGrep'] ?? [])]) }));
    expect(run.failed).toEqual(['read-paths']);
    expect(run.r.checks.find((c) => c.name === 'read-paths')?.detail).toContain('../**/*');
  });

  it.each<[string, string, Json]>([
    ['a File Search query naming the parent', 'File Search', { query: '../**/*.txt' }],
    ['a File Search query with an absolute path', 'File Search', { query: '/etc/*' }],
    ['a File Search query naming home', 'File Search', { query: '~/notes.md' }],
    ['a File Search query climbing after **', 'File Search', { query: '**/../outside.txt' }],
    ['a Grep Search path outside', 'Grep Search', { query: 'x', path: '${PARENT}' }],
    ['a Grep Search includePattern climbing after **', 'Grep Search', { query: 'x', includePattern: 'src/**/../../*' }],
    ['a List Directory path outside', 'List Directory', { path: '..' }],
  ])('%s: contaminated', async (_what, title, rawInput) => {
    const run = await launchV3(v3Case({ steps: turn(call('s1', title, 'search', rawInput)) }));
    expect(run.failed).toEqual(['read-paths']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it('a loop guard recorded as keep-iterating', async () => {
    const s = segments();
    const guard = clone(s['loopGuard'] ?? []);
    const ask = guard.find((x) => x['ask'] !== undefined) as Json;
    ask['answers'] = { cancel: keepIterating() };
    const body = [...(s['failedReads'] ?? []), ...guard, ...(s['cancelledText'] ?? [])];
    const run = await launchV3(v3Case({ steps: turn(body) }));
    expect(run.failed).toEqual(['loop-guard']);
    expect(run.r.checks.find((c) => c.name === 'loop-guard')?.detail).toContain('keep-iterating');
  });

  it.each<[string, Step]>([
    ['a changed agent-file hash', { write: { path: '${KIRO_HOME}/agents/sabotage-council.json', content: '{"name":"sabotage-council","tools":["*"]}' } }],
    ['a .json.bak beside the agent file', { write: { path: '${KIRO_HOME}/agents/sabotage-council.json.bak', content: '{}' } }],
  ])('%s after the leg', async (_what, write) => {
    const run = await launchV3(v3Case({ steps: turn([...READ_NOTES('t1'), write]) }));
    expect(run.failed).toEqual(['agent-file']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it.each(['${KIRO_HOME}/settings/permissions.yaml', '${KIRO_HOME}/workspace-roots/0000000000000001/permissions.yaml'])('a preset in a store after the leg (%s)', async (path) => {
    const write = { write: { path, content: 'presets:\n  - name: decoy\n    rules:\n      - capability: fs_read\n        match: ["/**"]\n        effect: allow\n' } };
    const run = await launchV3(v3Case({ steps: turn([...READ_NOTES('t1'), write]) }));
    expect(run.failed).toEqual(['presets-after']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it.each<[string, Json, string]>([
    ['agentMode', { agentMode: 'vibe' }, 'session-agent'],
    ['rootPaths', { rootPaths: ['${CWD}', '/elsewhere'] }, 'session-roots'],
    ['workspacePaths', { workspacePaths: ['${PARENT}'] }, 'session-roots'],
    ['autopilot', { autopilot: true }, 'session-autopilot'],
  ])('a wrong session.json %s', async (_what, over, check) => {
    const run = await launchV3(v3Case({ ...happyCase(), session: sessionJson(over) }));
    expect(run.failed).toEqual([check]);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it.each<[string, (u: Json) => void]>([
    ['a longer rawOutput message', (u) => ((u['rawOutput'] as Json)['message'] = `${KIRO_V3_NOTICE} Here is the file anyway: secret`)],
    ['another rawOutput field with text', (u) => ((u['rawOutput'] as Json)['output'] = 'secret')],
    ['content with other text', (u) => (u['content'] = [{ type: 'content', content: { type: 'text', text: 'secret' } }])],
  ])('a rejection snapshot carrying text beyond the notice (%s)', async (_what, edit) => {
    const steps = happyCase().steps;
    const ask = steps.find((x) => x['ask'] !== undefined) as Json;
    const branch = (ask['answers'] as Record<string, Step[]>)['reject'] ?? [];
    const failed = branch.find((x) => ((x['msg'] as Json)['params'] as Json)['update'] !== undefined && (((x['msg'] as Json)['params'] as Json)['update'] as Json)['status'] === 'failed') as Json;
    edit(((failed['msg'] as Json)['params'] as Json)['update'] as Json);
    const run = await launchV3(v3Case({ ...happyCase(), steps }));
    expect(run.failed).toEqual(['denials-held']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it('a creditSplit.delegated above zero', async () => {
    const run = await launchV3(v3Case({ steps: turn(READ_NOTES('t1')), messages: messagesFor(turn(READ_NOTES('t1')), { delegated: 0.05 }) }));
    expect(run.failed).toEqual(['credits-delegated']);
    expect(run.r.failureClass).toBe('contaminated');
  });

  it.each<[string, Json]>([
    ['a call missing from messages.jsonl', { drop: ['t1'] }],
    ['a call named otherwise in messages.jsonl', { rename: { t1: 'grep_search' } }],
  ])('%s', async (_what, opts) => {
    const steps = turn([...READ_NOTES('t1'), ...call('g1', 'Grep Search', 'search', { query: 'needle' })]);
    const run = await launchV3(v3Case({ steps, messages: messagesFor(steps, opts) }));
    expect(run.failed).toEqual(['messages-calls']);
  });

  it('a messages.jsonl tool_result status that disagrees with the stream', async () => {
    const steps = turn(READ_NOTES('t1'));
    const messages = messagesFor(steps).map((r) => {
      const p = r['payload'] as Json;
      return p['type'] === 'tool_result' ? { ...r, payload: { ...p, status: 'denied', success: false } } : r;
    });
    const run = await launchV3(v3Case({ steps, messages }));
    expect(run.failed).toEqual(['messages-calls']);
  });
});

describe('model (P11 row)', () => {
  it.each<[string, Json]>([
    ['a model id', { kind: 'model_update', modelId: 'claude-haiku-4.5' }],
    ['a fallback', { kind: 'fallback', modelFallback: { from: V3_MODEL, to: 'auto' } }],
  ])('a notification after the prompt reporting %s', async (_what, meta) => {
    const steps = turn([...READ_NOTES('t1'), update({ sessionUpdate: 'session_info_update', _meta: { kiro: meta } })]);
    const run = await launchV3(v3Case({ steps }));
    expect(run.failed).toEqual(['model-held']);
    expect(run.r.failureClass).toBe('model');
  });

  it('a messages.jsonl model note other than the pin (the last one)', async () => {
    const steps = turn(READ_NOTES('t1'));
    const run = await launchV3(v3Case({ steps, messages: messagesFor(steps, { notes: [V3_MODEL, 'claude-haiku-4.5'] }) }));
    expect(run.failed).toEqual(['messages-model']);
    expect(run.r.failureClass).toBe('model');
  });

  it.each<[string, Json]>([
    ['modelId', { modelId: 'auto' }],
    ['modelNamedBy', { modelNamedBy: { modelId: V3_MODEL, by: 'auto' } }],
  ])('a wrong session.json %s', async (_what, over) => {
    const run = await launchV3(v3Case({ ...happyCase(), session: sessionJson(over) }));
    expect(run.failed).toEqual(['session-model']);
    expect(run.r.failureClass).toBe('model');
  });
});

describe('setup (P11 row)', () => {
  it('a missing session.json', async () => {
    const run = await launchV3(v3Case({ ...happyCase(), session: null }));
    expect(run.failed).toEqual(['messages-jsonl', 'session-json']);
    expect(run.r.failureClass).toBe('setup');
  });
  it('a missing messages.jsonl', async () => {
    const run = await launchV3(v3Case({ ...happyCase(), messages: null }));
    expect(run.failed).toEqual(['messages-jsonl']);
    expect(run.r.failureClass).toBe('setup');
  });
  it('a messages.jsonl with no model note', async () => {
    const steps = turn(READ_NOTES('t1'));
    const run = await launchV3(v3Case({ steps, messages: messagesFor(steps, { notes: [] }) }));
    expect(run.failed).toEqual(['messages-jsonl']);
    expect(run.r.failureClass).toBe('setup');
  });
  it('a messages.jsonl with no creditSplit', async () => {
    const steps = turn(READ_NOTES('t1'));
    const run = await launchV3(v3Case({ steps, messages: messagesFor(steps, { creditSplit: false }) }));
    expect(run.failed).toEqual(['credit-split']);
    expect(run.r.failureClass).toBe('setup');
  });
  it('the leg ran another version than preflight saw', async () => {
    const run = await launchV3({ ...v3Case(happyCase()), version: '3.6.0' }, { version: '3.5.0' });
    expect(run.failed).toEqual(['leg-version']);
    expect(run.r.failureClass).toBe('setup');
    expect(run.r.checks.find((c) => c.name === 'leg-version')?.detail).toContain('KiroCLI 3.6.0');
  });
  it('no KiroCLI/<version> line in the leg log', async () => {
    const run = await launchV3(v3Case({ ...happyCase(), log: null }));
    expect(run.failed).toEqual(['leg-version']);
    const noLine = await launchV3(v3Case({ ...happyCase(), log: '{"level":"info","message":"started"}\n' }));
    expect(noLine.failed).toEqual(['leg-version']);
  });
  it.each<[string, (g: Gate) => void, string]>([
    ['the tags after the mode pin', (g) => (g.onSet['mode'] = without(g.onSet['mode'] ?? [], '_kiro/tools/didChange')), 'gate-tags'],
    ['the policy after the mode pin', (g) => (g.onSet['mode'] = without(g.onSet['mode'] ?? [], '_kiro/policy/changed')), 'gate-policy'],
    ['the progressive-context notification', (g) => (g.sessionNew.after = without(g.sessionNew.after, '_kiro/progressive_context/items_changed')), 'gate-context'],
    ['the MCP status', (g) => (g.sessionNew.before = without(g.sessionNew.before, '_kiro/mcp/status')), 'gate-mcp'],
  ])('a gate notification that never arrives: %s', async (_what, edit, check) => {
    const started = Date.now();
    const run = await launchV3(refusedCase(edit));
    expect(run.failed).toEqual(refusedWith(check));
    expect(run.r.failureClass).toBe('setup');
    expect(run.log.refused).toMatch(/none arrived within 400 ms/);
    expect(Date.now() - started).toBeLessThan(8000);
  });
});

describe('empty, auth and the loop-guard answer (P11 row)', () => {
  const loopTurn = (): Step[] => {
    const s = segments();
    const guard = clone(s['loopGuard'] ?? []);
    const ask = guard.find((x) => x['ask'] !== undefined) as Json;
    // kiro records an answer of `cancelled` (or keep-iterating) as keep-iterating, and goes on.
    (ask['answers'] as Record<string, Step[]>)['cancelled'] = keepIterating();
    (ask['answers'] as Record<string, Step[]>)['keep-iterating'] = keepIterating();
    return turn([...(s['preamble'] ?? []), ...(s['failedReads'] ?? []), ...guard, ...(s['cancelledText'] ?? [])], { nonce: false });
  };

  it('a turn ended by a loop-guard cancel: empty (no verdict)', async () => {
    const run = await launchV3(v3Case({ steps: loopTurn() }));
    expect(run.failed).toEqual(['nonce']);
    expect(run.r.failureClass).toBe('empty');
    expect(run.r.detail['loopGuards']).toHaveLength(2);
  });

  it('the loop-guard request is answered `cancel` (an exact option, never a grant)', async () => {
    const run = await launchV3(v3Case({ steps: loopTurn() }));
    const guard = run.answers.find((a) => a.toolCallId?.startsWith('failure-intervention-prompt-'));
    expect(guard?.answer).toBe('cancel');
    const perm = run.log.permissions.find((p) => p.toolCallId?.startsWith('failure-intervention-prompt-'));
    expect(perm).toMatchObject({ decision: 'reject', optionId: 'cancel' });
    expect(run.r.checks.find((c) => c.name === 'loop-guard')).toMatchObject({ ok: true });
    expect(run.r.checks.find((c) => c.name === 'permissions')).toMatchObject({ ok: true });
  });

  it('the signed-out session/new error is auth', async () => {
    const kase = { ...v3Case(happyCase()), initialize: SIGNED_OUT['initialize'], sessionNewError: SIGNED_OUT['sessionNewError'], stderr: SIGNED_OUT['stderr'] };
    const run = await launchV3(kase);
    expect(run.r.failureClass).toBe('auth');
    expect(run.cls).toBe('auth');
    expect(run.failed).toEqual(['answer', 'nonce', 'prompt', 'session']);
  });
});

describe('v2 and versions (P11 row)', () => {
  const o = (extra: Partial<Occupant> = {}): Occupant => ({ backend: 'kiro', model: V3_MODEL, authHome: tokenHome(), ...extra });

  it('engine = "v2" selects the P3 launch; unset selects v3', () => {
    expect(kiroArgs('m', 'high', 'v2')).toEqual(['acp', '--agent-engine', 'v2', '--agent', 'sabotage-council', '--model', 'm', '--effort', 'high']);
    expect(kiroArgs('m', 'high', 'v3')).toEqual(['acp', '--agent-engine', 'v3']);
  });

  it.each<[string, Partial<Occupant>, string, boolean]>([
    ['v2 on 3.2.1', { engine: 'v2' }, '3.2.1', false],
    ['v2 on 3.3.0', { engine: 'v2' }, '3.3.0', false],
    ['v2 on 3.5.0', { engine: 'v2' }, '3.5.0', true],
    ['v3 on 3.5.0', {}, '3.5.0', true],
    ['v3 on 3.6.0 (undeclared)', {}, '3.6.0', false],
  ])('the leg settings file is written only on versions declared for it: %s', async (_what, extra, version, written) => {
    const occupant = o(extra);
    const ctx = v3Ctx();
    writeFileSync(join(occupant.authHome ?? '', 'fake-acp.json'), JSON.stringify({ exitAtStart: 0 }));
    writeFileSync(join(occupant.authHome ?? '', 'fake-kiro-v3.json'), JSON.stringify({ exitAtStart: 0 }));
    const adapter = createKiroAdapter({ bin: extra.engine === 'v2' ? FAKE_ACP : FAKE_V3, runner: v3Runner(version).run, platform: 'darwin' });
    const pre = await adapter.preflight(occupant, ctx);
    expect(pre.ok, pre.reason ?? '').toBe(true);
    const handle = await adapter.launch(occupant, ctx, pre);
    await adapter.cancel(handle);
    const settings = join(ctx.legDir, 'kiro-home', 'settings', 'cli.json');
    expect(existsSync(settings)).toBe(written);
    if (written) expect(readFileSync(settings, 'utf8')).toBe(kiroSettingsText(version));
    expect(handle.data['engine']).toBe(extra.engine ?? 'v3');
    expect(pre.data['engine']).toBe(extra.engine ?? 'v3');
    if (version === '3.6.0') expect(pre.checks.find((c) => c.name === 'version')?.status).toBe('warn');
  });

  it.each<[string, Partial<Occupant>, string, string | null]>([
    ['v3 on 3.5.0', {}, '3.5.0', kiroSettingsText('3.5.0')],
    ['v2 on 3.2.1', { engine: 'v2' }, '3.2.1', null],
  ])("preflight's kiro commands run on a scratch KIRO_HOME, removed after (%s)", async (_what, extra, version, listSettings) => {
    const occupant = o(extra);
    const { run, calls } = v3Runner(version);
    const pre = await createKiroAdapter({ runner: run, platform: 'darwin' }).preflight(occupant, v3Ctx());
    expect(pre.ok, pre.reason ?? '').toBe(true);
    expect(calls.map((c) => c.args.join(' '))).toEqual(['--version', 'chat --list-models --format json']);
    const [v, list] = calls;
    expect(v?.kiroHome).toBeDefined();
    expect(v?.kiroHome).not.toBe(occupant.authHome);
    expect(v?.home).toBe(occupant.authHome);
    expect(list?.kiroHome).toBe(v?.kiroHome);
    // --version: only app.disableAutoupdates; the listing: the version's declared file, else the same one key.
    expect(v?.settings).toBe(KIRO_UPDATE_OFF_TEXT);
    expect(v?.files).toEqual(['settings/cli.json']);
    expect(list?.settings).toBe(listSettings ?? KIRO_UPDATE_OFF_TEXT);
    expect(existsSync(v?.kiroHome ?? '/')).toBe(false);
    expect(pre.checks.find((c) => c.name === 'scratch')?.status).toBe('ok');
  });

  it('a v3 seat below the v3 floor is refused: update kiro-cli, or set engine = v2', async () => {
    const pre = await createKiroAdapter({ runner: v3Runner('3.3.0').run, platform: 'darwin' }).preflight(o(), v3Ctx());
    expect(pre).toMatchObject({ ok: false, failureClass: 'setup' });
    expect(pre.reason).toContain('update kiro-cli, or set engine = v2');
    const v2 = await createKiroAdapter({ runner: v3Runner('3.3.0').run, platform: 'darwin' }).preflight(o({ engine: 'v2' }), v3Ctx());
    expect(v2.ok).toBe(true);
  });

  it('preflight hashes the v3 agent file on disk; an overlay or a planted preset is refused', async () => {
    const pre = await createKiroAdapter({ runner: v3Runner().run, platform: 'darwin' }).preflight(o(), v3Ctx());
    expect(pre.data['agentHash']).toBe(KIRO_V3_AGENT_SHA256);
    expect(pre.checks.find((c) => c.name === 'isolation')?.detail).toContain(KIRO_V3_AGENT_SHA256.slice(0, 16));
    const overlay = await createKiroAdapter({ runner: v3Runner().run, platform: 'darwin', profileOverlay: { tools: ['*'] } }).preflight(o(), v3Ctx());
    expect(overlay).toMatchObject({ ok: false, failureClass: 'setup' });
    const preset = await createKiroAdapter({ runner: v3Runner().run, platform: 'darwin', presetPlant: 'presets: []\n' }).preflight(o(), v3Ctx());
    expect(preset).toMatchObject({ ok: false, failureClass: 'setup' });
  });

  it('the v3 canary plant: a permission preset in the leg KIRO_HOME on any version, caught after the leg', async () => {
    const preset = 'presets:\n  - name: canary\n    rules:\n      - capability: fs_read\n        match: ["/**"]\n        effect: allow\n';
    const run = await launchV3({ ...v3Case({ steps: turn(READ_NOTES('t1')) }), version: '3.6.0' }, { version: '3.6.0', adapter: { presetPlant: preset } }).catch((e: unknown) => e);
    // Preflight refuses the plant (the canary launches with a second adapter after a clean preflight).
    expect(String(run)).toContain('permission preset planted');
    const occupant: Occupant = { backend: 'kiro', model: V3_MODEL, authHome: tokenHome() };
    const ctx = v3Ctx();
    writeFileSync(join(occupant.authHome ?? '', 'fake-kiro-v3.json'), JSON.stringify({ ...v3Case({ steps: turn(READ_NOTES('t1')) }), version: '3.6.0' }));
    const pre = await createKiroAdapter({ bin: FAKE_V3, runner: v3Runner('3.6.0').run, platform: 'darwin' }).preflight(occupant, ctx);
    expect(pre.ok, pre.reason ?? '').toBe(true);
    const planted = createKiroAdapter({ bin: FAKE_V3, runner: v3Runner('3.6.0').run, platform: 'darwin', presetPlant: preset, gateWaitMs: 400 });
    const handle = await planted.launch(occupant, ctx, pre);
    while ((await planted.poll(handle)).status !== 'done') await new Promise((res) => setTimeout(res, 40));
    expect(readFileSync(join(ctx.legDir, 'kiro-home', 'settings', 'permissions.yaml'), 'utf8')).toBe(preset);
    const r = await planted.ratify(handle, ctx);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['presets-after']);
  });

  it('the v3 agent file: the exact measured bytes', () => {
    expect(Buffer.from(KIRO_V3_AGENT_TEXT, 'utf8')).toEqual(AGENT_FILE_BYTES);
    expect(createHash('sha256').update(KIRO_V3_AGENT_TEXT).digest('hex')).toBe(KIRO_V3_AGENT_SHA256);
    expect(KIRO_V3_AGENT_SHA256.startsWith('a97e6cc036f21ce5')).toBe(true);
    expect(KIRO_V3_AGENT_TEXT.endsWith('}')).toBe(true);
    const parsed = JSON.parse(KIRO_V3_AGENT_TEXT) as { tools: string[]; permissions: { rules: Array<{ capability: string; effect: string }> }; model?: string };
    expect(parsed.tools).toEqual(['glob', 'grep', 'read']);
    expect(parsed.model).toBeUndefined();
    expect(parsed.permissions.rules.map((r) => `${r.capability}:${r.effect}`)).toEqual(['shell:deny', 'fs_write:deny', 'fs_read:allow', 'web_fetch:deny', 'web_search:deny']);
  });
});

describe('v3 units', () => {
  const callOf = (id: string, snapshots: Json[], over: Partial<AcpToolCall> = {}): AcpToolCall => ({
    id,
    fields: {},
    kinds: [...new Set(snapshots.map((s) => s['kind']).filter((k): k is string => typeof k === 'string'))],
    titles: [...new Set(snapshots.map((s) => s['title']).filter((k): k is string => typeof k === 'string'))],
    statuses: snapshots.map((s) => s['status']).filter((k): k is string => typeof k === 'string'),
    decision: null,
    rejectedAt: null,
    rejectedAtSnapshot: null,
    asked: null,
    snapshots,
    extraPaths: [],
    firstLine: 0,
    ...over,
  });
  const notice = { status: 'failed', title: 'Read File', rawOutput: { message: KIRO_V3_NOTICE }, content: [{ type: 'content', content: { type: 'text', text: KIRO_V3_NOTICE } }] };

  it('the denial notice is not output only after the client rejected the call', () => {
    const pending = { status: 'pending', title: 'Read File', kind: 'read', rawInput: { path: '../x' } };
    expect(kiroV3Ran(callOf('a', [pending, { title: 'Read File' }, notice], { decision: 'reject', rejectedAt: 1, rejectedAtSnapshot: 2 }))).toBe(false);
    // The same snapshot with no client rejection is output: the call ran.
    expect(kiroV3Ran(callOf('b', [pending, notice]))).toBe(true);
    // Reported before the rejection: output.
    expect(kiroV3Ran(callOf('c', [pending, notice, { title: 'Read File' }], { decision: 'reject', rejectedAt: 2, rejectedAtSnapshot: 2 }))).toBe(true);
    // An empty content list is a notice too.
    expect(kiroV3Ran(callOf('d', [pending, { title: 'Read File' }, { ...notice, content: [] }], { decision: 'reject', rejectedAt: 1, rejectedAtSnapshot: 2 }))).toBe(false);
  });

  it('Load Resource never completed is not run; completed is run', () => {
    const lr = { title: 'Load Resource', kind: 'other' };
    const failed = { ...lr, status: 'failed', rawOutput: { message: 'Use one exact resource ID from the current load_resource catalogue.' } };
    expect(kiroV3Ran(callOf('l1', [{ ...lr, status: 'in_progress' }, failed]))).toBe(false);
    expect(kiroV3Ran(callOf('l2', [{ ...lr, status: 'in_progress' }, { ...lr, status: 'completed', rawOutput: { message: 'x' } }]))).toBe(true);
  });

  it('the loop guard is recognised by its meta and its ids, not by option ids', () => {
    const meta = { _meta: { kiro: { toolId: 'user_input', userInputReason: 'failure-intervention' } } };
    expect(isLoopGuard({ id: 'failure-intervention-prompt-1', snapshots: [meta] })).toBe(true);
    expect(isLoopGuard({ id: 'failure-intervention-prompt-1', snapshots: [{}] })).toBe(false);
    expect(isLoopGuard({ id: 'failure-intervention-2', snapshots: [] })).toBe(true);
    expect(isLoopGuard({ id: 'tooluse_1', snapshots: [meta] })).toBe(false);
  });

  it('the v3 policy: cancel for the loop guard; a `cancel` option on any other request is never selected', () => {
    const root = realpathSync(scratch('sc-kiro3-pol-'));
    const policy = kiroV3Policy(root);
    const options = [
      { optionId: 'cancel', name: 'Cancel', kind: 'allow_once' },
      { optionId: 'keep-iterating', name: 'Keep Iterating', kind: 'allow_once' },
    ];
    const meta = { _meta: { kiro: { toolId: 'user_input', userInputReason: 'failure-intervention' } } };
    const known = (snapshots: Json[]) => (): KnownToolCall => ({ fields: {}, kinds: [], snapshots, requests: [] });
    expect(policy({ toolCall: { toolCallId: 'failure-intervention-prompt-9', status: 'pending' }, options }, known([meta]))).toMatchObject({ allow: false, select: 'cancel' });
    expect(policy({ toolCall: { toolCallId: 'failure-intervention-prompt-9', status: 'pending' }, options }, known([{}])).select).toBeUndefined();
    expect(policy({ toolCall: { toolCallId: 'tooluse_1', title: 'Read File', status: 'pending' }, options }, known([{ ...meta, title: 'Read File', kind: 'read', rawInput: { path: 'x' } }])).select).toBeUndefined();
  });

  it('the v3 request-path reader takes _meta.kiro.consent.resource; the policy judges it', () => {
    const root = realpathSync(scratch('sc-kiro3-pol-'));
    mkdirSync(join(root, 'src'));
    expect(requestPaths({ _meta: { kiro: { consent: { capability: 'fs_read', resource: '/x/y' } } } })).toEqual(['/x/y']);
    expect(requestPaths({ _meta: { kiro: { consent: { resource: ['/a', 3, '/b'] } } } })).toEqual(['/a', '/b']);
    const policy = kiroV3Policy(root);
    const ask = (resource: string) => ({ toolCall: { toolCallId: 'r1', title: 'Read File', status: 'pending' }, options: [], _meta: { kiro: { consent: { capability: 'fs_read', resource } } } });
    const known = (): KnownToolCall => ({ fields: {}, kinds: ['read'], snapshots: [{ title: 'Read File', kind: 'read', rawInput: { path: 'src/a.ts' }, _meta: { kiro: { toolOrigin: 'default' } } }], requests: [] });
    expect(policy(ask(join(root, 'src', 'a.ts')), known).allow).toBe(true);
    expect(policy(ask('/etc/passwd'), known).allow).toBe(false);
  });

  it('globs: a `..` segment anywhere is outside on v3, whatever it normalizes to', () => {
    const root = realpathSync(scratch('sc-kiro3-glob-'));
    const judge = (rawInput: Json, title = 'File Search') => judgeCall([{ title, kind: 'search', rawInput }], [], root, KIRO_V3_READS);
    expect(judge({ query: '.md$' }).inside).toBe(true);
    expect(judge({ query: '**/../x' }).inside).toBe(false);
    expect(judge({ query: 'needle' }, 'Grep Search').inside).toBe(true);
    expect(judge({ query: '../needle' }, 'Grep Search').inside).toBe(true);
    expect(judge({ query: 'x', includePattern: 'a/**/../../b' }, 'Grep Search').inside).toBe(false);
    expect(judge({}, 'File Search')).toMatchObject({ judgeable: true, inside: true });
    expect(judge({}, 'List Directory')).toMatchObject({ judgeable: false });
  });

  it('preset store texts', () => {
    for (const t of ['', '# none\n', 'presets: []\n', 'presets:\n', '{}', '{"presets":[]}']) expect(noPresets(t), t).toBe(true);
    for (const t of ['presets:\n  - name: x\n', '{"presets":[{"name":"x"}]}', 'rules: []']) expect(noPresets(t), t).toBe(false);
  });

  it('the recorded fixtures are the measured runs, scrubbed', () => {
    const files = readdirSync(new URL('./fixtures/kiro-v3/', import.meta.url).pathname).sort();
    expect(files).toEqual(['agent-file.json', 'followup.json', 'gate.json', 'happy.json', 'kiro-log-line.txt', 'signed-out.json']);
    expect(LOG_LINE).toContain('KiroCLI/${VERSION} KAS/0.66.119');
    expect(happySteps().length).toBeGreaterThan(30);
  });
});
