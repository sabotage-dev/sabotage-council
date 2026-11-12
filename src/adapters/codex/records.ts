import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Readers for the codex records (plan 4.2): the `--json` event stream on stdout, and the rollout
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread>.jsonl`. Both readers are tolerant of a torn last
 * line (a killed CLI), and count malformed lines so the ratifier can fail closed on them.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function readJsonl(path: string): { rows: Json[]; malformed: number; tornTail: boolean } {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const rows: Json[] = [];
  let malformed = 0;
  let tornTail = false;
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      const value: unknown = JSON.parse(line);
      if (isObject(value)) rows.push(value);
      else malformed++;
    } catch {
      // Only the final line may be torn by a kill; anything earlier is malformed.
      if (i === lines.length - 1) tornTail = true;
      else malformed++;
    }
  });
  return { rows, malformed, tornTail };
}

export interface CodexEvents {
  threadId: string | null;
  turnCompleted: boolean;
  turnFailed: string[];
  /** Top-level `error` events (retries and fatal errors alike). */
  errors: string[];
  /** `item.completed` items of type `error` (warnings, deprecations and model reroutes). */
  errorItems: string[];
  agentMessages: string[];
  commandOutputs: string[];
  usage: { input: number | null; output: number | null } | null;
  malformed: number;
  /** The last line is cut off (a killed CLI, or a stream still being written). */
  tornTail: boolean;
}

export function readEvents(path: string): CodexEvents {
  const out: CodexEvents = {
    threadId: null,
    turnCompleted: false,
    turnFailed: [],
    errors: [],
    errorItems: [],
    agentMessages: [],
    commandOutputs: [],
    usage: null,
    malformed: 0,
    tornTail: false,
  };
  if (!existsSync(path)) return out;
  const { rows, malformed, tornTail } = readJsonl(path);
  out.malformed = malformed;
  out.tornTail = tornTail;
  for (const row of rows) {
    const type = str(row['type']);
    if (type === 'thread.started') out.threadId ??= str(row['thread_id']);
    else if (type === 'turn.completed') {
      out.turnCompleted = true;
      const usage = isObject(row['usage']) ? row['usage'] : {};
      out.usage = { input: num(usage['input_tokens']), output: num(usage['output_tokens']) };
    } else if (type === 'turn.failed') {
      const error = isObject(row['error']) ? row['error'] : {};
      out.turnFailed.push(str(error['message']) ?? JSON.stringify(row['error'] ?? null));
    } else if (type === 'error') {
      out.errors.push(str(row['message']) ?? JSON.stringify(row));
    } else if (type === 'item.completed' && isObject(row['item'])) {
      const item = row['item'];
      const itemType = str(item['type']);
      if (itemType === 'agent_message') out.agentMessages.push(str(item['text']) ?? '');
      else if (itemType === 'error') out.errorItems.push(str(item['message']) ?? '');
      else if (itemType === 'command_execution') out.commandOutputs.push(str(item['aggregated_output']) ?? '');
    }
  }
  return out;
}

/** The last `turn.completed` or `turn.failed` in the stream: the record-based done signal (plan 4.1). */
export function eventsDone(path: string): boolean {
  if (!existsSync(path)) return false;
  const size = statSync(path).size;
  const want = Math.min(size, 64 * 1024);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(want);
    readSync(fd, buffer, 0, want, size - want);
    const lines = buffer.toString('utf8').split('\n').filter((l) => l.trim() !== '');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const row: unknown = JSON.parse(lines[i] ?? '');
        if (!isObject(row)) continue;
        const type = str(row['type']);
        return type === 'turn.completed' || type === 'turn.failed';
      } catch {
        continue;
      }
    }
    return false;
  } finally {
    closeSync(fd);
  }
}

export interface RolloutLine {
  index: number;
  /** The line's `ordinal`, or its index when the line has none. */
  ordinal: number;
  type: string;
  payload: Json;
}

export interface Rollout {
  path: string;
  lines: RolloutLine[];
  malformed: number;
  tornTail: boolean;
  /** The first `session_meta` payload: this thread's own. Later ones belong to forked history. */
  meta: Json | null;
  /** Lines before this ordinal are history forked from the parent (`subagent_history_start_ordinal`). */
  ownStart: number;
}

export function readRollout(path: string): Rollout {
  const { rows, malformed, tornTail } = readJsonl(path);
  const lines: RolloutLine[] = rows.map((row, index) => ({
    index,
    ordinal: num(row['ordinal']) ?? index,
    type: str(row['type']) ?? '',
    payload: isObject(row['payload']) ? row['payload'] : {},
  }));
  const metaLine = lines.find((l) => l.type === 'session_meta');
  const meta = metaLine ? metaLine.payload : null;
  const ownStart = meta ? (num(meta['subagent_history_start_ordinal']) ?? 0) : 0;
  return { path, lines, malformed, tornTail, meta, ownStart };
}

/** This thread's own lines: forked parent history and the session_meta lines are left out. */
export function ownLines(r: Rollout): RolloutLine[] {
  return r.lines.filter((l) => l.ordinal >= r.ownStart && l.type !== 'session_meta');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** The local-date directories around a time, newest last. Rollout directories use local time. */
function dayDirs(sessions: string, around: Date): string[] {
  const out: string[] = [];
  for (const delta of [-1, 0, 1]) {
    const d = new Date(around.getTime() + delta * 86_400_000);
    out.push(join(sessions, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  return out;
}

function listRollouts(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith('rollout-') && name.endsWith('.jsonl'))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Every rollout file in the sessions tree (fallback when the dated directories miss). */
function allRollouts(sessions: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (depth < 3) walk(path, depth + 1);
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) out.push(path);
    }
  };
  walk(sessions, 0);
  return out;
}

/** Locates the rollout of a thread from its `thread.started` id (plan 4.2). */
export function findRollout(codexHome: string, threadId: string, around: Date): string | null {
  if (!THREAD_ID.test(threadId)) return null;
  const sessions = join(codexHome, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  for (const dir of dayDirs(sessions, around)) {
    const hit = listRollouts(dir).find((p) => p.endsWith(suffix));
    if (hit) return hit;
  }
  return allRollouts(sessions).find((p) => p.endsWith(suffix)) ?? null;
}

/** Reads just the first line of a file (a rollout's own session_meta). */
function firstLine(path: string): Json | null {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, n).toString('utf8');
    const line = text.split('\n', 1)[0] ?? '';
    const row: unknown = JSON.parse(line);
    return isObject(row) ? row : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** The parent thread a rollout names in its own session_meta, if it is a subagent. */
export function parentOf(meta: Json | null): string | null {
  if (!meta) return null;
  const direct = str(meta['parent_thread_id']);
  if (direct) return direct;
  const source = meta['source'];
  if (isObject(source) && isObject(source['subagent']) && isObject(source['subagent']['thread_spawn'])) {
    return str(source['subagent']['thread_spawn']['parent_thread_id']);
  }
  return null;
}

/**
 * Finds child rollouts by scanning for a session_meta that names one of `parents` (N12). Only rollouts written
 * at or after `since` (with a minute of slack) are opened, and only their first line is read.
 */
export function scanChildren(codexHome: string, parents: ReadonlySet<string>, since: Date): Map<string, string> {
  const found = new Map<string, string>();
  const sessions = join(codexHome, 'sessions');
  const floor = since.getTime() - 60_000;
  const seen = new Set<string>();
  for (const dir of dayDirs(sessions, since)) {
    for (const path of listRollouts(dir)) {
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        if (statSync(path).mtimeMs < floor) continue;
      } catch {
        continue;
      }
      const row = firstLine(path);
      const payload = row && isObject(row['payload']) ? row['payload'] : null;
      if (!row || str(row['type']) !== 'session_meta' || !payload) continue;
      const parent = parentOf(payload);
      const id = str(payload['id']);
      if (parent !== null && id !== null && parents.has(parent)) found.set(id, path);
    }
  }
  return found;
}

export { isObject, num, str };
export type { Json };
