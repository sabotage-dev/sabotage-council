#!/usr/bin/env node
// A stand-in for the claude CLI as the headless adjudicator (P7) in tests. It writes the stream-json a real run writes
// (system/init, assistant tool uses, tool results, the result line) and the transcript under
// <projectsDirectory>/<slug>/<session>.jsonl, runs the PreToolUse hook from the --settings file on every tool call
// (a denial is honoured and reported, as the real CLI does), and applies Edit calls to the working copy.
//
// Behaviour comes from $HOME/fake-adjudicator.json, because the engine scrubs every other variable:
// { version, launches: [scenario, ...] }: the Nth `-p` launch takes the Nth scenario (the last repeats); the count
// lives in $HOME. A scenario may set:
// - initTools, permissionMode, initVersion, initModel: what system/init reports;
// - hangAfterInit: print init, then wait `actAfterMs` (default 1500) and act as a model that calls the first offered
//   tool beyond the four: it writes $HOME/TOOL-EXECUTED (the canary's side effect), then answers. A run the init gate
//   kills never gets there;
// - toolUses: [{ name, input, result }] calls before the output Edit (paths relative to the cwd are kept as given);
//   `result` is the tool's own result record (tool_use_result in the stream, toolUseResult in the transcript); by
//   default an allowed Read reports { file: { filePath } } and an Edit { filePath }, resolved against the cwd;
// - output: the ADJUDICATION.json to write with one Edit (an object or a string); `${NONCE}`, `${HEAD}` and `${ROUND}`
//   in a string are the round's, read from _council/ROUND.json. Absent: no Edit (the placeholder stays);
// - transcriptOnly: [{ name, input }] tool uses that appear in the transcript only (no hook, no stream line);
// - model, effort: what the transcript records per request (default: the --model and --effort given);
// - result: fields merged into the result line; resultOmitted: no result line;
// - writeIntoCopy: a file written into the cwd outside _mainloop/ (changes the copy);
// - sidechain: one transcript entry marked isSidechain;
// - skipHook: do not run the hook (a CLI that did not honour it);
// - initSession: the session id system/init reports; malformedLine: a broken line in the stream; noTranscript: no
//   transcript file at all.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const home = process.env.HOME ?? '';
const config = JSON.parse(readFileSync(join(home, 'fake-adjudicator.json'), 'utf8'));
const args = process.argv.slice(2);
const projects = join(home, 'projects');
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === '--version') {
  process.stdout.write(`${config.version ?? '2.1.325'} (Claude Code)\n`);
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: config.loggedIn ?? true, authMethod: 'claude.ai', apiProvider: 'firstParty', projectsDirectory: projects }));
  process.exit(0);
}
if (args[0] === 'plugin' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(config.plugins ?? []));
  process.exit(0);
}
if (args[0] !== '-p') {
  process.stderr.write(`fake-claude-adjudicator: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}

const counter = join(home, 'fake-adjudicator-launches');
const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
writeFileSync(counter, String(n));
const launches = config.launches ?? [{}];
const s = launches[Math.min(n - 1, launches.length - 1)];
const stdin = readFileSync(0, 'utf8');
const session = argValue('--session-id');
const model = argValue('--model');
const effort = argValue('--effort');
const settingsFile = argValue('--settings');
const cwd = process.cwd();
writeFileSync(join(home, `argv-${n}.json`), JSON.stringify({ args, cwd, env: Object.keys(process.env).sort() }, null, 2));
writeFileSync(join(home, `stdin-${n}.txt`), stdin);
if (settingsFile) writeFileSync(join(home, `settings-${n}.json`), readFileSync(settingsFile, 'utf8'));

const transcriptDir = join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'));
mkdirSync(transcriptDir, { recursive: true });
const transcript = join(transcriptDir, `${session}.jsonl`);
const out = (row) => process.stdout.write(`${JSON.stringify(row)}\n`);
const record = (row) => {
  if (!s.noTranscript) appendFileSync(transcript, `${JSON.stringify({ sessionId: session, cwd, ...row })}\n`);
};

const offered = s.initTools ?? ['Edit', 'Glob', 'Grep', 'Read'];
out({
  type: 'system',
  subtype: 'init',
  session_id: s.initSession ?? session,
  cwd: s.initCwd ?? cwd,
  model: s.initModel ?? model,
  tools: offered,
  permissionMode: s.permissionMode ?? 'dontAsk',
  claude_code_version: s.initVersion ?? config.version ?? '2.1.325',
  mcp_servers: [],
});

if (s.malformedLine) process.stdout.write('{"type": "assistant", broken\n');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let msg = 0;
const denials = [];
const reqModel = s.model ?? model;
const reqEffort = s.effort ?? effort;

function turn(content) {
  msg += 1;
  const id = `msg_${n}_${msg}`;
  record({ type: 'api-request', params: { model: reqModel, output_config: { effort: reqEffort } }, querySource: 'sdk' });
  const message = { id, model: reqModel, role: 'assistant', content };
  out({ type: 'assistant', session_id: session, message });
  record({ type: 'assistant', message, ...(s.sidechain && msg === 1 ? { isSidechain: true } : {}) });
}

function hookCommand() {
  if (!settingsFile) return null;
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  const entry = settings.hooks?.PreToolUse?.[0]?.hooks?.[0];
  return entry?.command ?? null;
}

/** Runs the PreToolUse hook as the CLI does; returns the deny reason, or null to go on. */
function runHook(name, input, toolUseId) {
  const command = hookCommand();
  if (command === null || s.skipHook) return null;
  const r = spawnSync('/bin/sh', ['-c', command], {
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: toolUseId }),
    encoding: 'utf8',
  });
  if (r.status === 2) return r.stderr.trim() || 'blocked';
  try {
    const decision = JSON.parse(r.stdout.trim() || '{}');
    if (decision.hookSpecificOutput?.permissionDecision === 'deny') return decision.hookSpecificOutput.permissionDecisionReason;
  } catch {
    return null;
  }
  return null;
}

function callTool(name, input, given) {
  const toolUseId = `toolu_${n}_${msg + 1}`;
  turn([{ type: 'tool_use', id: toolUseId, name, input }]);
  const denied = runHook(name, input, toolUseId);
  let text = 'ok';
  const abs = (p) => (isAbsolute(p) ? p : join(cwd, p));
  let toolResult = given;
  if (toolResult === undefined && denied === null && name === 'Read') toolResult = { type: 'text', file: { filePath: abs(input.file_path) } };
  if (toolResult === undefined && denied === null && name === 'Edit') toolResult = { filePath: abs(input.file_path) };
  if (denied !== null) {
    denials.push({ tool_name: name, tool_use_id: toolUseId, tool_input: input });
    text = `Permission denied: ${denied}`;
  } else if (name === 'Edit') {
    const file = isAbsolute(input.file_path) ? input.file_path : join(cwd, input.file_path);
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, before.split(input.old_string).join(input.new_string));
  } else if (name.startsWith('mcp__')) {
    writeFileSync(join(home, 'TOOL-EXECUTED'), `${name}\n`);
  }
  const result = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text }] } };
  out({ ...result, session_id: session, ...(toolResult !== undefined ? { tool_use_result: toolResult } : {}) });
  record({ ...result, ...(toolResult !== undefined ? { toolUseResult: toolResult } : {}) });
}

if (s.hangAfterInit) {
  // A model that calls the first plugin tool it was offered: only a kill before this point stops the side effect.
  sleep(s.actAfterMs ?? 1500);
  const plugin = offered.find((t) => !['Read', 'Glob', 'Grep', 'Edit'].includes(t));
  if (plugin) callTool(plugin, {});
}

for (const use of s.toolUses ?? []) callTool(use.name, use.input, use.result);
for (const use of s.transcriptOnly ?? []) {
  record({ type: 'assistant', message: { id: `msg_${n}_t${use.name}`, model: reqModel, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_t_${use.name}`, name: use.name, input: use.input }] } });
}
if (s.writeIntoCopy) writeFileSync(join(cwd, s.writeIntoCopy), 'written by the adjudicator\n');

if (s.output !== undefined) {
  const round = JSON.parse(readFileSync(join(cwd, '_council', 'ROUND.json'), 'utf8'));
  let text = typeof s.output === 'string' ? s.output : JSON.stringify(s.output, null, 2);
  text = text.split('${NONCE}').join(round.nonce).split('${HEAD}').join(round.head_sha).split('${ROUND}').join(String(round.round_no));
  const file = '_mainloop/ADJUDICATION.json';
  callTool('Read', { file_path: join(cwd, file) });
  callTool('Edit', { file_path: join(cwd, file), old_string: readFileSync(join(cwd, file), 'utf8'), new_string: text });
}

turn([{ type: 'text', text: 'DONE' }]);
if (!s.resultOmitted) {
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'DONE',
    session_id: session,
    total_cost_usd: 0.0123,
    duration_ms: 1234,
    num_turns: msg,
    usage: { input_tokens: 100, output_tokens: 20 },
    modelUsage: { [reqModel]: { inputTokens: 100 } },
    permission_denials: denials,
    ...(s.result ?? {}),
  });
}
