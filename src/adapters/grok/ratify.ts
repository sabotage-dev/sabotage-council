import { existsSync, readFileSync } from 'node:fs';
import type { FailureClass } from '../../config/vocab.js';
import { collectPaths, judgePath, type ReadSet } from '../acp/policy.js';
import { readClaudeStream, type ClaudeStream } from '../claude/records.js';
import { isObject, num, readJsonl, str, type Json } from '../codex/records.js';
import { resolveLexical, rootAliases } from '../paths.js';
import { nonceOnFirstLine, verdictOf, type Ratification, type RatificationCheck } from '../types.js';
import { GROK_READ_TOOLS, grokLabel, grokModelMatches, type GrokSandbox } from './known.js';
import { eventsOf, findGrokSession, grokUsage, readGrokSession, type GrokSession } from './records.js';

/*
 * Grok failure signatures (plan 4.4) and ratification (plan 4.5), fail closed. Signatures are read from stderr
 * (ANSI stripped), the stdout `{"type":"error"}` objects and an error `result`, never from the answer text.
 */

export const GROK_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  { class: 'usage_limit', pattern: /status 402|Payment Required|usage balance exhausted|"http_status":\s*402/i },
  { class: 'auth', pattern: /Not signed in|status 40[13]\b|auth: external auth provider (?:failed|timed out)|\breauth(?:enticate)?\b/i },
  { class: 'setup', pattern: /could not apply the '[a-z-]+' sandbox profile|Refusing to start with its protections missing|unexpected argument|invalid value for/i },
  { class: 'model', pattern: /Couldn't set model|unknown model id|model \S+ (?:is )?(?:not found|unknown|unavailable)/i },
  { class: 'capacity', pattern: /at capacity due to high demand|status 5\d\d|status 429|rate.?limit/i },
  { class: 'timeout', pattern: /error_max_turns|max_turn_requests|wait for background work ran out/i },
  { class: 'transport', pattern: /ECONNRESET|ECONNREFUSED|socket hang up|stopped at its output limit/i },
];

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** The error texts of a grok leg: stderr (ANSI stripped), stdout error objects, an error result. */
export function grokErrorTexts(streamFile: string, stderr: string): string[] {
  const texts = [stderr.replace(ANSI, '')];
  if (existsSync(streamFile)) {
    for (const row of readJsonl(streamFile).rows) {
      if (str(row['type']) === 'error') texts.push(str(row['message']) ?? JSON.stringify(row));
      if (str(row['type']) === 'result' && (row['is_error'] === true || (str(row['subtype']) ?? 'success') !== 'success')) {
        texts.push(str(row['subtype']) ?? '', str(row['result']) ?? '', str(row['stop_reason']) ?? '');
      }
    }
  }
  return texts;
}

export function classifyGrokText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of GROK_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}

/** grok's read tools for the path audit: `grep` takes a regex `pattern` and searches the cwd when given no path. */
export const GROK_READS: ReadSet = {
  kinds: ['read', 'search'],
  names: GROK_READ_TOOLS,
  nameOf: (s) => str(s['name']),
  cwdDefault: ['grep', 'list_dir'],
  args: {
    grep: { text: ['pattern', 'query', 'regex'], globs: ['glob', 'include', 'exclude'] },
  },
};

export interface GrokRatifyInput {
  root: string;
  nonce: string;
  model: string;
  effort: string;
  sandbox: GrokSandbox;
  sessionId: string;
  cliVersion: string | null;
  streamFile: string;
  stderrFile: string;
  /** The grok home the leg ran on; the session dir is found under `sessions/`. */
  grokHome: string;
  timedOut: boolean;
  rootUnchanged: (() => { unchanged: boolean; changes: string[] }) | undefined;
}

export const GROK_CLASS_OF_CHECK: Readonly<Record<string, FailureClass>> = {
  stream: 'setup',
  session: 'setup',
  'session-dir': 'setup',
  'session-kind': 'setup',
  sandbox: 'setup',
  'mcp-started': 'setup',
  'read-paths-known': 'setup',
  cwd: 'contaminated',
  model: 'model',
  effort: 'model',
  offered: 'contaminated',
  'permission-mode': 'contaminated',
  'tools-used': 'contaminated',
  'read-paths': 'contaminated',
  instructions: 'contaminated',
  hooks: 'contaminated',
  'mcp-project': 'contaminated',
  'root-unchanged': 'contaminated',
  outcome: 'transport',
  result: 'transport',
  answer: 'empty',
  nonce: 'empty',
};

const PRECEDENCE: readonly FailureClass[] = ['contaminated', 'model', 'setup', 'transport', 'timeout', 'empty'];

export function grokFailureClass(failed: readonly string[], signature: FailureClass | null, timedOut: boolean): FailureClass | null {
  if (failed.length === 0) return null;
  const classes = new Set<FailureClass>(failed.map((name) => GROK_CLASS_OF_CHECK[name] ?? 'setup'));
  if (classes.has('contaminated')) return 'contaminated';
  if (signature !== null) return signature;
  if (timedOut) return 'timeout';
  for (const cls of PRECEDENCE) if (classes.has(cls)) return cls;
  return 'setup';
}

/** The answer: the `result` line's text on success, else the last assistant text block. */
export function grokAnswer(stream: ClaudeStream): string | null {
  const r = stream.result;
  if (r && r['is_error'] !== true) {
    const text = str(r['result']);
    if (text !== null && text.trim() !== '') return text;
  }
  const last = stream.texts[stream.texts.length - 1];
  return last !== undefined && last.trim() !== '' ? last : null;
}

const READ_SET: readonly string[] = GROK_READ_TOOLS;
const sameSet = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** Stream tool uses with their ids (the claude reader keeps names and inputs only). */
function streamToolUses(streamFile: string): Array<{ id: string | null; name: string; input: Json }> {
  if (!existsSync(streamFile)) return [];
  const out: Array<{ id: string | null; name: string; input: Json }> = [];
  for (const row of readJsonl(streamFile).rows) {
    if (str(row['type']) !== 'assistant' || !isObject(row['message']) || !Array.isArray(row['message']['content'])) continue;
    for (const block of row['message']['content']) {
      if (isObject(block) && str(block['type']) === 'tool_use') {
        out.push({ id: str(block['id']), name: str(block['name']) ?? '', input: isObject(block['input']) ? block['input'] : {} });
      }
    }
  }
  return out;
}

/** The paths one call names, by grok's argument semantics. */
function callPaths(name: string, input: Json): { paths: string[]; problems: string[] } {
  const c = collectPaths([{ name, rawInput: input }], [], GROK_READS, [name]);
  if (c.paths.length === 0 && c.problems.length === 0 && (GROK_READS.cwdDefault ?? []).includes(name)) return { paths: ['.'], problems: [] };
  if (c.paths.length === 0 && c.problems.length === 0) return { paths: [], problems: ['names no path'] };
  return c;
}

export function ratifyGrokLeg(input: GrokRatifyInput): Ratification {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const aliases = rootAliases(input.root);
  const isRootPath = (p: string | null): boolean => p !== null && aliases.includes(p.replace(/\/+$/, ''));
  const stream = readClaudeStream(input.streamFile);
  const stderr = existsSync(input.stderrFile) ? readFileSync(input.stderrFile, 'utf8') : '';
  const signature = classifyGrokText(grokErrorTexts(input.streamFile, stderr));
  const init = stream.init;
  const result = stream.result;

  check(
    'stream',
    init !== null && result !== null && stream.malformed === 0 && stream.extraInit === 0 && !stream.tornTail,
    init === null ? 'no system/init in the stream' : `init + ${result ? 'result' : 'no result'}; ${stream.malformed} malformed${stream.tornTail ? '; the last line is torn' : ''}${stream.extraInit > 0 ? '; a second init or result' : ''}`,
  );
  const initSession = init ? str(init['session_id']) : null;
  const resultSession = result ? str(result['session_id']) : null;
  check('session', initSession === input.sessionId && (result === null || resultSession === input.sessionId), `init ${String(initSession)}, result ${String(resultSession)}, launched ${input.sessionId}`);

  const found = findGrokSession(input.grokHome, input.sessionId);
  const s: GrokSession | null = found.path !== null ? readGrokSession(found.path) : null;
  const summaryInfo = s?.summary && isObject(s.summary['info']) ? s.summary['info'] : null;
  check(
    'session-dir',
    s !== null && s.problems.length === 0 && summaryInfo !== null && str(summaryInfo['id']) === input.sessionId && s.eventsMalformed === 0 && s.updatesMalformed === 0 && s.chatMalformed === 0,
    s === null
      ? `${found.matches.length} session dir(s) for ${input.sessionId} under ${input.grokHome}/sessions`
      : s.problems.length > 0
        ? `${s.dir}: ${s.problems.join('; ')}`
        : `${s.dir}; summary id ${String(summaryInfo ? summaryInfo['id'] : null)}; ${s.eventsMalformed + s.updatesMalformed + s.chatMalformed} malformed line(s)`,
  );
  const none = s === null;
  const noRecord = 'no session record (session-dir fails)';
  const kind = s?.summary ? str(s.summary['session_kind']) : null;
  check('session-kind', none || kind === 'headless', none ? noRecord : `session_kind ${String(kind)}`);

  const promptCwd = s?.promptContext ? str(s.promptContext['working_directory']) : null;
  const cwds: Array<[string, string | null]> = [
    ['init', init ? str(init['cwd']) : null],
    ...(none ? [] : ([['summary', summaryInfo ? str(summaryInfo['cwd']) : null], ['prompt_context', promptCwd], ['session key', found.keyedCwd]] as Array<[string, string | null]>)),
  ];
  const badCwd = cwds.filter(([, c]) => !isRootPath(c));
  check('cwd', badCwd.length === 0, badCwd.length === 0 ? 'cwd = root in init, summary, prompt context and the session key' : `cwd not the root: ${badCwd.map(([w, c]) => `${w} ${String(c)}`).join(', ')}`);

  const usage = s ? grokUsage(s) : null;
  const requested: Array<[string, string | null]> = [
    ['init', init ? str(init['model']) : null],
    ...(none ? [] : ([['summary', s?.summary ? str(s.summary['current_model_id']) : null], ...eventsOf(s as GrokSession, 'turn_started').map((e) => ['turn_started', str(e['model_id'])] as [string, string | null])] as Array<[string, string | null]>)),
  ];
  const served: Array<[string, string | null]> = [
    ...(result && isObject(result['modelUsage']) ? Object.keys(result['modelUsage']).map((m) => ['result', m] as [string, string | null]) : []),
    ...(none || s?.usage === null ? [] : ([['usage primary', usage?.primary ?? null], ...(usage?.models ?? []).map((m) => ['usage', m] as [string, string | null])] as Array<[string, string | null]>)),
    ...(s?.assistantMeta ?? []).map((a) => ['chat', a.model] as [string, string | null]),
  ];
  const badRequested = requested.filter(([, m]) => m !== input.model);
  const badServed = served.filter(([, m]) => m === null || !grokModelMatches(m, input.model));
  check(
    'model',
    badRequested.length === 0 && badServed.length === 0 && served.length > 0,
    badRequested.length + badServed.length > 0
      ? `not the pin ${input.model}: ${[...badRequested, ...badServed].map(([w, m]) => `${w} ${String(m)}`).join(', ')}`
      : served.length === 0
        ? 'no served model in the result or the session record'
        : `requested ${input.model}; served ${[...new Set(served.map(([, m]) => m))].join(', ')}`,
  );
  const efforts: Array<[string, string | null]> = none ? [] : [['summary', s?.summary ? str(s.summary['reasoning_effort']) : null], ...(s?.assistantMeta ?? []).map((a) => ['chat', a.effort] as [string, string | null])];
  const badEffort = efforts.filter(([, e]) => e !== input.effort);
  check('effort', none || (efforts.length > 1 && badEffort.length === 0), none ? noRecord : badEffort.length > 0 ? `effort not the pin ${input.effort}: ${badEffort.map(([w, e]) => `${w} ${String(e)}`).join(', ')}` : `effort ${input.effort} in the summary and ${efforts.length - 1} assistant turn(s)`);

  const initTools = init && Array.isArray(init['tools']) && init['tools'].every((t) => typeof t === 'string') ? (init['tools'] as string[]) : null;
  const offered = s?.offered ?? null;
  check(
    'offered',
    initTools !== null && sameSet(initTools, READ_SET) && (none || (offered !== null && sameSet(offered, READ_SET))),
    `tool_definitions.json ${none ? 'not found (session-dir fails)' : offered === null ? 'unreadable' : `[${offered.join(', ')}]`}; system/init ${initTools === null ? 'no tools list' : `[${initTools.join(', ')}]`}; must be exactly ${READ_SET.join(', ')}`,
  );
  const mode = init ? str(init['permissionMode']) : null;
  const yolo = none ? [] : eventsOf(s as GrokSession, 'turn_started').map((e) => e['yolo_mode']);
  check('permission-mode', mode === 'dontAsk' && yolo.every((y) => y === false) && (none || yolo.length > 0), `permissionMode ${String(mode)}; yolo_mode ${yolo.map(String).join(', ') || 'not recorded'}`);
  const sandbox = s?.summary ? str(s.summary['sandbox_profile']) : null;
  check('sandbox', none || sandbox === input.sandbox, none ? noRecord : `sandbox_profile ${String(sandbox)}, the seat asked for ${input.sandbox}`);

  const uses = streamToolUses(input.streamFile);
  const started = none ? [] : eventsOf(s as GrokSession, 'tool_started').map((e) => str(e['tool_name']));
  const completed = none ? [] : eventsOf(s as GrokSession, 'tool_completed').map((e) => str(e['tool_name']));
  const updateCalls = s ? [...s.toolCalls.values()] : [];
  // Every reported name counts, on every record (grok F5): stream uses, starts, completions, every update snapshot.
  const names = [...uses.map((u) => u.name), ...started, ...completed, ...updateCalls.flatMap((c) => c.names)];
  const forbidden = [...new Set(names.filter((n) => n === null || !READ_SET.includes(n)).map(String))];
  const twoNames = updateCalls.filter((c) => c.names.length > 1);
  check(
    'tools-used',
    forbidden.length === 0 && twoNames.length === 0,
    forbidden.length > 0
      ? `tools beyond the read set: ${forbidden.join(', ')}`
      : twoNames.length > 0
        ? `calls reported under more than one tool name: ${twoNames.map((c) => `${c.id} (${c.names.join(', ')})`).join('; ')}`
        : `${uses.length} tool use(s) in the stream, ${started.length} started, ${completed.length} completed, all reads`,
  );

  // N9: the read paths come from updates.jsonl: every rawInput, every `_meta` input and every `locations` list of
  // every snapshot (never merged, codex F4), plus the paths the read's own output names; the stream's tool uses
  // are judged too and must agree.
  const outside: string[] = [];
  const unknown: string[] = [];
  const judge = (label: string, p: string, where: string): string => {
    const j = judgePath(p, input.root, aliases);
    if (!j.inside) outside.push(`${label} ${p} (${j.why}${where})`);
    return resolveLexical(p, input.root);
  };
  const recorded = new Map<string, Set<string>>();
  for (const call of updateCalls) {
    const label = call.names[0] ?? '?';
    const seen = new Set<string>();
    recorded.set(call.id, seen);
    if (call.inputs.length === 0) {
      unknown.push(`${call.id} (${label}) has no rawInput in updates.jsonl`);
      continue;
    }
    for (const raw of call.inputs) {
      const c = callPaths(label, raw);
      if (c.problems.length > 0) unknown.push(`${call.id} (${label}): ${c.problems.join('; ')}`);
      for (const p of c.paths) seen.add(judge(label, p, ''));
    }
    for (const p of call.outputPaths) judge(label, p, ', in its output');
  }
  for (const u of uses) {
    const c = callPaths(u.name, u.input);
    if (c.problems.length > 0) unknown.push(`stream tool use ${String(u.id)} (${u.name}): ${c.problems.join('; ')}`);
    const mine = c.paths.map((p) => judge(u.name, p, ', stream'));
    const theirs = u.id !== null ? recorded.get(u.id) : undefined;
    if (theirs === undefined) unknown.push(`stream tool use ${String(u.id)} (${u.name}) is not in updates.jsonl`);
    else {
      const missing = mine.filter((p) => !theirs.has(p));
      if (missing.length > 0) unknown.push(`stream tool use ${String(u.id)} names paths updates.jsonl does not: ${missing.join(', ')}`);
    }
  }
  const completedIds = none ? [] : eventsOf(s as GrokSession, 'tool_completed').map((e) => str(e['tool_call_id']));
  for (const id of completedIds) if (id === null || !s?.toolCalls.has(id)) unknown.push(`completed tool call ${String(id)} is not in updates.jsonl`);
  check('read-paths', outside.length === 0, outside.length === 0 ? `every read path inside the root (${updateCalls.length} call(s) in updates.jsonl)` : [...new Set(outside)].join('; '));
  check('read-paths-known', none || unknown.length === 0, none ? noRecord : unknown.length === 0 ? 'every tool call has its paths in updates.jsonl, and every stream tool use and completed call is there and agrees' : unknown.join('; '));

  const injected = s?.promptContext && Array.isArray(s.promptContext['agents_md_files']) ? s.promptContext['agents_md_files'] : null;
  check('instructions', none || (injected !== null && injected.length === 0), none ? noRecord : injected === null ? 'prompt_context.json has no agents_md_files list' : injected.length === 0 ? 'no instruction file injected' : `instruction files injected: ${JSON.stringify(injected).slice(0, 300)}`);
  const ranHooks = (s?.hookRuns ?? []).filter((h) => !Array.isArray(h['runs']) || h['runs'].length > 0);
  check('hooks', ranHooks.length === 0, ranHooks.length === 0 ? 'no hook ran' : `hooks ran: ${ranHooks.map((h) => str(h['event_name']) ?? '?').join(', ')}`);

  const starting = none ? [] : eventsOf(s as GrokSession, 'mcp_server_starting');
  const startedNames = starting.map((e) => str(e['server_name']) ?? '?');
  const resolved = none ? [] : eventsOf(s as GrokSession, 'mcp_config_resolved').flatMap((e) => (Array.isArray(e['servers']) ? e['servers'] : []));
  const sourceOf = (name: string): string => {
    const r = resolved.find((x) => isObject(x) && str(x['name']) === name);
    return isObject(r) ? (str(r['source']) ?? '?') : '?';
  };
  check('mcp-started', startedNames.length === 0, startedNames.length === 0 ? 'no MCP server started' : `MCP servers started in the leg: ${startedNames.map((n) => `${n} (source ${sourceOf(n)})`).join(', ')} (a leg that starts an MCP server fails, owner ruling)`);
  const fromRoot = startedNames.filter((n) => sourceOf(n) !== 'local');
  check('mcp-project', fromRoot.length === 0, fromRoot.length === 0 ? 'no MCP server from outside the user grok config started' : `MCP servers not from the user grok config started: ${fromRoot.join(', ')}`);

  const ended = none ? [] : eventsOf(s as GrokSession, 'turn_ended').map((e) => str(e['outcome']));
  check('outcome', none || (ended.length > 0 && ended.every((o) => o === 'completed')), none ? noRecord : `turn_ended ${ended.map(String).join(', ') || 'missing'}`);
  const subtype = result ? str(result['subtype']) : null;
  check('result', result !== null && result['is_error'] === false && subtype === 'success', result === null ? 'no result line' : `is_error ${String(result['is_error'])}, subtype ${String(subtype)}`);

  const answer = grokAnswer(stream);
  check('answer', answer !== null, answer === null ? 'no answer' : 'answer in the result');
  const nonce = nonceOnFirstLine(answer, input.nonce);
  check('nonce', nonce.ok, nonce.detail);
  const residue = input.rootUnchanged?.();
  check('root-unchanged', residue?.unchanged === true, residue === undefined ? 'no residue sweep was given (fails closed)' : residue.unchanged ? 'tree hash unchanged' : `root changed: ${residue.changes.slice(0, 10).join(', ')}`);

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const failureClass = grokFailureClass(failed, signature, input.timedOut);
  const { ok, status } = verdictOf(checks, failureClass);
  const usageRow = result && isObject(result['usage']) ? result['usage'] : {};
  return {
    status,
    ok,
    failureClass,
    checks,
    enforcement: grokLabel(input.cliVersion, sandbox === 'read-only' || sandbox === 'off' ? sandbox : null, startedNames.length > 0),
    recordPath: s?.dir ?? null,
    sessionId: initSession,
    cliVersion: input.cliVersion,
    modelObserved: usage?.primary ?? (s?.assistantMeta[0]?.model ?? null),
    effortObserved: s?.summary ? str(s.summary['reasoning_effort']) : null,
    cwdObserved: init ? str(init['cwd']) : null,
    cwdOk: checks.find((c) => c.name === 'cwd')?.ok ?? false,
    toolsOffered: offered ?? initTools ?? [],
    toolsUsed: [...new Set(names.filter((n): n is string => n !== null))].sort(),
    tokensIn: usage?.tokensIn ?? num(usageRow['input_tokens']),
    tokensOut: usage?.tokensOut ?? num(usageRow['output_tokens']),
    costUsd: usage?.costUsd ?? (result ? num(result['total_cost_usd']) : null),
    credits: null,
    quotaUsedPct: null,
    quotaNote: null,
    durationMs: result ? num(result['duration_ms']) : null,
    nonceSeen: nonce.ok,
    rootMutated: residue === undefined ? null : !residue.unchanged,
    detail: {
      sandbox,
      mcpStarted: startedNames,
      hookRuns: ranHooks.length,
      toolCalls: updateCalls.map((c) => ({ id: c.id, names: c.names, inputs: c.inputs, outputPaths: c.outputPaths, statuses: c.statuses })),
      signature,
    },
  };
}
