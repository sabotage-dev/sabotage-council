import type { KnownToolCall, PermissionDecision } from '../../transport/acp.js';
import { pathInsideRoot, rootAliases } from '../paths.js';

/*
 * The ACP permission policy (plan 4.1): every `session/request_permission` is rejected unless it is a read whose
 * every path realpaths inside the root. The same functions judge the update log at ratification, so a grant the
 * live client got wrong is caught again from the record.
 */

type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** ACP tool kinds that read (plan 4.1). Adapters may narrow this; nothing widens it past reads. */
export const ACP_READ_KINDS = ['read', 'search'] as const;

/**
 * Keys of a tool call's `rawInput` that name files or directories. Matched case-insensitively against the key,
 * so `path`, `file_path`, `AbsolutePath`, `SearchPath`, `DirectoryPath`, `TargetFile` and `uri` all count. Keys that
 * hold a search string (`query`, `pattern`, `regex`) are not paths: a grep for "/api/v1" names no file.
 */
const PATH_KEY = /path|file|dir|uri|cwd|root|location|target/i;
const NOT_PATH_KEY = /pattern|query|regex|content|text|include|exclude|glob/i;
/** File globs: judged as paths when they are absolute or climb (`/etc/*`, `~/x`, `../**`). */
const GLOB_KEY = /glob|include|exclude/i;
/** Search patterns: judged as paths only when they climb or name the home directory. */
const PATTERN_KEY = /pattern/i;

function pathValues(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.trim() !== '') out.push(value.startsWith('file://') ? decodeURIComponent(value.slice('file://'.length)) : value);
  } else if (Array.isArray(value)) {
    for (const v of value) pathValues(v, out);
  }
}

/** The values of a glob or pattern that leave the root as written: they climb, name home, or (globs) are absolute. */
function escaping(value: unknown, absoluteToo: boolean): string[] {
  const all: string[] = [];
  pathValues(value, all);
  return all.filter((v) => v.startsWith('~') || /(^|\/)\.\.(\/|$)/.test(v) || (absoluteToo && v.startsWith('/')));
}

/**
 * Every path a tool call names: each `locations[].path`, and each string (or list of strings) under a path-like
 * key of `rawInput`, one level of nesting deep.
 */
export function toolCallPaths(toolCall: Json): string[] {
  const out: string[] = [];
  const locations = toolCall['locations'];
  if (Array.isArray(locations)) {
    for (const l of locations) if (isObject(l)) pathValues(l['path'], out);
  }
  const visit = (input: unknown, depth: number): void => {
    if (!isObject(input)) return;
    for (const [key, value] of Object.entries(input)) {
      if (PATH_KEY.test(key) && !NOT_PATH_KEY.test(key)) pathValues(value, out);
      else if (GLOB_KEY.test(key)) pathValues(escaping(value, true), out);
      else if (PATTERN_KEY.test(key)) pathValues(escaping(value, false), out);
      else if (depth === 0 && isObject(value)) visit(value, 1);
    }
  };
  // `rawInput` is the ACP field; agy also sends the tool's own `args`.
  visit(toolCall['rawInput'], 0);
  visit(toolCall['args'], 0);
  visit(toolCall['input'], 0);
  return [...new Set(out)];
}

/** The tool call as known so far: the fields of earlier `tool_call` updates, overlaid by the request's own. */
export function mergeToolCall(known: Json | undefined, requested: Json): Json {
  const out: Json = { ...(known ?? {}) };
  for (const [k, v] of Object.entries(requested)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

export interface ReadJudgement {
  read: boolean;
  inside: boolean;
  paths: string[];
  why: string;
}

/**
 * Judges one tool call as the client must: a read kind, at least one path, and every path inside the root by
 * realpath (a symlink that leaves the root is outside). `kinds` lists every kind the call was ever reported with,
 * so a call that changed kind mid-stream is judged by all of them.
 */
export function judgeRead(toolCall: Json, kinds: readonly string[], root: string, readKinds: readonly string[], aliases = rootAliases(root)): ReadJudgement {
  const seen = kinds.length > 0 ? kinds : [str(toolCall['kind']) ?? '(none)'];
  const notRead = seen.filter((k) => !readKinds.includes(k));
  const paths = toolCallPaths(toolCall);
  if (notRead.length > 0) return { read: false, inside: false, paths, why: `kind ${notRead.join(', ')} is not a read` };
  if (paths.length === 0) return { read: true, inside: false, paths, why: 'a read that names no path the client can judge' };
  for (const p of paths) {
    const j = pathInsideRoot(p, root, aliases);
    if (!j.inside) return { read: true, inside: false, paths, why: `${p} ${j.why}` };
  }
  return { read: true, inside: true, paths, why: `a read inside the root (${paths.join(', ')})` };
}

/** The live policy the transport calls for each `session/request_permission`. */
export function readOnlyPolicy(
  root: string,
  readKinds: readonly string[],
): (params: Json, known: (toolCallId: string) => KnownToolCall | undefined) => PermissionDecision {
  const aliases = rootAliases(root);
  return (params, known) => {
    const requested = isObject(params['toolCall']) ? params['toolCall'] : {};
    const id = str(requested['toolCallId']);
    const prior = id !== null ? known(id) : undefined;
    const merged = mergeToolCall(prior?.fields, requested);
    const kinds = [...new Set([...(prior?.kinds ?? []), ...(str(requested['kind']) !== null ? [String(requested['kind'])] : [])])];
    const j = judgeRead(merged, kinds, root, readKinds, aliases);
    return { allow: j.read && j.inside, why: j.why };
  };
}
