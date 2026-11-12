import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isObject, num, str } from '../acp/policy.js';

/*
 * The kiro leg's session record (plan 4.2), v2 engine on 3.2.1: `$KIRO_HOME/sessions/cli/<session id>.json`, the
 * same id as the ACP session. Read fields: `session_id`, `cwd`, `session_state.agent_name`,
 * `session_state.rts_model_state.model_info.model_id`, each `user_turn_metadatas[].model` and `metering_usage[]`
 * (credits), the effort override, and the session's filesystem permissions. The record lives under the leg's own
 * `KIRO_HOME`, never the user's `~/.kiro`.
 */

type Json = Record<string, unknown>;

export interface KiroRecord {
  path: string | null;
  /** Every `.json` under `sessions/cli` (one leg = one session). */
  count: number;
  sessionId: string | null;
  cwd: string | null;
  agent: string | null;
  modelInfo: string | null;
  turnModels: Array<string | null>;
  effort: string | null;
  credits: number | null;
  turns: number;
  trustedTools: string[];
  allowedWritePaths: string[];
  durationMs: number | null;
  malformed: boolean;
}

function get(o: unknown, ...keys: string[]): unknown {
  let cur = o;
  for (const k of keys) {
    if (!isObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

/** The effort override, wherever this version keeps it. */
function effortOf(state: Json): string | null {
  const paths = [
    ['rts_model_state', 'additional_fields', 'overrides', 'output_config', 'effort'],
    ['rts_model_state', 'overrides', 'output_config', 'effort'],
    ['rts_model_state', 'model_info', 'additional_fields', 'overrides', 'output_config', 'effort'],
  ];
  for (const p of paths) {
    const v = str(get(state, ...p));
    if (v !== null) return v;
  }
  return null;
}

export function readKiroRecord(kiroHome: string, sessionId: string | null): KiroRecord {
  const dir = join(kiroHome, 'sessions', 'cli');
  const files = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')) : [];
  const record: KiroRecord = {
    path: null,
    count: files.length,
    sessionId: null,
    cwd: null,
    agent: null,
    modelInfo: null,
    turnModels: [],
    effort: null,
    credits: null,
    turns: 0,
    trustedTools: [],
    allowedWritePaths: [],
    durationMs: null,
    malformed: false,
  };
  const name = sessionId !== null && files.includes(`${sessionId}.json`) ? `${sessionId}.json` : null;
  if (name === null) return record;
  record.path = join(dir, name);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(record.path, 'utf8'));
  } catch {
    record.malformed = true;
    return record;
  }
  if (!isObject(raw)) {
    record.malformed = true;
    return record;
  }
  record.sessionId = str(raw['session_id']);
  record.cwd = str(raw['cwd']);
  const state = isObject(raw['session_state']) ? raw['session_state'] : {};
  record.agent = str(state['agent_name']);
  record.modelInfo = str(get(state, 'rts_model_state', 'model_info', 'model_id'));
  record.effort = effortOf(state);
  const turns = get(state, 'conversation_metadata', 'user_turn_metadatas');
  let credits = 0;
  let metered = false;
  let duration = 0;
  if (Array.isArray(turns)) {
    record.turns = turns.length;
    for (const t of turns) {
      if (!isObject(t)) continue;
      record.turnModels.push(str(t['model']));
      const usage = t['metering_usage'];
      if (Array.isArray(usage)) {
        for (const u of usage) {
          const v = isObject(u) ? num(u['value']) : null;
          if (v !== null) {
            credits += v;
            metered = true;
          }
        }
      }
      const d = t['turn_duration'];
      if (isObject(d)) duration += (num(d['secs']) ?? 0) * 1000 + Math.round((num(d['nanos']) ?? 0) / 1e6);
    }
  }
  record.credits = metered ? Math.round(credits * 10_000) / 10_000 : null;
  record.durationMs = duration > 0 ? duration : null;
  const perms = isObject(state['permissions']) ? state['permissions'] : {};
  record.trustedTools = Array.isArray(perms['trusted_tools']) ? perms['trusted_tools'].map(String) : [];
  const fsPerms = get(perms, 'filesystem', 'allowed_write_paths');
  record.allowedWritePaths = Array.isArray(fsPerms) ? fsPerms.map(String) : [];
  return record;
}
