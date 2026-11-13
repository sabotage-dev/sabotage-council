import { existsSync, readFileSync } from 'node:fs';
import type { FailureClass } from '../../config/vocab.js';
import { collectPaths, judgePath } from '../acp/policy.js';
import { isObject, num, readJsonl, str, type Json } from '../codex/records.js';
import { rootAliases } from '../paths.js';
import { nonceOnFirstLine, verdictOf, type Ratification, type RatificationCheck } from '../types.js';
import { CURSOR_LABEL, CURSOR_MODEL_MAP, CURSOR_READ_CALLS, CURSOR_READ_TOOLS } from './known.js';

/*
 * Cursor failure signatures (plan 4.4) and ratification (plan 4.5), from the stream-json output and the council
 * hook log. Model proof comes from the hook (`model_id`, the legacy slug `model`, `model_params`), because
 * `system/init.model` is a display name: a leg with no `model_id` in the hook log fails.
 */

export const CURSOR_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  { class: 'usage_limit', pattern: /hit your usage limit|total usage limit reached|ActionRequiredError|usage_limit_exceeded|spend limit/i },
  { class: 'auth', pattern: /not authenticated|stored authentication is invalid|run '?(?:agent|cursor-agent) login|NOT_LOGGED_IN|unlock your keychain|invalid api key/i },
  { class: 'model', pattern: /AI Model Not Found|Model name is not valid|model \S+ (?:is )?(?:not available|blocked|restricted)/i },
  { class: 'setup', pattern: /workspace trust|untrusted workspace|headless .*disabled|run everything .*disabled|unknown option|error: option/i },
  { class: 'capacity', pattern: /rate.?limit|too many requests|RESOURCE_EXHAUSTED|\b429\b/i },
  { class: 'transport', pattern: /ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i },
];

export function classifyCursorText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of CURSOR_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}

export interface CursorRatifyInput {
  root: string;
  nonce: string;
  model: string;
  effort: string | null;
  cliVersion: string | null;
  streamFile: string;
  stderrFile: string;
  hookLog: string;
  timedOut: boolean;
  rootUnchanged: (() => { unchanged: boolean; changes: string[] }) | undefined;
}

export const CURSOR_CLASS_OF_CHECK: Readonly<Record<string, FailureClass>> = {
  stream: 'setup',
  session: 'setup',
  'hook-log': 'setup',
  'cli-version': 'setup',
  cwd: 'contaminated',
  workspace: 'contaminated',
  model: 'model',
  effort: 'model',
  'tools-used': 'contaminated',
  'read-paths': 'contaminated',
  'read-paths-known': 'setup',
  edits: 'contaminated',
  result: 'transport',
  answer: 'empty',
  nonce: 'empty',
  'root-unchanged': 'contaminated',
};

const PRECEDENCE: readonly FailureClass[] = ['contaminated', 'model', 'setup', 'transport', 'timeout', 'empty'];

export function cursorFailureClass(failed: readonly string[], signature: FailureClass | null, timedOut: boolean): FailureClass | null {
  if (failed.length === 0) return null;
  const classes = new Set<FailureClass>(failed.map((name) => CURSOR_CLASS_OF_CHECK[name] ?? 'setup'));
  if (classes.has('contaminated')) return 'contaminated';
  if (signature !== null) return signature;
  if (timedOut) return 'timeout';
  for (const cls of PRECEDENCE) if (classes.has(cls)) return cls;
  return 'setup';
}

export interface CursorStream {
  init: Json | null;
  result: Json | null;
  extra: number;
  malformed: number;
  /** `tool_call` events: the call id, the kind key (`readToolCall`, ...) and its args, by subtype. */
  calls: Array<{ id: string | null; subtype: string | null; kind: string; args: Json }>;
  errors: string[];
}

export function readCursorStream(path: string): CursorStream {
  const out: CursorStream = { init: null, result: null, extra: 0, malformed: 0, calls: [], errors: [] };
  if (!existsSync(path)) return out;
  const { rows, malformed, tornTail } = readJsonl(path);
  out.malformed = malformed + (tornTail ? 1 : 0);
  for (const row of rows) {
    const type = str(row['type']);
    if (type === 'system' && str(row['subtype']) === 'init') {
      if (out.init) out.extra++;
      else out.init = row;
    } else if (type === 'result') {
      if (out.result) out.extra++;
      out.result = row;
    } else if (type === 'error') {
      out.errors.push(JSON.stringify(row));
    } else if (type === 'tool_call' && isObject(row['tool_call'])) {
      for (const [kind, body] of Object.entries(row['tool_call'])) {
        const args = isObject(body) && isObject(body['args']) ? body['args'] : isObject(body) && isObject(body['arguments']) ? body['arguments'] : {};
        out.calls.push({ id: str(row['call_id']), subtype: str(row['subtype']), kind, args });
      }
    }
  }
  return out;
}

export interface HookEntry {
  event: string;
  decision: string | null;
  payload: Json;
}

export function readHookLog(path: string): { entries: HookEntry[]; malformed: number } {
  if (!existsSync(path)) return { entries: [], malformed: 0 };
  const { rows, malformed, tornTail } = readJsonl(path);
  return {
    entries: rows.map((r) => ({ event: str(r['event']) ?? '?', decision: str(r['decision']), payload: isObject(r['payload']) ? r['payload'] : {} })),
    malformed: malformed + (tornTail ? 1 : 0),
  };
}

/** `model_params` as `[{id, value}]` or an object: the effort value, if any. */
function effortOf(params: unknown): string | null {
  if (Array.isArray(params)) {
    const e = params.find((p) => isObject(p) && str(p['id']) === 'effort');
    return isObject(e) ? (str(e['value']) ?? (e['value'] !== undefined ? String(e['value']) : null)) : null;
  }
  return isObject(params) ? str(params['effort']) : null;
}

export function ratifyCursorLeg(input: CursorRatifyInput): Ratification {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const aliases = rootAliases(input.root);
  const isRootPath = (p: unknown): boolean => typeof p === 'string' && aliases.includes(p.replace(/\/+$/, ''));
  const stream = readCursorStream(input.streamFile);
  const hooks = readHookLog(input.hookLog);
  const stderr = existsSync(input.stderrFile) ? readFileSync(input.stderrFile, 'utf8') : '';
  const signature = classifyCursorText([stderr, ...stream.errors, ...(stream.result?.['is_error'] === true ? [str(stream.result['result']) ?? ''] : [])]);
  const { init, result } = stream;

  check('stream', init !== null && result !== null && stream.malformed === 0 && stream.extra === 0, init === null ? 'no system/init' : `init + ${result ? 'result' : 'no result'}; ${stream.malformed} malformed`);
  const sid = init ? str(init['session_id']) : null;
  check('session', sid !== null && (result === null || str(result['session_id']) === sid), `init ${String(sid)}, result ${String(result ? result['session_id'] : null)}`);
  check('cwd', init !== null && isRootPath(init['cwd']), `system/init cwd ${String(init?.['cwd'])}`);
  const payloads = hooks.entries.map((e) => e.payload);
  check('hook-log', hooks.entries.length > 0 && hooks.malformed === 0, hooks.entries.length === 0 ? `no council hook record at ${input.hookLog} (the hooks did not run)` : `${hooks.entries.length} hook event(s), ${hooks.malformed} malformed`);
  const versions = [...new Set(payloads.map((p) => str(p['cursor_version'])).filter((v): v is string => v !== null))];
  check('cli-version', versions.every((v) => input.cliVersion !== null && v.startsWith(input.cliVersion)), `hook cursor_version ${versions.join(', ') || 'not recorded'}, preflight ${String(input.cliVersion)}`);
  const roots = payloads.map((p) => p['workspace_roots']).filter((w) => w !== undefined);
  const badRoots = roots.filter((w) => !Array.isArray(w) || w.length !== 1 || !isRootPath(w[0]));
  check('workspace', roots.length > 0 && badRoots.length === 0, roots.length === 0 ? 'no workspace_roots in the hook log' : badRoots.length === 0 ? `workspace_roots = [root] in ${roots.length} event(s)` : `workspace_roots not [root]: ${JSON.stringify(badRoots[0])}`);

  // The served model is bound to the pin through the declared table (round 1 row 2): every hook event's
  // `model_id` is the slug's model and its `model_params` effort is the slug's effort; the legacy slug, where a
  // hook reports it, is the pin.
  const declared = CURSOR_MODEL_MAP[input.model];
  const ids = [...new Set(payloads.map((p) => str(p['model_id'])).filter((m): m is string => m !== null))];
  const slugs = payloads.map((p) => str(p['model'])).filter((m): m is string => m !== null);
  const badSlugs = [...new Set(slugs.filter((m) => m !== input.model))];
  const badIds = ids.filter((m) => m !== declared?.modelId);
  check(
    'model',
    declared !== undefined && ids.length > 0 && badIds.length === 0 && badSlugs.length === 0,
    declared === undefined
      ? `${input.model} has no declared model_id`
      : ids.length === 0
        ? 'no model_id in the hook log'
        : badIds.length > 0
          ? `model_id not ${declared.modelId} (the pin ${input.model}): ${badIds.join(', ')}`
          : badSlugs.length > 0
            ? `model slug not the pin ${input.model}: ${badSlugs.join(', ')}`
            : `model_id ${declared.modelId} for ${input.model}`,
  );
  const efforts = payloads.map((p) => effortOf(p['model_params'])).filter((e): e is string => e !== null);
  const want = declared?.effort;
  const badEfforts = [...new Set(efforts.filter((e) => e !== want || (input.effort !== null && e !== input.effort)))];
  check(
    'effort',
    declared === undefined || (efforts.length > 0 && badEfforts.length === 0),
    declared === undefined ? 'no declared effort for the pin (model fails)' : efforts.length === 0 ? 'no model_params effort in the hook log' : badEfforts.length === 0 ? `effort ${declared.effort} on ${efforts.length} event(s)` : `effort not ${declared.effort}: ${badEfforts.join(', ')}`,
  );

  // Every call is judged, started or completed (claude F4): a call's kinds over all its events, and the union of
  // every argument snapshot. A read with no judgeable path is not judged as the root (round 1 row 1).
  const calls = new Map<string, { kinds: Set<string>; subtypes: Set<string>; args: Json[] }>();
  stream.calls.forEach((c, i) => {
    const key = c.id ?? `#${i}`;
    const entry = calls.get(key) ?? { kinds: new Set<string>(), subtypes: new Set<string>(), args: [] };
    entry.kinds.add(c.kind);
    if (c.subtype !== null) entry.subtypes.add(c.subtype);
    if (Object.keys(c.args).length > 0) entry.args.push(c.args);
    calls.set(key, entry);
  });
  const isRead = (k: string): boolean => (CURSOR_READ_CALLS as readonly string[]).includes(k);
  const readTool = (t: string): boolean => (CURSOR_READ_TOOLS as readonly string[]).includes(t.toLowerCase());
  const badCalls = new Set<string>();
  for (const [id, c] of calls) for (const k of c.kinds) if (!isRead(k)) badCalls.add(`${k} (${[...c.subtypes].join('/') || 'no subtype'}, ${id})`);
  for (const e of hooks.entries) {
    const tool = String(e.payload['tool_name'] ?? '');
    if (e.event === 'postToolUse' && !readTool(tool)) badCalls.add(`postToolUse ${tool || '(no tool name)'}`);
    if (e.event === 'preToolUse' && e.decision !== 'deny' && !readTool(tool)) badCalls.add(`preToolUse ${tool || '(no tool name)'} not denied`);
    if ((e.event === 'beforeShellExecution' || e.event === 'beforeMCPExecution') && e.decision !== 'deny') badCalls.add(`${e.event} not denied`);
  }
  check('tools-used', badCalls.size === 0, badCalls.size === 0 ? `${calls.size} call(s), all reads` : `beyond the read set: ${[...badCalls].join('; ')}`);
  const outside: string[] = [];
  const unknown: string[] = [];
  const judge = (label: string, values: readonly Json[]): void => {
    const found = collectPaths(values.map((v) => ({ rawInput: v })));
    if (found.problems.length > 0) unknown.push(`${label}: ${found.problems.join('; ')}`);
    if (found.paths.length === 0) unknown.push(`${label}: no path the ratifier can judge`);
    for (const p of found.paths) {
      const j = judgePath(p, input.root, aliases);
      if (!j.inside) outside.push(`${label} ${p} (${j.why})`);
    }
  };
  for (const [id, c] of calls) judge(`${[...c.kinds].join('/')} ${id}`, c.args);
  // The hook inputs of every tool the hook let through, and of every tool that ran (claude F5).
  for (const e of hooks.entries) {
    if ((e.event === 'preToolUse' && e.decision !== 'deny') || e.event === 'postToolUse') {
      const toolInput = isObject(e.payload['tool_input']) ? e.payload['tool_input'] : {};
      judge(`${e.event} ${String(e.payload['tool_name'] ?? '?')}`, [toolInput]);
    }
  }
  for (const e of hooks.entries.filter((x) => x.event === 'beforeReadFile' && x.decision !== 'deny')) {
    const p = str(e.payload['file_path']) ?? str(e.payload['filePath']);
    if (p === null || !judgePath(p, input.root, aliases).inside) outside.push(`beforeReadFile ${String(p)} allowed`);
  }
  check('read-paths', outside.length === 0, outside.length === 0 ? 'every call and every hook input named paths inside the root' : [...new Set(outside)].join('; '));
  check('read-paths-known', unknown.length === 0, unknown.length === 0 ? 'every call and hook input names a path the ratifier can judge' : [...new Set(unknown)].join('; '));
  const edits = hooks.entries.filter((e) => e.event === 'afterFileEdit');
  check('edits', edits.length === 0, edits.length === 0 ? 'no afterFileEdit event' : `${edits.length} file edit(s): ${edits.map((e) => String(e.payload['file_path'] ?? '?')).join(', ')}`);
  check('result', result !== null && result['is_error'] === false && str(result['subtype']) === 'success', result === null ? 'no result line' : `is_error ${String(result['is_error'])}, subtype ${String(result['subtype'])}`);
  const answer = result && result['is_error'] === false ? str(result['result']) : null;
  check('answer', answer !== null && answer.trim() !== '', answer === null || answer.trim() === '' ? 'no answer' : 'answer in the result');
  const nonce = nonceOnFirstLine(answer, input.nonce);
  check('nonce', nonce.ok, nonce.detail);
  const residue = input.rootUnchanged?.();
  check('root-unchanged', residue?.unchanged === true, residue === undefined ? 'no residue sweep was given (fails closed)' : residue.unchanged ? 'tree hash unchanged' : `root changed: ${residue.changes.slice(0, 10).join(', ')}`);

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const failureClass = cursorFailureClass(failed, signature, input.timedOut);
  const { ok, status } = verdictOf(checks, failureClass);
  const usage = result && isObject(result['usage']) ? result['usage'] : {};
  return {
    status,
    ok,
    failureClass,
    checks,
    enforcement: CURSOR_LABEL,
    recordPath: input.hookLog,
    sessionId: sid,
    cliVersion: versions[0] ?? input.cliVersion,
    modelObserved: ids[0] ?? slugs[0] ?? null,
    effortObserved: efforts[0] ?? null,
    cwdObserved: init ? str(init['cwd']) : null,
    cwdOk: checks.find((c) => c.name === 'cwd')?.ok ?? false,
    toolsOffered: [],
    toolsUsed: [...new Set([...calls.values()].flatMap((c) => [...c.kinds]))].sort(),
    tokensIn: num(usage['inputTokens']),
    tokensOut: num(usage['outputTokens']),
    costUsd: null,
    credits: null,
    quotaUsedPct: null,
    quotaNote: null,
    durationMs: result ? num(result['duration_ms']) : null,
    nonceSeen: nonce.ok,
    rootMutated: residue === undefined ? null : !residue.unchanged,
    detail: { modelId: ids, hookDenials: hooks.entries.filter((e) => e.decision === 'deny').map((e) => ({ event: e.event, tool: e.payload['tool_name'] ?? e.payload['file_path'] ?? e.payload['command'] ?? null })), apiKeySource: init?.['apiKeySource'] ?? null, signature },
  };
}
