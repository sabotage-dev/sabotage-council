import { existsSync, readFileSync } from 'node:fs';
import { configValues } from '../../transport/acp.js';
import { isObject, num, requestPaths, str } from './policy.js';

/*
 * The reader for an ACP leg's update log (written by the transport): every message both ways, verbatim, and every
 * client decision. Ratification reads only this file and the adapter's own records, so a replay of a recorded
 * log is a full test of the ratifier.
 */

type Json = Record<string, unknown>;

export interface AcpToolCall {
  id: string;
  /** Merged fields from every `tool_call` and `tool_call_update` (later values win). */
  fields: Json;
  /** Every kind the call was reported with. */
  kinds: string[];
  titles: string[];
  statuses: string[];
  /** The client's answer to its permission request, if the agent asked. */
  decision: 'allow' | 'reject' | null;
  /** How many statuses had been reported when the client first rejected the call (null: never rejected). */
  rejectedAt: number | null;
  /** The permission request's own tool-call fields, if the agent asked. */
  asked: Json | null;
  /** Every snapshot the call was reported with (each update, and each permission request's `toolCall`), in order. */
  snapshots: Json[];
  /** Paths a permission request named outside its `toolCall` (`_meta.fsReadPaths`). */
  extraPaths: string[];
  /** Position of the first update for the call in the log (ordering with the prompt). */
  firstLine: number;
}

export interface AcpRpc {
  method: string;
  params: Json;
  result: unknown;
  error: string | null;
  line: number;
}

export interface AcpLog {
  path: string;
  exists: boolean;
  /** Lines of the log itself that do not parse (the log is written by the engine, so any is a fault). */
  malformed: number;
  /** Non-JSON lines the agent printed on stdout. */
  rawLines: string[];
  /** A last stdout line without a newline when the agent exited. */
  tornLine: string | null;
  /** Requests the client sent, paired with their responses. */
  rpcs: AcpRpc[];
  initialize: AcpRpc | null;
  sessionNew: AcpRpc | null;
  sessionId: string | null;
  prompt: AcpRpc | null;
  /** Line of the `session/prompt` request, or Infinity. */
  promptLine: number;
  /** Config values as reported before the prompt (session/new, set responses, updates). */
  configBefore: Record<string, string>;
  /** Config or mode values the agent reported after the prompt was sent, in order. */
  configAfter: Array<{ id: string; value: string }>;
  pinsHeld: boolean;
  refused: string | null;
  toolCalls: Map<string, AcpToolCall>;
  /** Permission requests in order, with the client's answer. */
  permissions: Array<{ toolCallId: string | null; toolCall: Json; decision: 'allow' | 'reject'; option: string; why: string }>;
  refusedClientMethods: string[];
  /** Agent message text, split into segments at each tool call. The answer is all of them, in order. */
  messageSegments: string[];
  updateKinds: Record<string, number>;
  usageUpdates: Json[];
  /** Error texts from RPC errors and agent error data (for the failure classifier). */
  errorTexts: string[];
  clientEvents: Json[];
  exit: Json | null;
}

function rpcErrorText(e: unknown): string | null {
  if (e === undefined || e === null) return null;
  if (isObject(e)) {
    const data = e['data'] !== undefined ? ` ${typeof e['data'] === 'string' ? e['data'] : JSON.stringify(e['data'])}` : '';
    return `${String(e['message'] ?? 'error')}${data}`;
  }
  return String(e);
}

export function readAcpLog(path: string): AcpLog {
  const log: AcpLog = {
    path,
    exists: existsSync(path),
    malformed: 0,
    rawLines: [],
    tornLine: null,
    rpcs: [],
    initialize: null,
    sessionNew: null,
    sessionId: null,
    prompt: null,
    promptLine: Number.POSITIVE_INFINITY,
    configBefore: {},
    configAfter: [],
    pinsHeld: false,
    refused: null,
    toolCalls: new Map(),
    permissions: [],
    refusedClientMethods: [],
    messageSegments: [],
    updateKinds: {},
    usageUpdates: [],
    errorTexts: [],
    clientEvents: [],
    exit: null,
  };
  if (!log.exists) return log;
  const lines = readFileSync(path, 'utf8').split('\n');
  const sent = new Map<number, AcpRpc>();
  let segment = '';
  let segmentOpen = false;
  const closeSegment = (): void => {
    if (segmentOpen) log.messageSegments.push(segment);
    segment = '';
    segmentOpen = false;
  };
  const report = (line: number, values: Record<string, string>): void => {
    for (const [id, value] of Object.entries(values)) {
      if (line > log.promptLine) {
        if (log.configBefore[id] !== value) log.configAfter.push({ id, value });
      } else {
        log.configBefore[id] = value;
      }
    }
  };

  lines.forEach((text, i) => {
    if (text.trim() === '') return;
    let entry: unknown;
    try {
      entry = JSON.parse(text);
    } catch {
      log.malformed++;
      return;
    }
    if (!isObject(entry)) {
      log.malformed++;
      return;
    }
    const dir = entry['dir'];
    if (dir === 'recv-raw') {
      log.rawLines.push(String(entry['line'] ?? ''));
      return;
    }
    if (dir === 'recv-torn') {
      log.tornLine = String(entry['line'] ?? '');
      return;
    }
    if (dir === 'client') {
      log.clientEvents.push(entry);
      const event = entry['event'];
      if (event === 'permission') {
        const id = str(entry['toolCallId']);
        const decision = entry['decision'] === 'allow' ? 'allow' : 'reject';
        const last = log.permissions[log.permissions.length - 1];
        if (last && last.toolCallId === id && last.option === '') {
          last.decision = decision;
          last.option = String(entry['option'] ?? '');
          last.why = String(entry['why'] ?? '');
        }
        if (id !== null) {
          const call = log.toolCalls.get(id);
          // A call rejected once stays rejected; an allow never overrides an earlier reject.
          if (call) {
            if (decision === 'reject' && call.rejectedAt === null) call.rejectedAt = call.statuses.length;
            call.decision = call.decision === 'reject' ? 'reject' : decision;
          }
        }
      } else if (event === 'refused-client-method') {
        log.refusedClientMethods.push(String(entry['method'] ?? '?'));
      } else if (event === 'refused') {
        log.refused = String(entry['reason'] ?? 'refused');
      } else if (event === 'pins-held') {
        log.pinsHeld = true;
      } else if (event === 'exit') {
        log.exit = isObject(entry['exit']) ? entry['exit'] : null;
      }
      return;
    }
    const msg = entry['msg'];
    if (!isObject(msg)) {
      log.malformed++;
      return;
    }
    if (dir === 'send') {
      const id = msg['id'];
      const method = str(msg['method']);
      if (typeof id === 'number' && method !== null) {
        const rpc: AcpRpc = { method, params: isObject(msg['params']) ? msg['params'] : {}, result: undefined, error: null, line: i };
        sent.set(id, rpc);
        log.rpcs.push(rpc);
        if (method === 'session/prompt') {
          log.prompt = rpc;
          log.promptLine = i;
        }
        if (method === 'initialize') log.initialize = rpc;
        if (method === 'session/new') log.sessionNew = rpc;
      }
      return;
    }
    if (dir !== 'recv') {
      log.malformed++;
      return;
    }
    const id = msg['id'];
    const method = str(msg['method']);
    if (id !== undefined && method === null) {
      const rpc = typeof id === 'number' ? sent.get(id) : undefined;
      if (!rpc) return;
      rpc.result = msg['result'];
      rpc.error = rpcErrorText(msg['error']);
      if (rpc.error !== null) log.errorTexts.push(rpc.error);
      if (isObject(rpc.result)) {
        if (rpc.method === 'session/new' && typeof rpc.result['sessionId'] === 'string') log.sessionId = rpc.result['sessionId'];
        const values = configValues(rpc.result['configOptions']);
        const modes = rpc.result['modes'];
        if (isObject(modes) && typeof modes['currentModeId'] === 'string' && values['mode'] === undefined) values['mode'] = modes['currentModeId'];
        const models = rpc.result['models'];
        if (isObject(models) && typeof models['currentModelId'] === 'string' && values['model'] === undefined) values['model'] = models['currentModelId'];
        report(i, values);
      }
      if (rpc.method === 'session/set_mode' && rpc.error === null) {
        const modeId = str(rpc.params['modeId']);
        if (modeId !== null) report(i, { mode: modeId });
      }
      return;
    }
    if (id !== undefined && method === 'session/request_permission') {
      const params = isObject(msg['params']) ? msg['params'] : {};
      const toolCall = isObject(params['toolCall']) ? params['toolCall'] : {};
      const toolCallId = str(toolCall['toolCallId']);
      log.permissions.push({ toolCallId, toolCall, decision: 'reject', option: '', why: '' });
      if (toolCallId !== null) {
        const call = log.toolCalls.get(toolCallId) ?? newCall(toolCallId, i);
        call.asked = toolCall;
        // The request's own status is the agent's view while it waits, not progress: it is not merged.
        mergeInto(call, { ...toolCall, status: undefined });
        call.extraPaths.push(...requestPaths(params));
        log.toolCalls.set(toolCallId, call);
      }
      return;
    }
    if (method !== 'session/update') return;
    const params = isObject(msg['params']) ? msg['params'] : {};
    const update = isObject(params['update']) ? params['update'] : {};
    const kind = str(update['sessionUpdate']) ?? '(none)';
    log.updateKinds[kind] = (log.updateKinds[kind] ?? 0) + 1;
    if (kind === 'agent_message_chunk') {
      const content = update['content'];
      if (isObject(content) && content['type'] === 'text' && typeof content['text'] === 'string') {
        segment += content['text'];
        segmentOpen = true;
      }
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      closeSegment();
      const toolCallId = str(update['toolCallId']);
      // A tool update the ratifier cannot attribute to a call is a malformed record line: it fails `log`.
      if (toolCallId === null) {
        log.malformed++;
        return;
      }
      const call = log.toolCalls.get(toolCallId) ?? newCall(toolCallId, i);
      mergeInto(call, update);
      log.toolCalls.set(toolCallId, call);
    } else if (kind === 'config_option_update') {
      report(i, configValues(update['configOptions']));
    } else if (kind === 'current_mode_update') {
      const modeId = str(update['currentModeId']);
      if (modeId !== null) report(i, { mode: modeId });
    } else if (kind === 'usage_update') {
      log.usageUpdates.push(update);
    }
  });
  closeSegment();
  return log;
}

function newCall(id: string, line: number): AcpToolCall {
  return { id, fields: {}, kinds: [], titles: [], statuses: [], decision: null, rejectedAt: null, asked: null, snapshots: [], extraPaths: [], firstLine: line };
}

function mergeInto(call: AcpToolCall, update: Json): void {
  call.snapshots.push(update);
  for (const [k, v] of Object.entries(update)) if (v !== undefined && v !== null) call.fields[k] = v;
  const kind = str(update['kind']);
  if (kind !== null && !call.kinds.includes(kind)) call.kinds.push(kind);
  const title = str(update['title']);
  if (title !== null && !call.titles.includes(title)) call.titles.push(title);
  const status = str(update['status']);
  if (status !== null) call.statuses.push(status);
}

/** Whether a value holds non-empty text at any depth. A `type` tag (`"content"`, `"text"`) is structure, not text. */
function hasText(v: unknown): boolean {
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.some(hasText);
  if (isObject(v)) return Object.entries(v).some(([k, x]) => k !== 'type' && hasText(x));
  return false;
}

/** ACP content blocks that only exist once a tool acted: a diff (a write) or a terminal (a command). */
function actionBlock(v: unknown): boolean {
  return Array.isArray(v) && v.some((b) => isObject(b) && (b['type'] === 'diff' || b['type'] === 'terminal'));
}

/**
 * Whether a call carries tool output: non-empty text in `rawOutput` or `content`, or a diff or terminal block, in any
 * snapshot. A snapshot in which the agent reports its own refusal (`denialNotice`) carries a notice, not output.
 */
export function hasOutput(call: AcpToolCall, denialNotice?: (snapshot: Json) => boolean): boolean {
  return call.snapshots.some((s) => !(denialNotice?.(s) ?? false) && (hasText(s['rawOutput']) || hasText(s['content']) || actionBlock(s['content'])));
}

/**
 * Whether a tool call ran, on the evidence of every snapshot:
 *   - `completed` at any position, or tool output at any position, before or after a rejection: it ran;
 *   - a call the client never rejected that was reported `in_progress`: it ran;
 *   - the one measured exception: a rejected call whose only progress is a bare `in_progress` with no output. agy
 *     1.5.7 reports `in_progress` when a call starts, before it asks, and again on its way to `failed` after a
 *     rejection; the canary's secret never reached the stream.
 * A call that only ever went to `failed` with no output (agy drops the rest of a batch that way) did not start.
 */
export function executed(call: AcpToolCall, denialNotice?: (snapshot: Json) => boolean): boolean {
  if (call.statuses.includes('completed') || hasOutput(call, denialNotice)) return true;
  if (call.rejectedAt !== null) return false;
  return call.statuses.includes('in_progress');
}

/**
 * The answer: everything the agent said in the turn, its message segments joined by a blank line. A model may
 * open with the NONCE line, read files, and finish the review after the reads (kiro on 3.2.1 did), so the reply is
 * the whole turn, and its first non-empty line is the one the nonce rule checks.
 */
export function acpAnswer(log: AcpLog): string | null {
  const text = log.messageSegments.filter((s) => s.trim() !== '').join('\n\n');
  return text.trim() !== '' ? text : null;
}

/** Token usage from the prompt response (`usage`) when the agent sends it. */
export function promptUsage(log: AcpLog): { input: number | null; output: number | null; thought: number | null } {
  const result = log.prompt?.result;
  const usage = isObject(result) && isObject(result['usage']) ? result['usage'] : {};
  return { input: num(usage['inputTokens']), output: num(usage['outputTokens']), thought: num(usage['thoughtTokens']) };
}

/** The stop reason of the prompt, when it was answered. */
export function stopReason(log: AcpLog): string | null {
  const result = log.prompt?.result;
  return isObject(result) ? str(result['stopReason']) : null;
}
