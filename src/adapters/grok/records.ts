import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isObject, num, readJsonl, str, type Json } from '../codex/records.js';

/*
 * The grok leg's session record (plan 4.2, 4.5): `$GROK_HOME/sessions/<URL-encoded cwd>/<session id>/` holds
 *   - `summary.json`: the session id and cwd, `session_kind`, the requested model and effort, the sandbox profile;
 *   - `usage.json`: the served model, tokens and cost (`costUsdTicks`, 1e10 ticks = 1 USD);
 *   - `tool_definitions.json`: the tools offered (must be exactly the read set);
 *   - `prompt_context.json`: the instruction files injected (must be none);
 *   - `events.jsonl`: MCP config and server starts, `turn_started` (model, yolo), tool starts and permission
 *     decisions, `turn_ended.outcome`;
 *   - `updates.jsonl`: the ACP-shaped `session/update` stream, whose `tool_call.rawInput` carries every tool path
 *     (N9: the read-path audit reads paths here and cross-checks them against the stream's tool uses), plus
 *     `hook_execution` entries;
 *   - `chat_history.jsonl`: each assistant turn's served model id and effort.
 * The stream (`streaming-messages-json`) has Claude Code's shape, so the claude stream reader parses it.
 */

export interface GrokSessionDir {
  path: string | null;
  /** Every directory named for the session under `sessions/` (one leg = one). */
  matches: string[];
  /** The `sessions/` child it sits in, decoded (the cwd grok keyed it by). */
  keyedCwd: string | null;
}

export function findGrokSession(grokHome: string, sessionId: string): GrokSessionDir {
  const base = join(grokHome, 'sessions');
  const matches: string[] = [];
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      const candidate = join(base, name, sessionId);
      try {
        if (statSync(candidate).isDirectory()) matches.push(candidate);
      } catch {
        // not this one
      }
    }
  }
  const path = matches.length === 1 ? (matches[0] as string) : null;
  let keyedCwd: string | null = null;
  if (path !== null) {
    const encoded = path.slice(base.length + 1, path.length - sessionId.length - 1);
    try {
      keyedCwd = decodeURIComponent(encoded);
    } catch {
      keyedCwd = encoded;
    }
  }
  return { path, matches, keyedCwd };
}

function readJson(path: string): { value: Json | unknown[] | null; problem: string | null } {
  if (!existsSync(path)) return { value: null, problem: 'missing' };
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (isObject(v) || Array.isArray(v)) return { value: v, problem: null };
    return { value: null, problem: 'not an object or list' };
  } catch {
    return { value: null, problem: 'malformed' };
  }
}

export interface GrokToolCall {
  id: string;
  /** Every tool name the call was reported with: `_meta["x.ai/tool"].name`, the first snapshot's `title`, `name`. */
  names: string[];
  kind: string | null;
  /**
   * Every argument snapshot, never merged: each `rawInput`, each `_meta["x.ai/tool"].input`, each `locations` list.
   * A later update can never erase a path an earlier one named (codex F4).
   */
  inputs: Json[];
  /** Paths the call's own output names (`FileContent.absolute_path`, `Content.absolute_root_path`, `file_matches[].path`). */
  outputPaths: string[];
  statuses: string[];
}

/** Paths a read tool's `rawOutput` names, by the recorded 1.0.70 shapes. */
export function outputPaths(raw: unknown): string[] {
  if (!isObject(raw)) return [];
  const out: string[] = [];
  const file = isObject(raw['FileContent']) ? raw['FileContent'] : null;
  if (file !== null && typeof file['absolute_path'] === 'string') out.push(file['absolute_path']);
  const listing = isObject(raw['Content']) ? raw['Content'] : null;
  if (listing !== null && typeof listing['absolute_root_path'] === 'string') out.push(listing['absolute_root_path']);
  if (Array.isArray(raw['file_matches'])) {
    for (const m of raw['file_matches']) if (isObject(m) && typeof m['path'] === 'string') out.push(m['path']);
  }
  return out;
}

export interface GrokSession {
  dir: string;
  summary: Json | null;
  usage: Json | null;
  /** Offered tool names, or null when the file is missing or unreadable. */
  offered: string[] | null;
  promptContext: Json | null;
  events: Json[];
  eventsMalformed: number;
  updates: Json[];
  updatesMalformed: number;
  /** Tool calls from `updates.jsonl`, by id, merged over every update. */
  toolCalls: Map<string, GrokToolCall>;
  hookRuns: Json[];
  assistantMeta: Array<{ model: string | null; effort: string | null }>;
  chatMalformed: number;
  problems: string[];
}

/** Every object below `v` that carries a `sessionUpdate` field (the ACP update shape, at any depth). */
function sessionUpdates(v: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(v)) for (const x of v) sessionUpdates(x, out);
  else if (isObject(v)) {
    if (typeof v['sessionUpdate'] === 'string') out.push(v);
    else for (const x of Object.values(v)) sessionUpdates(x, out);
  }
  return out;
}

/** Names of a tool-definitions entry: `name` or `function.name`. */
function definitionName(d: unknown): string | null {
  if (!isObject(d)) return typeof d === 'string' ? d : null;
  return str(d['name']) ?? (isObject(d['function']) ? str(d['function']['name']) : null);
}

export function readGrokSession(dir: string): GrokSession {
  const problems: string[] = [];
  const obj = (name: string): Json | null => {
    const r = readJson(join(dir, name));
    if (r.problem !== null || !isObject(r.value)) {
      problems.push(`${name} ${r.problem ?? 'not an object'}`);
      return null;
    }
    return r.value;
  };
  const summary = obj('summary.json');
  const usage = obj('usage.json');
  const promptContext = obj('prompt_context.json');
  const defs = readJson(join(dir, 'tool_definitions.json'));
  let offered: string[] | null = null;
  if (defs.problem === null && Array.isArray(defs.value)) {
    const names = defs.value.map(definitionName);
    if (names.every((n): n is string => n !== null)) offered = names;
    else problems.push('tool_definitions.json holds an entry with no name');
  } else problems.push(`tool_definitions.json ${defs.problem ?? 'not a list'}`);

  const ev = existsSync(join(dir, 'events.jsonl')) ? readJsonl(join(dir, 'events.jsonl')) : null;
  if (ev === null) problems.push('events.jsonl missing');
  const up = existsSync(join(dir, 'updates.jsonl')) ? readJsonl(join(dir, 'updates.jsonl')) : null;
  if (up === null) problems.push('updates.jsonl missing');
  const toolCalls = new Map<string, GrokToolCall>();
  const hookRuns: Json[] = [];
  for (const row of up?.rows ?? []) {
    for (const u of sessionUpdates(row)) {
      const kind = str(u['sessionUpdate']);
      if (kind === 'hook_execution') {
        hookRuns.push(u);
        continue;
      }
      if (kind !== 'tool_call' && kind !== 'tool_call_update') continue;
      const id = str(u['toolCallId']);
      if (id === null) continue;
      const call = toolCalls.get(id) ?? { id, names: [], kind: null, inputs: [], outputPaths: [], statuses: [] };
      const meta = isObject(u['_meta']) && isObject(u['_meta']['x.ai/tool']) ? u['_meta']['x.ai/tool'] : null;
      // The first snapshot's `title` is the tool name; later titles are display text (`Read \`path\``).
      const names = [meta !== null ? str(meta['name']) : null, str(u['name']), kind === 'tool_call' ? str(u['title']) : null];
      for (const n of names) if (n !== null && !call.names.includes(n)) call.names.push(n);
      call.kind = call.kind ?? str(u['kind']);
      for (const input of [u['rawInput'], meta !== null ? meta['input'] : undefined]) {
        if (isObject(input) && Object.keys(input).length > 0) call.inputs.push(input);
      }
      if (Array.isArray(u['locations']) && u['locations'].length > 0) call.inputs.push({ locations: u['locations'] });
      call.outputPaths.push(...outputPaths(u['rawOutput']));
      const status = str(u['status']);
      if (status !== null) call.statuses.push(status);
      toolCalls.set(id, call);
    }
  }
  const chat = existsSync(join(dir, 'chat_history.jsonl')) ? readJsonl(join(dir, 'chat_history.jsonl')) : null;
  if (chat === null) problems.push('chat_history.jsonl missing');
  const assistantMeta = (chat?.rows ?? [])
    .filter((r) => str(r['type']) === 'assistant')
    .map((r) => ({ model: str(r['model_id']), effort: str(r['reasoning_effort']) }));
  return {
    dir,
    summary,
    usage,
    offered,
    promptContext,
    events: ev?.rows ?? [],
    eventsMalformed: ev === null ? 0 : ev.malformed + (ev.tornTail ? 1 : 0),
    updates: up?.rows ?? [],
    updatesMalformed: up === null ? 0 : up.malformed + (up.tornTail ? 1 : 0),
    toolCalls,
    hookRuns,
    assistantMeta,
    chatMalformed: chat === null ? 0 : chat.malformed + (chat.tornTail ? 1 : 0),
    problems,
  };
}

/** Events of one type, in order. */
export function eventsOf(s: GrokSession, type: string): Json[] {
  return s.events.filter((e) => str(e['type']) === type);
}

/** Session totals from `usage.json`. */
export function grokUsage(s: GrokSession): { primary: string | null; models: string[]; tokensIn: number | null; tokensOut: number | null; costUsd: number | null } {
  const session = s.usage && isObject(s.usage['session']) ? s.usage['session'] : null;
  const ticks = session ? num(session['costUsdTicks']) : null;
  return {
    primary: session ? str(session['primaryModelId']) : null,
    models: session && isObject(session['modelUsage']) ? Object.keys(session['modelUsage']) : [],
    tokensIn: session ? num(session['inputTokens']) : null,
    tokensOut: session ? num(session['outputTokens']) : null,
    costUsd: ticks !== null ? ticks / 1e10 : null,
  };
}

/** Copies the session dir into the leg dir (evidence for the run store). Never throws. */
export function copyGrokSession(from: string, to: string): string | null {
  try {
    cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.lock') });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
