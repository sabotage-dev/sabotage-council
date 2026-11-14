import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isObject, num, readJsonl, str, type Json } from '../codex/records.js';

/*
 * Readers for the claude records (plan 4.2): the stream-json output (`system/init`, assistant tool uses, the
 * `result` line) and the transcript `<projects>/<cwd slug>/<session>.jsonl`, which records the model and effort
 * of every API request.
 */

export interface ToolUse {
  name: string;
  input: Json;
  source: 'stream' | 'transcript';
}

/** The paths a tool's own result reports (a Read's `file.filePath`, an Edit's `filePath`, a Glob's `filenames`). */
export interface ToolResultPaths {
  toolUseId: string | null;
  paths: string[];
  source: 'stream' | 'transcript';
}

export interface ClaudeStream {
  init: Json | null;
  result: Json | null;
  toolUses: ToolUse[];
  /** Paths named by tool results (`tool_use_result` on the user rows). */
  toolResults: ToolResultPaths[];
  /** Main-thread assistant text blocks, in order: the whole reply. */
  texts: string[];
  /** `message.id` of each assistant line, in order: one id per API request. */
  messageIds: string[];
  /** More than one init or result line (a resumed or second session in one stream). */
  extraInit: number;
  malformed: number;
  /** The last line is cut off. */
  tornTail: boolean;
}

/** Every path a tool result names: `filePath`, `file.filePath`, and each entry of `filenames`. */
export function resultPaths(result: unknown): string[] {
  if (!isObject(result)) return [];
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') out.push(v);
  };
  add(result['filePath']);
  if (isObject(result['file'])) add(result['file']['filePath']);
  if (Array.isArray(result['filenames'])) for (const f of result['filenames']) add(f);
  return out;
}

/** The tool_use_id of a user row's tool_result block, when it has exactly one. */
function resultIdOf(message: unknown): string | null {
  if (!isObject(message) || !Array.isArray(message['content'])) return null;
  const ids = message['content'].filter((b) => isObject(b) && str(b['type']) === 'tool_result').map((b) => (isObject(b) ? str(b['tool_use_id']) : null));
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

function toolUsesOf(message: unknown, source: ToolUse['source']): ToolUse[] {
  if (!isObject(message) || !Array.isArray(message['content'])) return [];
  const out: ToolUse[] = [];
  for (const block of message['content']) {
    if (isObject(block) && str(block['type']) === 'tool_use') {
      out.push({ name: str(block['name']) ?? '', input: isObject(block['input']) ? block['input'] : {}, source });
    }
  }
  return out;
}

export function readClaudeStream(path: string): ClaudeStream {
  const out: ClaudeStream = { init: null, result: null, toolUses: [], toolResults: [], texts: [], messageIds: [], extraInit: 0, malformed: 0, tornTail: false };
  if (!existsSync(path)) return out;
  const { rows, malformed, tornTail } = readJsonl(path);
  out.malformed = malformed;
  out.tornTail = tornTail;
  for (const row of rows) {
    const type = str(row['type']);
    if (type === 'system' && str(row['subtype']) === 'init') {
      if (out.init) out.extraInit++;
      else out.init = row;
    } else if (type === 'result') {
      if (out.result) out.extraInit++;
      out.result = row;
    } else if (type === 'user') {
      const paths = resultPaths(row['tool_use_result']);
      if (paths.length > 0) out.toolResults.push({ toolUseId: resultIdOf(row['message']), paths, source: 'stream' });
    } else if (type === 'assistant') {
      out.toolUses.push(...toolUsesOf(row['message'], 'stream'));
      const message = row['message'];
      const id = isObject(message) ? str(message['id']) : null;
      if (id !== null) out.messageIds.push(id);
      // The reply's text comes from the main thread only: a row with a `parent_tool_use_id` belongs to a sub-agent.
      const mainThread = row['parent_tool_use_id'] === undefined || row['parent_tool_use_id'] === null;
      if (mainThread && isObject(message) && Array.isArray(message['content'])) {
        for (const block of message['content']) {
          if (isObject(block) && str(block['type']) === 'text') out.texts.push(str(block['text']) ?? '');
        }
      }
    }
  }
  return out;
}

/** The stream has its `result` line: the record-based done signal. */
export function streamDone(path: string): boolean {
  if (!existsSync(path)) return false;
  return readClaudeStream(path).result !== null;
}

export interface Transcript {
  path: string;
  entries: Json[];
  malformed: number;
  tornTail: boolean;
}

/** Where transcripts live: `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function claudeProjectsDir(env: NodeJS.ProcessEnv): string {
  const config = env['CLAUDE_CONFIG_DIR'];
  if (config !== undefined && config !== '') return join(config, 'projects');
  return join(env['HOME'] ?? homedir(), '.claude', 'projects');
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Finds `<projects>/<any slug>/<session>.jsonl`. The slug rule is the CLI's; matching on the session id avoids it. */
export function findTranscript(projectsDir: string, sessionId: string): string | null {
  if (!SESSION_ID.test(sessionId)) return null;
  let slugs: string[];
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    const path = join(projectsDir, slug, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}

export function readTranscript(path: string): Transcript {
  const { rows, malformed, tornTail } = readJsonl(path);
  return { path, entries: rows, malformed, tornTail };
}

export interface TranscriptFacts {
  sessionIds: string[];
  cwds: string[];
  /** `api-request.params.model` and `.output_config.effort`, one pair per request. */
  requests: Array<{ model: string | null; effort: string | null; querySource: string | null }>;
  /** `assistant.message.model` of real (non-synthetic) turns. */
  assistantModels: string[];
  /** `assistant.message.id` of every assistant entry, in order. */
  assistantIds: string[];
  /** Every assistant text block, in order. */
  assistantTexts: string[];
  apiErrors: Array<{ status: number | null; text: string }>;
  toolUses: ToolUse[];
  /** Paths named by tool results (`toolUseResult` on the user entries). */
  toolResults: ToolResultPaths[];
  sidechains: number;
  /** Attachment types of instruction files that loaded (user-owned context). */
  instructionFiles: string[];
}

export function transcriptFacts(t: Transcript): TranscriptFacts {
  const facts: TranscriptFacts = {
    sessionIds: [],
    cwds: [],
    requests: [],
    assistantModels: [],
    assistantIds: [],
    assistantTexts: [],
    apiErrors: [],
    toolUses: [],
    toolResults: [],
    sidechains: 0,
    instructionFiles: [],
  };
  const sessions = new Set<string>();
  for (const e of t.entries) {
    const type = str(e['type']);
    const sid = str(e['sessionId']);
    if (sid) sessions.add(sid);
    const cwd = str(e['cwd']);
    if (cwd) facts.cwds.push(cwd);
    if (e['isSidechain'] === true) facts.sidechains++;
    if (type === 'api-request') {
      const params = isObject(e['params']) ? e['params'] : {};
      const config = isObject(params['output_config']) ? params['output_config'] : {};
      facts.requests.push({ model: str(params['model']), effort: str(config['effort']), querySource: str(e['querySource']) });
    } else if (type === 'assistant') {
      const message = isObject(e['message']) ? e['message'] : {};
      const model = str(message['model']);
      const id = str(message['id']);
      if (id !== null) facts.assistantIds.push(id);
      if (Array.isArray(message['content'])) {
        for (const block of message['content']) if (isObject(block) && str(block['type']) === 'text') facts.assistantTexts.push(str(block['text']) ?? '');
      }
      if (e['isApiErrorMessage'] === true) {
        facts.apiErrors.push({ status: num(e['apiErrorStatus']), text: JSON.stringify(e['error'] ?? null) });
      } else if (model !== null && model !== '<synthetic>') {
        facts.assistantModels.push(model);
      }
      facts.toolUses.push(...toolUsesOf(message, 'transcript'));
    } else if (type === 'user') {
      const paths = resultPaths(e['toolUseResult']);
      if (paths.length > 0) facts.toolResults.push({ toolUseId: resultIdOf(e['message']), paths, source: 'transcript' });
    } else if (type === 'attachment') {
      const att = isObject(e['attachment']) ? e['attachment'] : {};
      if (str(att['type']) === 'instructions' || str(att['type']) === 'nested_memory') {
        const items = Array.isArray(att['files']) ? att['files'] : Array.isArray(att['detail']) ? att['detail'] : [];
        for (const item of items) if (isObject(item) && str(item['path'])) facts.instructionFiles.push(str(item['path']) as string);
        if (items.length === 0) facts.instructionFiles.push(str(att['type']) ?? 'instructions');
      }
    }
  }
  facts.sessionIds = [...sessions];
  return facts;
}

/** Paths a read tool call names: Read `file_path`; Glob `path` and `pattern`; Grep `path` and `glob`. */
export function toolPaths(use: ToolUse): string[] {
  const input = use.input;
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v !== '') out.push(v);
  };
  if (use.name === 'Read') add(input['file_path']);
  if (use.name === 'Glob') {
    add(input['path']);
    add(input['pattern']);
  }
  if (use.name === 'Grep') {
    add(input['path']);
    add(input['glob']);
  }
  return out;
}
