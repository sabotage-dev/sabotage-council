import { existsSync } from 'node:fs';
import { sqlite } from '../../store/sqlite.js';
import { isObject, num, str } from '../acp/policy.js';

/*
 * The opencode leg's session record (plan 4.2), opencode 2.2.7: SQLite at the leg's own `OPENCODE_DB`.
 *   - `session_v2`: one row per session (`directory`, `version`, `agent`, `model` JSON, `idle_outcome`, `cost`,
 *     `tokens_*`, `parent_id` for a child session);
 *   - `session_message`: each step as JSON `data` by `type` (`assistant` carries `agent`, `model {providerID, id,
 *     variant}`, `content[]` with tool parts `{type: tool, name, state {status, input, error}}`, `tokens`, `cost`,
 *     `error`; `idle` carries the turn `outcome`; `shell` and `skill` are user-invoked shells and skills);
 *   - `session_part`: assistant content parts by message (`type`, `call_id`, `data`);
 *   - `instruction_entry`: the instructions the session injected.
 * On ACP sessions the session row's agent and model can be null; the per-message fields are the proof.
 */

type Json = Record<string, unknown>;

export interface OpencodeTool {
  name: string;
  status: string | null;
  input: Json;
  error: string | null;
  source: 'message' | 'part';
}

export interface OpencodeRecord {
  path: string;
  problem: string | null;
  session: Json | null;
  /** Sessions with no parent in the database (one leg = one). */
  rootSessions: number;
  /** Child sessions of the leg's session (subagents). */
  children: string[];
  messages: Array<{ type: string; seq: number; data: Json }>;
  assistants: Json[];
  tools: OpencodeTool[];
  instructions: Array<{ key: string; value: unknown; removed: boolean }>;
}

const parse = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
};

function errorText(e: unknown): string | null {
  if (typeof e === 'string') return e;
  if (isObject(e)) return str(e['message']) ?? str(e['type']) ?? JSON.stringify(e);
  return null;
}

function toolOf(v: unknown, source: OpencodeTool['source']): OpencodeTool | null {
  if (!isObject(v) || str(v['type']) !== 'tool') return null;
  const state = isObject(v['state']) ? v['state'] : {};
  return {
    name: str(v['name']) ?? str(v['tool']) ?? '',
    status: str(state['status']),
    input: isObject(state['input']) ? state['input'] : {},
    error: errorText(state['error']),
    source,
  };
}

export function readOpencodeRecord(path: string, sessionId: string | null): OpencodeRecord {
  const rec: OpencodeRecord = { path, problem: null, session: null, rootSessions: 0, children: [], messages: [], assistants: [], tools: [], instructions: [] };
  if (!existsSync(path)) {
    rec.problem = 'no database';
    return rec;
  }
  let db: InstanceType<ReturnType<typeof sqlite>['DatabaseSync']> | null = null;
  try {
    db = new (sqlite().DatabaseSync)(path, { readOnly: true });
    const all = (sql: string, ...params: Array<string | number>) => db?.prepare(sql).all(...params) as Json[];
    rec.rootSessions = Number((all('SELECT count(*) AS n FROM session_v2 WHERE parent_id IS NULL')[0] ?? {})['n'] ?? 0);
    if (sessionId === null) return rec;
    const row = all('SELECT * FROM session_v2 WHERE id = ?', sessionId)[0];
    if (row === undefined) return rec;
    rec.session = { ...row, model: parse(row['model']) };
    rec.children = all('SELECT id FROM session_v2 WHERE parent_id = ?', sessionId).map((r) => String(r['id']));
    for (const m of all('SELECT type, seq, data FROM session_message WHERE session_id = ? ORDER BY seq', sessionId)) {
      const data = parse(m['data']);
      const msg = { type: String(m['type']), seq: Number(m['seq']), data: isObject(data) ? data : {} };
      rec.messages.push(msg);
      if (msg.type === 'assistant') {
        rec.assistants.push(msg.data);
        for (const c of Array.isArray(msg.data['content']) ? msg.data['content'] : []) {
          const t = toolOf(c, 'message');
          if (t) rec.tools.push(t);
        }
      }
    }
    for (const p of all("SELECT data FROM session_part WHERE session_id = ? AND type = 'tool' ORDER BY message_id, ordinal", sessionId)) {
      const t = toolOf(parse(p['data']), 'part');
      if (t) rec.tools.push(t);
    }
    rec.instructions = all('SELECT key, value, removed FROM instruction_entry WHERE session_id = ?', sessionId).map((r) => ({ key: String(r['key']), value: parse(r['value']), removed: Boolean(r['removed']) }));
  } catch (error) {
    rec.problem = `database unreadable: ${error instanceof Error ? error.message.split('\n')[0] : 'error'}`;
  } finally {
    db?.close();
  }
  return rec;
}

/** The model ref of a record value: `{providerID, id, variant?}`. */
export function modelRef(v: unknown): { providerID: string | null; id: string | null; variant: string | null } {
  if (!isObject(v)) return { providerID: null, id: null, variant: null };
  return { providerID: str(v['providerID']), id: str(v['id']), variant: str(v['variant']) };
}

export { num };
