#!/usr/bin/env node
// A scripted ACP agent for tests: newline-delimited JSON-RPC 2.0 on stdio, playing one case file.
// The case comes from $FAKE_ACP_CASE, else $HOME/fake-acp.json (the adapters scrub every other variable).
// It writes $HOME/fake-acp-argv.json (argv, cwd, env names) when $HOME is set, and the records the case lists
// (`startRecords` at start, `records` when the prompt arrives), with ${SESSION}, ${CWD}, ${GEMINI_DIR},
// ${KIRO_HOME} and ${LOG_FILE} replaced.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const home = process.env.HOME ?? '';
const caseFile = process.env.FAKE_ACP_CASE ?? join(home, 'fake-acp.json');
const kase = JSON.parse(readFileSync(caseFile, 'utf8'));
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
if (home !== '' && existsSync(home)) {
  writeFileSync(join(home, 'fake-acp-argv.json'), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() }, null, 2));
}
const sessionId = kase.sessionId ?? randomUUID();
const vars = {
  SESSION: sessionId,
  CWD: process.cwd(),
  GEMINI_DIR: argValue('--gemini-dir') ?? '',
  KIRO_HOME: process.env.KIRO_HOME ?? '',
  LOG_FILE: argValue('--log-file') ?? '',
};
const subst = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const deep = (v) => (typeof v === 'string' ? subst(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);

if (kase.stderr) process.stderr.write(subst(kase.stderr));
// Records an agent writes as it starts (agy opens its log before the session exists).
writeRecords(kase.startRecords);
for (const line of kase.stdoutBefore ?? []) process.stdout.write(`${subst(line)}\n`);
if (kase.exitAtStart !== undefined) process.exit(kase.exitAtStart);

const defaultConfig = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake-model', options: [{ value: 'fake-model', name: 'Fake' }, { value: 'other-model', name: 'Other' }] },
  { id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default' }, { value: 'accept-edits' }, { value: 'auto' }, { value: 'plan' }] },
];
let config = JSON.parse(JSON.stringify(kase.configOptions ?? defaultConfig));
const forced = kase.forceConfig ?? {};
const applyForced = () => {
  for (const o of config) if (forced[o.id] !== undefined) o.currentValue = forced[o.id];
};
applyForced();

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: u } });
let nextId = 1000;
const waiting = new Map();
const requestClient = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeRecords(list = kase.records) {
  for (const r of list ?? []) {
    const path = subst(r.path);
    mkdirSync(dirname(path), { recursive: true });
    const body = typeof r.content === 'string' ? subst(r.content) : r.jsonl ? deep(r.jsonl).map((x) => JSON.stringify(x)).join('\n') + '\n' : JSON.stringify(deep(r.json), null, 2);
    if (r.append) appendFileSync(path, body);
    else writeFileSync(path, body);
  }
}

const OPTIONS = [
  { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always deny', kind: 'reject_always' },
];

async function runSteps(steps) {
  for (const step of deep(steps)) {
    if (step.text !== undefined) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.text } });
    else if (step.thought !== undefined) update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thought } });
    else if (step.tool) {
      const tc = step.tool;
      update({ sessionUpdate: 'tool_call', status: 'pending', ...tc });
      let allowed = !step.ask;
      if (step.ask) {
        const asked = step.askWith ?? { toolCallId: tc.toolCallId, title: tc.title, kind: tc.kind, rawInput: tc.rawInput, locations: tc.locations, status: 'pending' };
        const res = await requestClient('session/request_permission', { sessionId, toolCall: asked, options: step.options ?? OPTIONS });
        const picked = (step.options ?? OPTIONS).find((o) => o.optionId === res?.result?.outcome?.optionId);
        allowed = picked !== undefined && picked.kind.startsWith('allow');
        if (step.record) writeFileSync(join(home, `fake-acp-permission-${tc.toolCallId}.json`), JSON.stringify(res));
      }
      if (allowed || step.runAnyway) {
        update({ sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: 'in_progress' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: 'completed', rawOutput: step.output ?? 'ok' });
      } else {
        update({ sessionUpdate: 'tool_call_update', toolCallId: tc.toolCallId, status: 'failed', rawOutput: 'denied' });
      }
    } else if (step.clientRequest) {
      const res = await requestClient(step.clientRequest.method, step.clientRequest.params ?? { sessionId });
      if (home !== '') writeFileSync(join(home, 'fake-acp-client-response.json'), JSON.stringify(res));
    } else if (step.configUpdate) {
      for (const o of config) if (step.configUpdate[o.id] !== undefined) o.currentValue = step.configUpdate[o.id];
      update({ sessionUpdate: 'config_option_update', configOptions: config });
    } else if (step.modeUpdate) update({ sessionUpdate: 'current_mode_update', currentModeId: step.modeUpdate });
    else if (step.usage) update({ sessionUpdate: 'usage_update', ...step.usage });
    else if (step.raw !== undefined) process.stdout.write(step.noNewline ? step.raw : `${step.raw}\n`);
    else if (step.stderr !== undefined) process.stderr.write(step.stderr);
    else if (step.sleep) await sleep(step.sleep);
    else if (step.exit !== undefined) process.exit(step.exit);
    else if (step.hang) await new Promise(() => {});
    else if (step.records) writeRecords();
  }
}

async function onRequest(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    if (kase.initializeError) return send({ jsonrpc: '2.0', id, error: kase.initializeError });
    return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: kase.agentInfo ?? { name: 'fake-acp', version: '0.0.1' }, authMethods: [] } });
  }
  if (method === 'session/new') {
    if (kase.sessionNewError) return send({ jsonrpc: '2.0', id, error: kase.sessionNewError });
    writeFileSync(join(home || '.', 'fake-acp-session-new.json'), JSON.stringify(params));
    const result = { sessionId };
    if (!kase.noConfigOptions) result.configOptions = config;
    if (kase.modes) result.modes = kase.modes;
    if (kase.models) result.models = kase.models;
    return send({ jsonrpc: '2.0', id, result });
  }
  if (method === 'session/set_config_option') {
    if ((kase.refuseConfig ?? []).includes(params.configId)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unsupported value for ${params.configId}` } });
    const o = config.find((x) => x.id === params.configId);
    if (!o) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown config ${params.configId}` } });
    o.currentValue = params.value;
    applyForced();
    return send({ jsonrpc: '2.0', id, result: { configOptions: config } });
  }
  if (method === 'session/set_mode') {
    if (kase.refuseSetMode) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'mode not supported' } });
    return send({ jsonrpc: '2.0', id, result: {} });
  }
  if (method === 'session/prompt') {
    if (home !== '') writeFileSync(join(home, 'fake-acp-prompt.json'), JSON.stringify(params));
    writeRecords();
    await runSteps(kase.steps ?? []);
    if (kase.promptError) return send({ jsonrpc: '2.0', id, error: deep(kase.promptError) });
    const result = { stopReason: kase.stopReason ?? 'end_turn' };
    if (kase.usage) result.usage = kase.usage;
    send({ jsonrpc: '2.0', id, result });
    if (kase.exitAfterPrompt !== undefined) process.exit(kase.exitAfterPrompt);
    return undefined;
  }
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `fake agent: no ${method}` } });
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method !== undefined && msg.id !== undefined) void onRequest(msg);
    else if (msg.id !== undefined && waiting.has(msg.id)) {
      const resolve = waiting.get(msg.id);
      waiting.delete(msg.id);
      resolve(msg);
    } else if (msg.method === 'session/cancel' && home !== '') writeFileSync(join(home, 'fake-acp-cancelled'), '1');
  }
});
process.stdin.on('end', () => {
  if (kase.ignoreStdinClose) return;
  process.exit(0);
});
