import type { KnownToolCall, PermissionDecision } from '../../transport/acp.js';
import { pathInsideRoot, rootAliases } from '../paths.js';

/*
 * The ACP permission policy (plan 4.1): every `session/request_permission` is rejected unless it is a read whose
 * every path realpaths inside the root. The same functions judge the update log at ratification, so a grant the
 * live client got wrong is caught again from the record.
 *
 * A call is judged on everything it was ever reported with: every `tool_call` and `tool_call_update` snapshot, the
 * permission request's own `toolCall`, and the request's `_meta.fsReadPaths`. A path seen once is never erased by
 * a later snapshot.
 */

type Json = Record<string, unknown>;
export const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** ACP tool kinds that read (plan 4.1). Adapters may narrow this; nothing widens it past reads. */
export const ACP_READ_KINDS = ['read', 'search'] as const;

/** What one backend counts as a read: the ACP kinds, and the tool names it declares, read from its own field. */
export interface ReadSet {
  kinds: readonly string[];
  /** The backend's read tools by name. A call with no name, another name or an MCP-shaped name is not a read. */
  names: readonly string[];
  /** Where this backend puts a tool call's name (agy: `name`; kiro: `_meta.kiro.toolName`). */
  nameOf: (snapshot: Json) => string | null;
  /** Read tools that search the cwd (the root) when given no path, as the backend documents (kiro grep, glob). */
  cwdDefault?: readonly string[] | undefined;
  /**
   * A snapshot in which the agent reports its own refusal of the call. Its text is a notice, not tool output
   * (kiro 3.2.1: `_meta.kiro.toolCallFailureReason: "permission_denied"` with "User denied tool execution").
   */
  denialNotice?: ((snapshot: Json) => boolean) | undefined;
}

/** The containers of a tool call that carry its arguments. */
const ARG_CONTAINERS = ['locations', 'rawInput', 'args', 'input'] as const;

/** A key's words: camelCase, snake_case and kebab-case split, lower case (`AbsolutePath` -> absolute, path). */
function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t !== '')
    .map((t) => t.toLowerCase());
}

/**
 * Key coverage (the choice round 1 asked for): a key is path-like when one of its words names a file, a directory
 * or a location (`path`, `file`, `dir`, `directory`, `folder`, `uri`, `url`, `cwd`, `root`, `location`, `target`,
 * `workspace`), or when the whole key is a move or copy endpoint (`src`, `source`, `from`, `to`, `dest`,
 * `destination`, `output`). So `contextPath`, `AbsolutePath`, `TargetFile` and `SearchPath` all count, and free
 * text such as `pattern`, `query` and `__tool_use_purpose` does not.
 */
const PATH_WORDS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'filename',
  'filenames',
  'filepath',
  'filepaths',
  'dir',
  'dirs',
  'directory',
  'directories',
  'folder',
  'folders',
  'uri',
  'uris',
  'url',
  'urls',
  'cwd',
  'root',
  'roots',
  'location',
  'locations',
  'target',
  'targets',
  'workspace',
  'workdir',
]);
const PATH_KEYS = new Set(['src', 'source', 'sources', 'from', 'to', 'dest', 'destination', 'destinations', 'output']);
/** File globs: judged as paths when they are absolute or climb (`/etc/*`, `~/x`, `../**`). */
const GLOB_WORDS = new Set(['glob', 'globs', 'include', 'exclude']);
/** Search patterns: judged as paths only when they climb or name the home directory. */
const PATTERN_WORDS = new Set(['pattern', 'patterns']);

export function isPathKey(key: string): boolean {
  const tokens = keyTokens(key);
  return tokens.some((t) => PATH_WORDS.has(t)) || PATH_KEYS.has(tokens.join(''));
}

/** Decodes a `file:` URI; an agent-controlled value that does not decode is kept as written (never a throw). */
export function decodeFileUri(value: string): string {
  const body = value.replace(/^file:\/\//i, '');
  try {
    return decodeURIComponent(body);
  } catch {
    return body;
  }
}

/** The values of a glob or pattern that leave the root as written: they climb, name home, or (globs) are absolute. */
function escaping(value: string, absoluteToo: boolean): boolean {
  return value.startsWith('~') || /(^|\/)\.\.(\/|$)/.test(value) || (absoluteToo && value.startsWith('/'));
}

export interface CollectedPaths {
  paths: string[];
  /** Path-like keys whose value cannot be judged (an object with no path in it, a number, a boolean). */
  problems: string[];
}

function walk(value: unknown, key: string, pathy: boolean, out: CollectedPaths): boolean {
  const words = keyTokens(key);
  if (typeof value === 'string') {
    if (pathy) {
      if (value.trim() !== '') out.paths.push(value);
      return true;
    }
    if (words.some((w) => GLOB_WORDS.has(w)) && escaping(value, true)) out.paths.push(value);
    else if (words.some((w) => PATTERN_WORDS.has(w)) && escaping(value, false)) out.paths.push(value);
    return false;
  }
  if (Array.isArray(value)) {
    let found = false;
    for (const v of value) found = walk(v, key, pathy, out) || found;
    if (pathy && !found && value.length > 0) out.problems.push(`${key} holds no path the client can judge`);
    return found;
  }
  if (isObject(value)) {
    let found = false;
    for (const [k, v] of Object.entries(value)) found = walk(v, k, isPathKey(k), out) || found;
    if (pathy && !found) out.problems.push(`${key} holds an object with no path in it`);
    return found;
  }
  if (pathy && value !== null && value !== undefined) out.problems.push(`${key} holds a ${typeof value}, not a path`);
  return false;
}

/**
 * Every path a set of tool-call snapshots names, to any depth of their arguments (`locations`, `rawInput`, `args`,
 * `input`): arrays and objects are recursed, so kiro's `rawInput.operations[].path` counts. `extra` adds paths
 * the permission request names elsewhere (`_meta.fsReadPaths`).
 */
export function collectPaths(snapshots: readonly Json[], extra: readonly string[] = []): CollectedPaths {
  const out: CollectedPaths = { paths: [], problems: [] };
  for (const s of snapshots) {
    for (const container of ARG_CONTAINERS) {
      if (s[container] !== undefined) walk(s[container], container, container === 'locations', out);
    }
  }
  for (const p of extra) if (p.trim() !== '') out.paths.push(p);
  return { paths: [...new Set(out.paths)], problems: [...new Set(out.problems)] };
}

/** One snapshot's paths (tests and the canary harness). */
export function toolCallPaths(toolCall: Json): string[] {
  return collectPaths([toolCall]).paths;
}

export interface ReadJudgement {
  /** A declared read tool, by every kind and name it was reported with. */
  read: boolean;
  /** Every path can be judged (none is an object or a non-string, and there is at least one). */
  judgeable: boolean;
  inside: boolean;
  paths: string[];
  names: string[];
  why: string;
}

const MCP_SHAPED = /^mcp|__|[/:.@]/i;

/** The kinds and names a call was reported with, over every snapshot. */
export function identity(snapshots: readonly Json[], set: ReadSet): { kinds: string[]; names: string[] } {
  const kinds = [...new Set(snapshots.map((s) => str(s['kind'])).filter((k): k is string => k !== null))];
  const names = [...new Set(snapshots.map((s) => set.nameOf(s)).filter((n): n is string => n !== null))];
  return { kinds, names };
}

/** Judges one path value: a non-`file:` URL is outside; anything else by `pathInsideRoot`, `$` taken literally. */
export function judgePath(value: string, root: string, aliases: readonly string[]): { inside: boolean; why: string } {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1];
  if (scheme !== undefined && scheme.toLowerCase() !== 'file') return { inside: false, why: `names a ${scheme} URL` };
  const path = scheme !== undefined ? decodeFileUri(value) : value;
  const j = pathInsideRoot(path, root, aliases, { literalDollar: true });
  return { inside: j.inside, why: j.why };
}

/**
 * Judges a call as the client must: every kind a read kind, a declared read-tool name (and no other name), and every
 * path inside the root by realpath. A read with no path is judged at the root only for a tool that documents the
 * cwd as its default; any other path-less read, or one with an unjudgeable value, is not judgeable.
 */
export function judgeCall(snapshots: readonly Json[], extra: readonly string[], root: string, set: ReadSet, aliases = rootAliases(root)): ReadJudgement {
  const { kinds, names } = identity(snapshots, set);
  const base = { judgeable: false, inside: false, paths: [] as string[], names };
  const notRead = (why: string): ReadJudgement => ({ ...base, read: false, why });
  if (kinds.length === 0) return notRead('no kind is reported');
  const badKinds = kinds.filter((k) => !set.kinds.includes(k));
  if (badKinds.length > 0) return notRead(`kind ${badKinds.join(', ')} is not a read`);
  if (names.length === 0) return notRead('no tool name is reported');
  const mcp = names.filter((n) => MCP_SHAPED.test(n));
  if (mcp.length > 0) return notRead(`an MCP-shaped tool name (${mcp.join(', ')})`);
  const undeclared = names.filter((n) => !set.names.includes(n));
  if (undeclared.length > 0) return notRead(`tool ${undeclared.join(', ')} is not a declared read (${set.names.join(', ')})`);
  const collected = collectPaths(snapshots, extra);
  if (collected.problems.length > 0) return { ...base, read: true, paths: collected.paths, why: `cannot judge: ${collected.problems.join('; ')}` };
  let paths = collected.paths;
  if (paths.length === 0) {
    if (!names.every((n) => (set.cwdDefault ?? []).includes(n))) return { ...base, read: true, why: 'a read that names no path the client can judge' };
    paths = ['.'];
  }
  for (const p of paths) {
    const j = judgePath(p, root, aliases);
    if (!j.inside) return { ...base, read: true, judgeable: true, paths, why: `${p} ${j.why}` };
  }
  return { read: true, judgeable: true, inside: true, paths, names, why: `a read inside the root (${paths.join(', ')})` };
}

/** The `_meta.fsReadPaths` a permission request names (kiro). */
export function requestPaths(params: Json): string[] {
  const meta = params['_meta'];
  const list = isObject(meta) ? meta['fsReadPaths'] : undefined;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : [];
}

/** The live policy the transport calls for each `session/request_permission`. */
export function readOnlyPolicy(root: string, set: ReadSet): (params: Json, known: (toolCallId: string) => KnownToolCall | undefined) => PermissionDecision {
  const aliases = rootAliases(root);
  return (params, known) => {
    const requested = isObject(params['toolCall']) ? params['toolCall'] : {};
    const id = str(requested['toolCallId']);
    const prior = id !== null ? known(id) : undefined;
    const j = judgeCall([...(prior?.snapshots ?? []), requested], requestPaths(params), root, set, aliases);
    return { allow: j.read && j.judgeable && j.inside, why: j.why };
  };
}
