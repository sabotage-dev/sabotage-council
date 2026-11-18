#!/usr/bin/env node
// A scripted kiro-cli v3 ACP agent for tests (P11), replaying notifications recorded from kiro-cli 3.5.0 on the
// v3 engine (test/fixtures/kiro-v3, scrubbed). Newline-delimited JSON-RPC 2.0 on stdio.
//
// The case comes from $FAKE_ACP_CASE, else $HOME/fake-kiro-v3.json (the adapter scrubs every other variable). It
// writes $HOME/fake-kiro-v3-argv.json (argv, cwd, env names) and $HOME/fake-kiro-v3-answers.json (every permission
// answer the client gave), and the records the case lists (`startRecords` at start, `records` at the prompt's end).
// In every string ${SESSION}, ${CWD}, ${PARENT}, ${KIRO_HOME}, ${NONCE} and ${VERSION} are replaced.
//
// The case:
//   initialize: the initialize result (default: a small one)
//   sessionNew: { before: [msg], result: {...}, after: [msg] }: notifications around the session/new result; the
//     result gets sessionId and configOptions added
//   sessionNewError, initializeError, exitAtStart, stderr
//   config: the configOptions list at session/new
//   lateConfig: { delayMs, add: [option] }: options added (with a config_option_update) after session/new
//   onSet: { <configId>: [msg] }: notifications sent when that option is set, before its config_option_update
//   refuseSet: [configId]: set_config_option answers an error; forceConfig: { id: value }: the value reported
//   steps: the prompt's steps, in order:
//     { msg }                        one notification (`session/update` messages carry their sessionId)
//     { ask: params, answers: { <optionId> | cancelled: [step] }, otherwise: [step] }
//                                    a session/request_permission; the steps for the client's answer follow
//     { sleep: ms } | { exit: code } | { hang: true } | { write: { path, content } }
//   stopReason (default end_turn), promptError
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const home = process.env.HOME ?? '';
const caseFile = process.env.FAKE_ACP_CASE ?? join(home, 'fake-kiro-v3.json');
const kase = JSON.parse(readFileSync(caseFile, 'utf8'));
const args = process.argv.slice(2);
if (home !== '' && existsSync(home)) {
  writeFileSync(join(home, 'fake-kiro-v3-argv.json'), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort() }, null, 2));
}
const sessionId = kase.sessionId ?? 'sess_00000000-0000-4000-8000-000000000001';
const vars = {
  SESSION: sessionId,
  CWD: process.cwd(),
  PARENT: dirname(process.cwd()),
  KIRO_HOME: process.env.KIRO_HOME ?? '',
  NONCE: '',
  VERSION: kase.version ?? '3.5.0',
};
const subst = (s) => s.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const deep = (v) => (typeof v === 'string' ? subst(v) : Array.isArray(v) ? v.map(deep) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);

const send = (msg) => process.stdout.write(`${JSON.stringify(deep(msg))}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeRecords(list) {
  for (const r of list ?? []) {
    const path = subst(r.path);
    mkdirSync(dirname(path), { recursive: true });
    const body = typeof r.content === 'string' ? subst(r.content) : r.jsonl ? deep(r.jsonl).map((x) => JSON.stringify(x)).join('\n') + '\n' : JSON.stringify(deep(r.json), null, 2);
    if (r.append) appendFileSync(path, body);
    else writeFileSync(path, body);
  }
}

if (kase.stderr) process.stderr.write(subst(kase.stderr));
writeRecords(kase.startRecords);
if (kase.exitAtStart !== undefined) process.exit(kase.exitAtStart);

let config = JSON.parse(JSON.stringify(kase.config ?? []));
const forced = kase.forceConfig ?? {};
const applyForced = () => {
  for (const o of config) if (forced[o.id] !== undefined) o.currentValue = forced[o.id];
};
applyForced();
const configUpdate = () => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'config_option_update', configOptions: config } } });

let nextId = 1;
const waiting = new Map();
const requestClient = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

const answers = [];
async function runSteps(steps) {
  for (const step of steps ?? []) {
    if (step.msg) send(step.msg);
    else if (step.ask) {
      const res = await requestClient('session/request_permission', step.ask);
      const outcome = res?.result?.outcome ?? {};
      const key = outcome.outcome === 'selected' ? String(outcome.optionId) : 'cancelled';
      answers.push({ toolCallId: step.ask?.toolCall?.toolCallId ?? null, answer: key });
      if (home !== '') writeFileSync(join(home, 'fake-kiro-v3-answers.json'), JSON.stringify(answers));
      const branch = step.answers?.[key] ?? step.otherwise ?? [];
      await runSteps(branch);
    } else if (step.sleep) await sleep(step.sleep);
    else if (step.exit !== undefined) process.exit(step.exit);
    else if (step.hang) await new Promise(() => {});
    else if (step.write) writeRecords([step.write]);
  }
}

async function onRequest(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    if (kase.initializeError) return send({ jsonrpc: '2.0', id, error: kase.initializeError });
    return send({ jsonrpc: '2.0', id, result: kase.initialize ?? { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  }
  if (method === 'session/new') {
    if (kase.sessionNewError) return send({ jsonrpc: '2.0', id, error: kase.sessionNewError });
    if (home !== '') writeFileSync(join(home, 'fake-kiro-v3-session-new.json'), JSON.stringify(params));
    const sn = kase.sessionNew ?? {};
    for (const m of sn.before ?? []) send(m);
    send({ jsonrpc: '2.0', id, result: { ...(sn.result ?? {}), sessionId, configOptions: config } });
    for (const m of sn.after ?? []) send(m);
    if (kase.lateConfig) {
      setTimeout(() => {
        for (const o of kase.lateConfig.add ?? []) if (!config.some((c) => c.id === o.id)) config.push(JSON.parse(JSON.stringify(o)));
        applyForced();
        configUpdate();
      }, kase.lateConfig.delayMs ?? 50);
    }
    return undefined;
  }
  if (method === 'session/set_config_option') {
    if ((kase.refuseSet ?? []).includes(params.configId)) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `unsupported value for ${params.configId}` } });
    const o = config.find((x) => x.id === params.configId);
    if (!o) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown config option: ${params.configId}` } });
    o.currentValue = params.value;
    applyForced();
    for (const m of kase.onSet?.[params.configId] ?? []) send(m);
    configUpdate();
    return send({ jsonrpc: '2.0', id, result: { configOptions: config } });
  }
  if (method === 'session/prompt') {
    const text = params?.prompt?.[0]?.text ?? '';
    vars.NONCE = /NONCE:\s*(\S+)/.exec(text)?.[1] ?? '';
    if (home !== '') writeFileSync(join(home, 'fake-kiro-v3-prompt.json'), JSON.stringify(params));
    await runSteps(kase.steps);
    writeRecords(kase.records);
    if (kase.promptError) return send({ jsonrpc: '2.0', id, error: kase.promptError });
    return send({ jsonrpc: '2.0', id, result: { stopReason: kase.stopReason ?? 'end_turn' } });
  }
  return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `fake kiro: no ${method}` } });
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
    } else if (msg.method === 'session/cancel' && home !== '') writeFileSync(join(home, 'fake-kiro-v3-cancelled'), '1');
  }
});
process.stdin.on('end', () => {
  if (kase.ignoreStdinClose) return;
  process.exit(0);
});
