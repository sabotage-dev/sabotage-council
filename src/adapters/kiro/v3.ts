import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FailureClass } from '../../config/vocab.js';
import { noteKey, type AcpGate, type AcpGateNote, type AcpGateView, type KnownToolCall, type PermissionDecision } from '../../transport/acp.js';
import type { AcpRecordResult } from '../acp/adapter.js';
import { actionBlock, hasText, type AcpLog, type AcpToolCall } from '../acp/log.js';
import { isObject, num, readOnlyPolicy, str, type ReadSet } from '../acp/policy.js';
import { isRoot, type AcpCommonResult } from '../acp/ratify.js';
import { pathInsideRoot, rootAliases } from '../paths.js';
import type { LegHandle, RatificationCheck } from '../types.js';
import { KIRO_AGENT, sha256Hex } from './known.js';

/*
 * kiro on the v3 engine (plan 4.6, P11): the read set, the loop-guard answer, the pre-prompt gate and the ratifier.
 * Facts measured on kiro-cli 3.5.0 (2026-11-18, the scrubbed fixtures in test/fixtures/kiro-v3):
 *   - v3 tool calls carry `title`, `kind`, `rawInput`, `locations` and `_meta.kiro.toolOrigin`, but no tool name, so
 *     the read set keys on the title: `Read File` (read), `Grep Search`, `List Directory` and `File Search` (search).
 *     `Load Resource` (kind other) is always offered and never a read;
 *   - a permission request carries only the call's id, status and title, and names the path in
 *     `_meta.kiro.consent.resource` (read by the shared request-path reader);
 *   - a rejected call reports `failed` with `rawOutput.message` "The user rejected this tool call." (the notice);
 *   - after 7 failed calls in a row, the loop guard asks with two `allow_once` options, `cancel` and
 *     `keep-iterating`: an answer of `cancelled` is recorded as `keep-iterating`, so the client selects `cancel`;
 *   - after the mode pin kiro sends the offered tool tags, the preset stores, the steering documents and the
 *     available commands; the session's own record is `sessions/<hash>/<session id>/session.json` with
 *     `messages.jsonl` beside it.
 */

type Json = Record<string, unknown>;

/** The v3 titles the read set knows, with the name kiro's `usedTools` and `messages.jsonl` use for each. */
export const KIRO_V3_TITLES: Readonly<Record<string, string>> = {
  'Read File': 'read_file',
  'Grep Search': 'grep_search',
  'List Directory': 'list_directory',
  'File Search': 'file_search',
  'Load Resource': 'load_resource',
};
export const KIRO_V3_LOAD_RESOURCE = 'Load Resource';
/** The v3 denial notice: a rejected call's `rawOutput.message`, exactly. */
export const KIRO_V3_NOTICE = 'The user rejected this tool call.';
/** The tool origins a v3 call may report (measured: `acp` on List Directory, `default` on the rest). */
export const KIRO_V3_ORIGINS = ['default', 'acp'] as const;
/** The only command the session may offer after the mode pin. */
export const KIRO_V3_COMMANDS = [KIRO_AGENT] as const;

const kiroOf = (v: unknown): Json => {
  const meta = isObject(v) ? v['_meta'] : undefined;
  const kiro = isObject(meta) ? meta['kiro'] : undefined;
  return isObject(kiro) ? kiro : {};
};

const LOOP_PROMPT_ID = /^failure-intervention-prompt-[A-Za-z0-9_-]+$/;
const LOOP_RESULT_ID = /^failure-intervention-(?!prompt-)[A-Za-z0-9_-]+$/;

/** The loop guard's question, as kiro reports it: `_meta.kiro.toolId` user_input for a failure intervention. */
function loopGuardMeta(snapshot: Json): boolean {
  const k = kiroOf(snapshot);
  return k['toolId'] === 'user_input' && k['userInputReason'] === 'failure-intervention';
}

const LOOP_RESULT_KEYS = new Set(['sessionUpdate', 'toolCallId', 'status', 'rawInput', 'rawOutput', 'content', '_meta']);
const LOOP_CHOICE_KEYS = new Set(['userChoice', 'guidanceProvided']);
const LOOP_CHOICES = ['cancel', 'keep-iterating'];
const LOOP_MESSAGE = /^User intervention: (cancel|keep-iterating)$/;
/**
 * A recorded choice object: only `userChoice` (one of the guard's two options) and `guidanceProvided` (a boolean), so no
 * free text rides in either (PR #14 round 2).
 */
const isChoice = (v: unknown): boolean =>
  isObject(v) &&
  Object.keys(v).every((k) => LOOP_CHOICE_KEYS.has(k)) &&
  (v['userChoice'] === undefined || LOOP_CHOICES.includes(v['userChoice'] as string)) &&
  (v['guidanceProvided'] === undefined || typeof v['guidanceProvided'] === 'boolean');

/**
 * The recorded result of kiro's loop guard, by its whole shape (measured on 3.5.0): no title, kind or locations;
 * `rawInput` only `message` "User intervention: <choice>"; `rawOutput` only `userChoice` (`cancel` or
 * `keep-iterating`) and `guidanceProvided` (a boolean); `content` only that same JSON as text; `_meta.kiro` empty. A call that carries anything else (a path, a title, file
 * text) is not the loop guard, whatever its id, and is judged like any other call (PR #14 round 1).
 */
function loopGuardResultShape(s: Json): boolean {
  if (Object.keys(s).some((k) => !LOOP_RESULT_KEYS.has(k))) return false;
  const input = s['rawInput'];
  if (input !== undefined && input !== null) {
    if (!isObject(input) || Object.keys(input).some((k) => k !== 'message')) return false;
    if (input['message'] !== undefined && !(typeof input['message'] === 'string' && LOOP_MESSAGE.test(input['message']))) return false;
  }
  const output = s['rawOutput'];
  if (output !== undefined && output !== null && !isChoice(output)) return false;
  const content = s['content'];
  if (content !== undefined && content !== null) {
    if (!Array.isArray(content)) return false;
    const ok = content.every((b) => {
      const inner = isObject(b) ? b['content'] : undefined;
      if (!isObject(b) || b['type'] !== 'content' || !isObject(inner) || inner['type'] !== 'text' || typeof inner['text'] !== 'string') return false;
      try {
        return Object.keys(b).length === 2 && Object.keys(inner).length === 2 && isChoice(JSON.parse(inner['text']));
      } catch {
        return false;
      }
    });
    if (!ok) return false;
  }
  const meta = s['_meta'];
  if (meta !== undefined && meta !== null && !(isObject(meta) && Object.keys(meta).every((k) => k === 'kiro') && Object.keys(kiroOf(s)).length === 0)) return false;
  return true;
}

const LOOP_PROMPT_KEYS = new Set(['sessionUpdate', 'toolCallId', 'title', 'kind', 'status', '_meta']);

/**
 * One snapshot of the loop guard's question, by its whole shape (measured on 3.5.0): only an id, a status, the question
 * as `title`, kind `other` and the guard's meta; no input, output, content or locations (PR #14 round 2).
 */
function loopGuardPromptShape(s: Json): boolean {
  if (Object.keys(s).some((k) => !LOOP_PROMPT_KEYS.has(k))) return false;
  if (s['kind'] !== undefined && s['kind'] !== null && s['kind'] !== 'other') return false;
  if (s['title'] !== undefined && s['title'] !== null && typeof s['title'] !== 'string') return false;
  const meta = s['_meta'];
  if (meta === undefined || meta === null) return true;
  if (!isObject(meta) || Object.keys(meta).some((k) => k !== 'kiro')) return false;
  return Object.entries(kiroOf(s)).every(([k, v]) => (k === 'toolId' && v === 'user_input') || (k === 'userInputReason' && v === 'failure-intervention'));
}

/** A call of kiro's loop guard: its question or its recorded result, each by its id and every snapshot's shape. */
export function isLoopGuard(call: { id: string; snapshots: readonly Json[] }): boolean {
  if (LOOP_PROMPT_ID.test(call.id)) return call.snapshots.some(loopGuardMeta) && call.snapshots.every(loopGuardPromptShape);
  return LOOP_RESULT_ID.test(call.id) && call.snapshots.length > 0 && call.snapshots.every(loopGuardResultShape);
}

/**
 * The v3 notice in one snapshot: status `failed`, `rawOutput` holding only `message` = the notice, `content` empty or
 * only the notice, reported after the client rejected the call. Anything else in it is tool output.
 */
function isNotice(s: Json, index: number, call: AcpToolCall): boolean {
  if (call.rejectedAtSnapshot === null || index < call.rejectedAtSnapshot) return false;
  if (s['status'] !== 'failed') return false;
  const raw = s['rawOutput'];
  if (!isObject(raw) || raw['message'] !== KIRO_V3_NOTICE) return false;
  if (Object.entries(raw).some(([k, v]) => k !== 'message' && hasText(v))) return false;
  const content = s['content'];
  if (content === undefined || content === null) return true;
  if (!Array.isArray(content)) return false;
  return content.every((b) => {
    const inner = isObject(b) ? b['content'] : undefined;
    return isObject(b) && b['type'] === 'content' && isObject(inner) && inner['type'] === 'text' && inner['text'] === KIRO_V3_NOTICE && Object.keys(b).length === 2 && Object.keys(inner).length === 2;
  });
}

const isLoadResource = (call: AcpToolCall): boolean => call.titles.length > 0 && call.titles.every((t) => t === KIRO_V3_LOAD_RESOURCE);

/**
 * Whether a v3 call ran (adapter-scoped, in place of the shared rule):
 *   - `Load Resource` ran only if it reached `completed` (it goes `in_progress`, then `failed` with the catalogue
 *     error when it loads nothing);
 *   - any other call ran when it completed, or when any snapshot holds output that is not the v3 notice;
 *   - a call the client rejected, with nothing but the notice, did not run; else the shared `in_progress` rule.
 */
export function kiroV3Ran(call: AcpToolCall): boolean {
  if (isLoadResource(call)) return call.statuses.includes('completed');
  if (call.statuses.includes('completed')) return true;
  const output = call.snapshots.some((s, i) => (hasText(s['rawOutput']) || hasText(s['content']) || actionBlock(s['content'])) && !isNotice(s, i, call));
  if (output) return true;
  if (call.rejectedAt !== null) return false;
  return call.statuses.includes('in_progress');
}

/**
 * The v3 read set (4.6). Names come from the title (an unknown title is named `title:<title>`, which no read declares).
 * Grep Search's `query` is the text it searches for; File Search's `query` is a file-name pattern over the cwd,
 * judged as a glob; `includePattern` and `excludePattern` are globs. A glob with a `..` segment, an absolute path or
 * a home path is outside. With no path and no pattern, Grep Search and File Search search the cwd.
 */
export const KIRO_V3_READS: ReadSet = {
  kinds: ['read', 'search'],
  names: ['read_file', 'grep_search', 'list_directory', 'file_search'],
  nameOf: (s) => {
    const title = str(s['title']);
    if (title === null) return null;
    return KIRO_V3_TITLES[title] ?? `title:${title}`;
  },
  cwdDefault: ['grep_search', 'file_search'],
  args: {
    read_file: { text: ['explanation'] },
    grep_search: { globs: ['includePattern', 'excludePattern'], text: ['query', 'explanation'] },
    list_directory: { text: ['explanation'] },
    file_search: { globs: ['query', 'includePattern', 'excludePattern'], text: ['explanation'] },
  },
  ran: kiroV3Ran,
  exempt: isLoopGuard,
  climbingGlobsOutside: true,
};

/**
 * The v3 leg's permission answers: the read-only policy over the v3 read set, except kiro's loop guard, which is
 * answered with the exact option `cancel` (it grants nothing; `cancelled` would be recorded as keep-iterating).
 */
export function kiroV3Policy(root: string): (params: Json, known: (toolCallId: string) => KnownToolCall | undefined) => PermissionDecision {
  const base = readOnlyPolicy(root, KIRO_V3_READS);
  return (params, known) => {
    const toolCall = isObject(params['toolCall']) ? params['toolCall'] : {};
    const id = str(toolCall['toolCallId']);
    const options = Array.isArray(params['options']) ? params['options'].filter(isObject) : [];
    if (id !== null && LOOP_PROMPT_ID.test(id)) {
      const snapshots = [...(known(id)?.snapshots ?? []), toolCall];
      if ((snapshots.some(loopGuardMeta) || loopGuardMeta(params)) && options.some((o) => o['optionId'] === 'cancel')) {
        return { allow: false, select: 'cancel', why: "kiro's loop guard: cancel ends the turn" };
      }
    }
    return base(params, known);
  };
}

// ---------- the gate (4.6 "Before the prompt") ----------

/** The notifications the gate needs: the session's own before the pins, then the newest of each after the mode pin. */
export const KIRO_V3_GATE_NEEDS: ReadonlyArray<{ key: string; afterMark: boolean }> = [
  { key: '_kiro/mcp/status', afterMark: false },
  { key: '_kiro/powers/items_changed', afterMark: false },
  { key: '_kiro/progressive_context/items_changed', afterMark: false },
  { key: '_kiro/tools/didChange', afterMark: true },
  { key: '_kiro/policy/changed', afterMark: true },
  { key: '_kiro/steering/documents_changed', afterMark: true },
  { key: 'session/update:available_commands_update', afterMark: true },
];

/** Why the offered tool tags are not exactly `[{source: builtin, tag: read}]`, or null. */
export function tagsProblem(params: Json): string | null {
  const tags = params['tags'];
  if (!Array.isArray(tags)) return 'no tags list';
  const shown = tags.map((t) => (isObject(t) ? `${String(t['source'])}:${String(t['tag'])}` : JSON.stringify(t)));
  const ok = tags.length === 1 && isObject(tags[0]) && tags[0]['source'] === 'builtin' && tags[0]['tag'] === 'read';
  return ok ? null : `offered tags [${shown.join(', ')}], not exactly [builtin:read]`;
}

/** Why the preset stores are not all read ok, empty and inside the leg's KIRO_HOME, or null. */
export function storesProblem(stores: unknown, kiroHome: string): string | null {
  if (!Array.isArray(stores) || stores.length === 0) return 'no preset stores are listed';
  const aliases = rootAliases(kiroHome);
  for (const s of stores) {
    if (!isObject(s)) return 'a preset store is not an object';
    const read = isObject(s['read']) ? s['read'] : {};
    const file = str(s['file']);
    const where = file ?? `(${String(s['scope'])} store with no file)`;
    if (read['ok'] !== true) return `preset store ${where} did not read ok`;
    if (!Array.isArray(read['presets']) || read['presets'].length > 0) return `preset store ${where} holds ${Array.isArray(read['presets']) ? read['presets'].length : 'unreadable'} preset(s)`;
    if (file === null || !pathInsideRoot(file, kiroHome, aliases, { literalDollar: true }).inside) return `preset store ${where} is not under the leg's KIRO_HOME`;
  }
  return null;
}

/** Why the steering documents are not only bundled manual `builtin:` documents, or null. */
export function steeringProblem(params: Json): string | null {
  if (params['status'] !== 'success') return `steering status ${String(params['status'])}`;
  const docs = params['documents'];
  if (!Array.isArray(docs)) return 'no documents list';
  for (const d of docs) {
    if (!isObject(d)) return 'a steering document is not an object';
    const name = str(d['name']);
    const origin = (() => {
      const resource = kiroOf(d)['resource'];
      const source = isObject(resource) ? resource['source'] : undefined;
      return isObject(source) ? source['origin'] : undefined;
    })();
    const ok = name !== null && d['uri'] === `builtin:${name}` && d['scope'] === 'global' && d['inclusion'] === 'manual' && origin === 'bundled';
    if (!ok) return `steering document ${String(name)} (${String(d['uri'])}, scope ${String(d['scope'])}, inclusion ${String(d['inclusion'])}, origin ${String(origin)}) is not a bundled manual document`;
  }
  return null;
}

/** Why the available commands are not exactly `sabotage-council`, or null. */
export function commandsProblem(update: Json): string | null {
  const list = update['availableCommands'];
  if (!Array.isArray(list)) return 'no availableCommands list';
  const names = list.map((c) => (isObject(c) ? String(c['name']) : JSON.stringify(c)));
  return names.length === KIRO_V3_COMMANDS.length && names.every((n, i) => n === KIRO_V3_COMMANDS[i]) ? null : `available commands [${names.join(', ')}], not exactly [${KIRO_V3_COMMANDS.join(', ')}]`;
}

function listProblem(params: Json, key: string, what: string): string | null {
  if (params['status'] !== 'success') return `${what} status ${String(params['status'])}`;
  const list = params[key];
  if (!Array.isArray(list)) return `no ${key} list`;
  return list.length === 0 ? null : `${list.length} ${what} item(s) listed`;
}

/** The gate's checks over a view (live, from the transport; or rebuilt from the update log). */
export function kiroV3GateChecks(view: AcpGateView, kiroHome: string): RatificationCheck[] {
  const checks: RatificationCheck[] = [];
  const check = (name: string, problem: string | null, okDetail: string): void => {
    checks.push({ name, ok: problem === null, detail: problem ?? okDetail });
  };
  const of = (key: string): AcpGateNote[] => view.notes.filter((n) => noteKey(n) === key);
  const newestAfter = (key: string): AcpGateNote | undefined => of(key).filter((n) => n.afterMark).at(-1);

  const meta = kiroOf(view.session);
  check('gate-presets', storesProblem(meta['presetStores'], kiroHome), "session/new: every preset store read ok, empty, under the leg's KIRO_HOME");

  const mcp = of('_kiro/mcp/status');
  const mcpBad = mcp.find((n) => !Array.isArray(n.params['servers']) || (n.params['servers'] as unknown[]).length > 0);
  check(
    'gate-mcp',
    mcp.length === 0 ? 'no _kiro/mcp/status arrived' : mcpBad !== undefined ? `MCP servers listed: ${JSON.stringify(mcpBad.params['servers'])}` : null,
    `MCP servers: [] (${mcp.length} status notification(s))`,
  );

  const powers = of('_kiro/powers/items_changed');
  const progressive = of('_kiro/progressive_context/items_changed');
  const contextProblem =
    powers.length === 0
      ? 'no _kiro/powers/items_changed arrived'
      : progressive.length === 0
        ? 'no _kiro/progressive_context/items_changed arrived'
        : (powers.map((n) => listProblem(n.params, 'powers', 'power')).find((p) => p !== null) ?? progressive.map((n) => listProblem(n.params, 'items', 'progressive-context')).find((p) => p !== null) ?? null);
  check('gate-context', contextProblem, 'no powers and no progressive-context items');

  const tags = newestAfter('_kiro/tools/didChange');
  check('gate-tags', tags === undefined ? 'no _kiro/tools/didChange after the mode pin' : tagsProblem(tags.params), 'offered tags exactly [builtin:read]');
  const policy = newestAfter('_kiro/policy/changed');
  check(
    'gate-policy',
    policy === undefined ? 'no _kiro/policy/changed after the mode pin' : policy.params['status'] !== 'success' ? `policy status ${String(policy.params['status'])}` : storesProblem(policy.params['presetStores'], kiroHome),
    "every preset store read ok, empty, under the leg's KIRO_HOME",
  );
  const steering = newestAfter('_kiro/steering/documents_changed');
  check('gate-steering', steering === undefined ? 'no _kiro/steering/documents_changed after the mode pin' : steeringProblem(steering.params), 'steering: only bundled manual builtin documents');
  const commands = newestAfter('session/update:available_commands_update');
  check('gate-commands', commands === undefined ? 'no available_commands_update after the mode pin' : commandsProblem(commands.params), `available commands exactly [${KIRO_V3_COMMANDS.join(', ')}]`);
  return checks;
}

/** The gate the transport runs before the prompt: refuses on the first failing check. */
export function kiroV3Gate(kiroHome: string, waitMs?: number): AcpGate {
  return {
    markPin: 'mode',
    needs: KIRO_V3_GATE_NEEDS,
    waitMs,
    judge: (view) => {
      const bad = kiroV3GateChecks(view, kiroHome).find((c) => !c.ok);
      return bad === undefined ? null : `${bad.name}: ${bad.detail}`;
    },
  };
}

// ---------- ratification (4.6 "Ratification (v3)") ----------

/** The v3 checks' classes. */
export const KIRO_V3_CLASS: Readonly<Record<string, FailureClass>> = {
  autopilot: 'setup',
  contentCollection: 'setup',
  memoryReflection: 'setup',
  sessionToolsMessaging: 'setup',
  'gate-presets': 'setup',
  'gate-mcp': 'setup',
  'gate-context': 'setup',
  'gate-tags': 'setup',
  'gate-policy': 'setup',
  'gate-steering': 'setup',
  'gate-commands': 'setup',
  'effort-offered': 'model',
  'tags-held': 'contaminated',
  'policy-held': 'contaminated',
  'steering-held': 'contaminated',
  'model-held': 'model',
  turn: 'transport',
  'used-tools': 'contaminated',
  'tool-titles': 'contaminated',
  'tool-origin': 'contaminated',
  'load-resource': 'contaminated',
  'loop-guard': 'contaminated',
  'credit-split': 'setup',
  'credits-delegated': 'contaminated',
  'agent-file': 'contaminated',
  'leg-version': 'setup',
  'session-json': 'setup',
  'session-agent': 'contaminated',
  'session-roots': 'contaminated',
  'session-autopilot': 'contaminated',
  'session-model': 'model',
  'messages-jsonl': 'setup',
  'messages-model': 'model',
  'messages-calls': 'contaminated',
  'presets-read': 'setup',
  'presets-after': 'contaminated',
};

/** The gate's view rebuilt from the update log: notes before the prompt, `afterMark` from the mode pin's request. */
export function gateViewOf(log: AcpLog): AcpGateView | null {
  const sn = log.sessionNew;
  if (sn === null || !isObject(sn.result)) return null;
  const mark = log.rpcs.find((r) => r.method === 'session/set_config_option' && r.params['configId'] === 'mode')?.line ?? Number.POSITIVE_INFINITY;
  const notes = log.notes.filter((n) => n.line < log.promptLine).map((n) => ({ method: n.method, kind: n.kind, params: n.params, afterMark: n.line > mark }));
  return { session: sn.result, notes, current: { ...log.configBefore } };
}

/** The newest `creditSplit` (and every model note) from messages.jsonl. */
interface Messages {
  path: string | null;
  problem: string | null;
  modelNotes: Array<string | null>;
  calls: Map<string, { name: string | null; title: string | null }>;
  results: Map<string, { status: string | null; success: boolean | null }>;
  creditSplit: { main: number | null; delegated: number | null; auxiliary: number | null } | null;
}

const MODEL_NOTE = /The current model is (\S+?)\.(?=\s|<|$)/g;

function readMessages(path: string | null): Messages {
  const out: Messages = { path, problem: null, modelNotes: [], calls: new Map(), results: new Map(), creditSplit: null };
  if (path === null || !existsSync(path)) {
    out.problem = 'no messages.jsonl beside session.json';
    return out;
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    out.problem = `messages.jsonl unreadable: ${error instanceof Error ? error.message : String(error)}`;
    return out;
  }
  for (const [i, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      out.problem = `messages.jsonl line ${i + 1} is not JSON`;
      return out;
    }
    const p = isObject(row) && isObject(row['payload']) ? row['payload'] : null;
    if (p === null) continue;
    const type = p['type'];
    if (type === 'agent_note' && typeof p['content'] === 'string' && p['content'].includes('The current model is')) {
      const found = [...p['content'].matchAll(MODEL_NOTE)].map((m) => m[1] ?? null);
      out.modelNotes.push(...(found.length > 0 ? found : [null]));
    } else if (type === 'tool_call') {
      const id = str(p['toolCallId']);
      if (id !== null) out.calls.set(id, { name: str(p['toolName']), title: str(p['title']) });
    } else if (type === 'tool_result') {
      const id = str(p['toolCallId']);
      if (id !== null) out.results.set(id, { status: str(p['status']), success: typeof p['success'] === 'boolean' ? p['success'] : null });
    } else if (type === 'session_metadata' && p['key'] === 'creditSplit' && isObject(p['value'])) {
      const v = p['value'];
      out.creditSplit = { main: num(v['main']), delegated: num(v['delegated']), auxiliary: num(v['auxiliary']) };
    }
  }
  return out;
}

/** Whether a preset store's text holds no preset: empty, comments only, `presets: []`, or JSON with none. */
export function noPresets(text: string): boolean {
  const body = text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '').trim())
    .filter((l) => l !== '')
    .join(' ');
  if (body === '' || /^presets:\s*(\[\s*\]|null|~)?$/.test(body) || body === '{}') return true;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) && (parsed['presets'] === undefined || (Array.isArray(parsed['presets']) && parsed['presets'].length === 0)) && Object.keys(parsed).every((k) => k === 'presets');
  } catch {
    return false;
  }
}

/** Every `model`-named string and every reported fallback in a notification, as found at any depth. */
function modelsIn(v: unknown, out: { models: string[]; fallbacks: string[] }, key = ''): void {
  if (typeof v === 'string') {
    if (/model/i.test(key)) out.models.push(v);
    if (/fallback/i.test(key) && v.trim() !== '') out.fallbacks.push(`${key}: ${v}`);
    return;
  }
  if (v === true && /fallback/i.test(key) && key !== 'modelFallbackReporting') out.fallbacks.push(`${key}: true`);
  if (Array.isArray(v)) {
    for (const x of v) modelsIn(x, out, key);
    return;
  }
  if (isObject(v)) {
    if (/fallback/i.test(key) && Object.keys(v).length > 0) out.fallbacks.push(`${key}: ${JSON.stringify(v).slice(0, 200)}`);
    for (const [k, x] of Object.entries(v)) modelsIn(x, out, k);
  }
}

function sessionDirs(kiroHome: string, sessionId: string): string[] {
  const dir = join(kiroHome, 'sessions');
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId) || sessionId.startsWith('.') || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const d = join(dir, e.name, sessionId);
    if (existsSync(join(d, 'session.json'))) out.push(d);
  }
  return out;
}

/** The `KiroCLI/<version> KAS/<version>` user agents in the leg's `KIRO_HOME/logs/*\/kiro.log`. */
export function legVersions(kiroHome: string): { versions: string[]; kas: string[]; logs: number } {
  const dir = join(kiroHome, 'logs');
  const versions = new Set<string>();
  const kas = new Set<string>();
  let logs = 0;
  if (!existsSync(dir)) return { versions: [], kas: [], logs };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, e.name, 'kiro.log');
    if (!e.isDirectory() || !existsSync(file)) continue;
    logs++;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(/KiroCLI\/(\d+\.\d+\.\d+)\s+KAS\/([0-9A-Za-z.-]+)/g)) {
      versions.add(m[1] ?? '');
      kas.add(m[2] ?? '');
    }
  }
  return { versions: [...versions], kas: [...kas], logs };
}

/** A v3 leg's checks from the stream (beyond the common ones) and from kiro's files under the leg's KIRO_HOME. */
export function kiroV3Records(h: LegHandle, common: AcpCommonResult, kiroHome: string, agentFile: string): AcpRecordResult {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const log = common.log;
  const pin = h.occupant.model;
  const effort = h.occupant.effort;
  const prompted = log.prompt !== null;
  const noTurn = 'no turn (the session never reached the prompt)';

  // Before the prompt: the gate, rebuilt from the log.
  const view = gateViewOf(log);
  const gate = view !== null ? kiroV3GateChecks(view, kiroHome) : [];
  if (view === null) for (const name of ['gate-presets', 'gate-mcp', 'gate-context', 'gate-tags', 'gate-policy', 'gate-steering', 'gate-commands']) check(name, true, 'no session (the session check fails)');
  else checks.push(...gate);

  // The effort: an `effortLevel` option advertised after the model pin.
  const modelPin = log.rpcs.find((r) => r.method === 'session/set_config_option' && r.params['configId'] === 'model');
  if (effort === undefined) check('effort-offered', true, 'no effort pinned');
  else if (modelPin === undefined) check('effort-offered', true, 'the model pin was never sent (the model check fails)');
  else {
    const ids = new Set<string>();
    const add = (options: unknown): void => {
      if (Array.isArray(options)) for (const o of options) if (isObject(o) && typeof o['id'] === 'string') ids.add(o['id']);
    };
    if (isObject(modelPin.result)) add(modelPin.result['configOptions']);
    for (const n of log.notes) if (n.kind === 'config_option_update' && n.line > modelPin.line && n.line < log.promptLine) add(n.params['configOptions']);
    check('effort-offered', ids.has('effortLevel'), ids.has('effortLevel') ? `effortLevel advertised after the model pin (effort ${effort})` : `effort ${effort} is pinned, but no effortLevel option was advertised after the model pin`);
  }

  // After the prompt: the gate's notifications held, and the model.
  const after = log.notes.filter((n) => n.line > log.promptLine);
  const held = (name: string, method: string, problem: (p: Json) => string | null): void => {
    const bad = after.filter((n) => n.method === method).map((n) => problem(n.params)).filter((p): p is string => p !== null);
    check(name, bad.length === 0, bad.length === 0 ? `no ${method} after the prompt that would fail the gate` : `after the prompt: ${bad.join('; ')}`);
  };
  held('tags-held', '_kiro/tools/didChange', tagsProblem);
  held('policy-held', '_kiro/policy/changed', (p) => (p['status'] !== 'success' ? `policy status ${String(p['status'])}` : storesProblem(p['presetStores'], kiroHome)));
  held('steering-held', '_kiro/steering/documents_changed', steeringProblem);
  const named: string[] = [];
  for (const n of after) {
    if (n.kind === 'config_option_update') {
      const model = Array.isArray(n.params['configOptions']) ? n.params['configOptions'].find((o) => isObject(o) && o['id'] === 'model') : undefined;
      const value = isObject(model) ? str(model['currentValue']) : null;
      if (value !== null && value !== pin) named.push(`config_option_update model ${value}`);
      continue;
    }
    if (n.kind !== null && n.kind !== 'session_info_update') continue;
    const found = { models: [] as string[], fallbacks: [] as string[] };
    modelsIn(n.params, found);
    for (const m of found.models) if (m !== pin) named.push(`${n.kind ?? n.method} names model ${m}`);
    for (const f of found.fallbacks) named.push(`${n.kind ?? n.method} reports a fallback (${f})`);
  }
  check('model-held', named.length === 0, named.length === 0 ? `no notification after the prompt names another model than ${pin} or a fallback` : named.join('; '));

  // The turn: completion and end, credits, the tools kiro says it used.
  const kinds = (k: string) => after.filter((n) => n.kind === 'session_info_update' && kiroOf(n.params)['kind'] === k).map((n) => kiroOf(n.params));
  const completions = kinds('turn_completion');
  const ends = kinds('turn_end');
  if (!prompted) check('turn', true, noTurn);
  else {
    const ok = completions.length > 0 && completions.every((c) => c['status'] === 'success') && ends.length > 0 && ends.every((e) => e['stopReason'] === 'end_turn');
    check('turn', ok, `turn_completion status ${completions.map((c) => String(c['status'])).join(', ') || 'none'}; turn_end stopReason ${ends.map((e) => String(e['stopReason'])).join(', ') || 'none'}`);
  }
  const summaries = completions.flatMap((c) => (Array.isArray(c['promptTurnSummaries']) ? c['promptTurnSummaries'].filter(isObject) : []));
  const usage = summaries.map((s) => num(s['usage'])).filter((u): u is number => u !== null);
  const credits = usage.length > 0 ? Math.round(usage.reduce((a, b) => a + b, 0) * 10_000) / 10_000 : null;
  const usedTools = summaries.flatMap((s) => (Array.isArray(s['usedTools']) ? s['usedTools'].map(String) : []));
  const calls = [...log.toolCalls.values()].filter((c) => !isLoopGuard(c)).sort((a, b) => a.firstLine - b.firstLine);
  const seen = calls.map((c) => KIRO_V3_TITLES[c.titles[0] ?? ''] ?? `title:${c.titles[0] ?? '(none)'}`);
  if (!prompted) check('used-tools', true, noTurn);
  else {
    const same = usedTools.length === seen.length && usedTools.every((u, i) => u === seen[i]);
    check('used-tools', same, same ? `usedTools matched one for one: ${usedTools.join(', ') || 'none'}` : `usedTools [${usedTools.join(', ')}] vs the calls the client saw [${seen.join(', ')}]`);
  }

  // Every call: a known title, a known origin; no completed Load Resource; the loop guard answered cancel.
  const badTitles = calls.filter((c) => c.titles.length !== 1 || KIRO_V3_TITLES[c.titles[0] ?? ''] === undefined);
  check('tool-titles', badTitles.length === 0, badTitles.length === 0 ? `${calls.length} call(s), every title a known one` : badTitles.map((c) => `${c.id}: titles [${c.titles.join(', ') || 'none'}]`).join('; '));
  const badOrigins = calls.filter((c) => {
    const origins = c.snapshots.map((s) => kiroOf(s)['toolOrigin']).filter((o) => o !== undefined);
    return origins.length === 0 || origins.some((o) => !(KIRO_V3_ORIGINS as readonly unknown[]).includes(o));
  });
  check(
    'tool-origin',
    badOrigins.length === 0,
    badOrigins.length === 0
      ? `every call's toolOrigin is ${KIRO_V3_ORIGINS.join(' or ')}`
      : badOrigins.map((c) => `${c.id}: toolOrigin ${JSON.stringify(c.snapshots.map((s) => kiroOf(s)['toolOrigin']).filter((o) => o !== undefined))}`).join('; '),
  );
  const loaded = calls.filter((c) => isLoadResource(c) && c.statuses.includes('completed'));
  check('load-resource', loaded.length === 0, loaded.length === 0 ? `${calls.filter(isLoadResource).length} Load Resource call(s), none completed` : `a Load Resource completed: ${loaded.map((c) => c.id).join(', ')}`);
  const guards = [...log.toolCalls.values()].filter((c) => isLoopGuard(c));
  const guardProblems: string[] = [];
  for (const g of guards) {
    const choices = g.snapshots.map((s) => (isObject(s['rawOutput']) ? s['rawOutput']['userChoice'] : undefined)).filter((u) => u !== undefined);
    if (choices.some((u) => u !== 'cancel')) guardProblems.push(`${g.id} recorded userChoice ${choices.map(String).join(', ')}`);
    if (LOOP_PROMPT_ID.test(g.id)) {
      const answers = log.permissions.filter((p) => p.toolCallId === g.id);
      if (g.statuses.includes('completed') && !answers.some((a) => a.optionId === 'cancel')) guardProblems.push(`${g.id} completed without the client's cancel`);
      for (const a of answers) if (a.optionId !== 'cancel') guardProblems.push(`${g.id} answered ${String(a.optionId ?? a.option)}, not cancel`);
    } else if (g.statuses.includes('completed') && !choices.includes('cancel')) guardProblems.push(`${g.id} completed without recording cancel`);
  }
  check('loop-guard', guardProblems.length === 0, guards.length === 0 ? 'no loop guard' : guardProblems.length === 0 ? `${guards.length} loop-guard call(s), answered cancel` : guardProblems.join('; '));

  // Kiro's files under the leg's KIRO_HOME, read after the agent exited.
  const sid = log.sessionId;
  const dirs = sid !== null ? sessionDirs(kiroHome, sid) : [];
  const dir = dirs.length === 1 ? (dirs[0] as string) : null;
  let session: Json | null = null;
  let sessionProblem: string | null = null;
  if (dir === null) sessionProblem = `${dirs.length} session.json for ${String(sid)} under sessions/*/ (want exactly one)`;
  else {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as unknown;
      if (isObject(parsed)) session = parsed;
      else sessionProblem = 'session.json is not an object';
    } catch (error) {
      sessionProblem = `session.json unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (session !== null && session['id'] !== sid) sessionProblem = `session.json id ${String(session['id'])} is not the session ${String(sid)}`;
  }
  const s = sessionProblem === null ? session : null;
  const sessionPath = dir !== null ? join(dir, 'session.json') : null;
  if (!prompted) {
    for (const name of ['session-json', 'session-agent', 'session-roots', 'session-autopilot', 'session-model']) check(name, true, noTurn);
  } else {
    check('session-json', s !== null, s !== null ? `${String(sessionPath)}` : String(sessionProblem));
    const skip = 'no readable session.json (session-json fails)';
    check('session-agent', s === null || s['agentMode'] === KIRO_AGENT, s === null ? skip : `agentMode ${String(s['agentMode'])} (want ${KIRO_AGENT})`);
    const rootsOk = (v: unknown): boolean => Array.isArray(v) && v.length === 1 && typeof v[0] === 'string' && isRoot(v[0], h.root);
    check('session-roots', s === null || (rootsOk(s['rootPaths']) && rootsOk(s['workspacePaths'])), s === null ? skip : `rootPaths ${JSON.stringify(s['rootPaths'])}, workspacePaths ${JSON.stringify(s['workspacePaths'])}`);
    check('session-autopilot', s === null || s['autopilot'] === false, s === null ? skip : `autopilot ${String(s['autopilot'])}`);
    const namedBy = s !== null && isObject(s['modelNamedBy']) ? s['modelNamedBy'] : null;
    check(
      'session-model',
      s === null || (s['modelId'] === pin && namedBy !== null && namedBy['modelId'] === pin && namedBy['by'] === 'client'),
      s === null ? skip : `modelId ${String(s['modelId'])}, modelNamedBy ${JSON.stringify(s['modelNamedBy'])} (want ${pin} by client)`,
    );
  }
  const m = readMessages(dir !== null ? join(dir, 'messages.jsonl') : null);
  if (!prompted) {
    for (const name of ['messages-jsonl', 'messages-model', 'messages-calls', 'credit-split', 'credits-delegated']) check(name, true, noTurn);
  } else {
    const mProblem = dir === null ? 'no session dir (session-json fails)' : (m.problem ?? (m.modelNotes.length === 0 ? 'messages.jsonl holds no "The current model is" note' : null));
    check('messages-jsonl', mProblem === null, mProblem ?? `${String(m.path)}: ${m.modelNotes.length} model note(s), ${m.calls.size} call(s)`);
    const readable = mProblem === null;
    const offPin = m.modelNotes.filter((x) => x !== pin);
    check('messages-model', !readable || offPin.length === 0, !readable ? 'messages.jsonl not readable (messages-jsonl fails)' : offPin.length === 0 ? `every model note names ${pin}` : `model notes name ${offPin.map(String).join(', ')} (pinned ${pin})`);
    const disagree: string[] = [];
    if (readable) {
      const streamIds = new Set(calls.map((c) => c.id));
      // Only calls the stream shows as kiro's loop guard (by isLoopGuard) are skipped, never an id by its shape alone (PR #14 round 2).
      const guardIds = new Set([...log.toolCalls.values()].filter((c) => isLoopGuard(c)).map((c) => c.id));
      for (const id of m.calls.keys()) if (!streamIds.has(id) && !guardIds.has(id)) disagree.push(`${id} is in messages.jsonl but not in the stream`);
      for (const c of calls) {
        const mc = m.calls.get(c.id);
        const title = c.titles[0] ?? null;
        if (mc === undefined) {
          disagree.push(`${c.id} (${String(title)}) is in the stream but not in messages.jsonl`);
          continue;
        }
        if (mc.name === null || KIRO_V3_TITLES[title ?? ''] !== mc.name || (mc.title !== null && mc.title !== title)) disagree.push(`${c.id}: messages.jsonl names ${String(mc.name)} / ${String(mc.title)}, the stream ${String(title)}`);
        const r = m.results.get(c.id);
        const terminal = [...c.statuses].reverse().find((x) => x === 'completed' || x === 'failed') ?? null;
        const rejected = c.decision === 'reject';
        if (r === undefined) disagree.push(`${c.id}: no tool_result in messages.jsonl`);
        else {
          const statusOk = r.status === 'denied' ? rejected && terminal === 'failed' : r.status === 'approved' ? !rejected && terminal === (r.success === true ? 'completed' : 'failed') : false;
          if (!statusOk) disagree.push(`${c.id}: tool_result ${String(r.status)} (success ${String(r.success)}) vs the stream ${String(terminal)}${rejected ? ' after the client rejected it' : ''}`);
        }
      }
    }
    check('messages-calls', !readable || disagree.length === 0, !readable ? 'messages.jsonl not readable (messages-jsonl fails)' : disagree.length === 0 ? `${calls.length} call(s) agree by id, name and status` : disagree.join('; '));
    check('credit-split', !readable || m.creditSplit !== null, !readable ? 'messages.jsonl not readable (messages-jsonl fails)' : m.creditSplit !== null ? `creditSplit ${JSON.stringify(m.creditSplit)}` : 'messages.jsonl records no creditSplit');
    const delegated = m.creditSplit?.delegated ?? null;
    check('credits-delegated', delegated === null || delegated <= 0, delegated === null ? 'no creditSplit (credit-split fails)' : delegated > 0 ? `creditSplit.delegated ${delegated}: kiro handed work to another agent the stream does not show` : 'creditSplit.delegated 0');
  }

  // The leg's own version, from its log.
  const lv = legVersions(kiroHome);
  const preVersion = typeof h.data['cliVersion'] === 'string' ? h.data['cliVersion'] : null;
  if (!prompted) check('leg-version', true, noTurn);
  else {
    const ok = lv.versions.length === 1 && lv.versions[0] === preVersion;
    check('leg-version', ok, lv.versions.length === 0 ? `no KiroCLI/<version> line in ${lv.logs} kiro.log file(s) under the leg's KIRO_HOME/logs` : `the leg ran KiroCLI ${lv.versions.join(', ')} (KAS ${lv.kas.join(', ')}); preflight saw ${String(preVersion)}`);
  }

  // The agent file, unchanged, with no .json.bak beside it.
  const want = typeof h.data['agentHash'] === 'string' ? h.data['agentHash'] : null;
  let now: string | null = null;
  try {
    now = sha256Hex(readFileSync(agentFile));
  } catch {
    now = null;
  }
  const agentsDir = join(kiroHome, 'agents');
  const baks = existsSync(agentsDir) ? readdirSync(agentsDir).filter((n) => n.endsWith('.json.bak')) : [];
  check(
    'agent-file',
    want !== null && now === want && baks.length === 0,
    `${KIRO_AGENT}.json sha256 ${String(now).slice(0, 16)} (written ${String(want).slice(0, 16)})${baks.length > 0 ? `; ${baks.join(', ')} beside it` : ''}`,
  );

  // The preset stores, re-read: each missing or with no presets.
  const stores = new Set<string>([join(kiroHome, 'settings', 'permissions.yaml')]);
  const wr = join(kiroHome, 'workspace-roots');
  if (existsSync(wr)) for (const e of readdirSync(wr, { withFileTypes: true })) if (e.isDirectory()) stores.add(join(wr, e.name, 'permissions.yaml'));
  const aliases = rootAliases(kiroHome);
  const listed = [view !== null ? kiroOf(view.session)['presetStores'] : undefined, ...log.notes.filter((n) => n.method === '_kiro/policy/changed').map((n) => n.params['presetStores'])];
  for (const list of listed) {
    if (!Array.isArray(list)) continue;
    for (const st of list) {
      const file = isObject(st) ? str(st['file']) : null;
      if (file !== null && pathInsideRoot(file, kiroHome, aliases, { literalDollar: true }).inside) stores.add(file);
    }
  }
  const unreadable: string[] = [];
  const withPresets: string[] = [];
  for (const file of stores) {
    if (!existsSync(file)) continue;
    try {
      if (!noPresets(readFileSync(file, 'utf8'))) withPresets.push(file);
    } catch {
      unreadable.push(file);
    }
  }
  check('presets-read', unreadable.length === 0, unreadable.length === 0 ? `${stores.size} preset store path(s) re-read` : `unreadable: ${unreadable.join(', ')}`);
  check('presets-after', withPresets.length === 0, withPresets.length === 0 ? 'no preset store holds a preset after the leg' : `a preset after the leg in ${withPresets.join(', ')}`);

  const tagsOffered = (() => {
    const t = view?.notes.filter((n) => n.method === '_kiro/tools/didChange' && n.afterMark).at(-1);
    const list = t !== undefined && Array.isArray(t.params['tags']) ? t.params['tags'] : [];
    return list.map((x) => (isObject(x) ? `${String(x['source'])}:${String(x['tag'])}` : String(x)));
  })();
  return {
    checks,
    classOf: KIRO_V3_CLASS,
    fields: {
      cliVersion: lv.versions.length === 1 ? (lv.versions[0] ?? null) : preVersion,
      modelObserved: s !== null ? str(s['modelId']) : (log.configBefore['model'] ?? null),
      effortObserved: log.configBefore['effortLevel'] ?? null,
      credits,
      toolsOffered: tagsOffered,
      recordPath: sessionPath,
    },
    detail: {
      engine: 'v3',
      kiroHome,
      home: h.data['home'] ?? null,
      creditSplit: m.creditSplit,
      usedTools,
      legVersions: lv.versions,
      kas: lv.kas,
      agentHash: want,
      settingsWritten: h.data['settingsWritten'] ?? null,
      messagesPath: m.path,
      modelNotes: m.modelNotes,
      loopGuards: guards.map((g) => g.id),
    },
  };
}
