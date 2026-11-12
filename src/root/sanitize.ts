import { mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { lstatOrNull, walk } from './walk.js';

/** Where whole agent-config directories are moved, under the root (plan 6.2). */
export const AGENT_CONFIG_QUARANTINE = '_repo-agent-config';
/** The suffix that marks a renamed agent-config file as data (plan 6.2). */
export const COUNCIL_DATA_SUFFIX = '.council-data';

/**
 * Agent-config directories that CLIs load automatically (plan 6.2). Each moves whole to
 * `_repo-agent-config/<original path>`. Matched case-insensitively, at every depth.
 * Exported as data: later phases and `doctor --deep` build their canary roots from it.
 */
export const AGENT_CONFIG_DIRS: readonly string[] = [
  '.claude',
  '.cursor',
  '.kiro',
  '.agents',
  '.opencode',
  '.gemini',
  '.muse',
  '.codex',
  '.grok',
];

/**
 * Agent-config files (plan 6.2): instruction files and MCP or editor configs. Each is renamed with the
 * `.council-data` suffix. `*` matches any run of characters. Matched case-insensitively, at every depth.
 */
export const AGENT_CONFIG_FILES: readonly string[] = [
  'AGENTS*.md',
  'CLAUDE.md',
  'GEMINI.md',
  'MEMORY.md',
  '.mcp.json',
  'opencode.json',
  'opencode.jsonc',
  '.cursorrules',
  '.cursorignore',
];

function globRegex(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}$`, 'i');
}

const FILE_PATTERNS = AGENT_CONFIG_FILES.map((glob) => ({ glob, re: globRegex(glob) }));

/** The AGENT_CONFIG_DIRS entry a name matches, or null. */
export function agentConfigDir(name: string): string | null {
  return AGENT_CONFIG_DIRS.find((d) => d.toLowerCase() === name.toLowerCase()) ?? null;
}

/** The AGENT_CONFIG_FILES pattern a name matches, or null. */
export function agentConfigFile(name: string): string | null {
  return FILE_PATTERNS.find((p) => p.re.test(name))?.glob ?? null;
}

export interface SanitizedEntry {
  /** Root-relative path before the sanitizer ran. */
  from: string;
  /** Root-relative path after. */
  to: string;
  kind: 'dir' | 'file';
  /** The AGENT_CONFIG_DIRS or AGENT_CONFIG_FILES entry that matched. */
  rule: string;
}

function basename(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

/** `<path>.council-data`, or `<path>.<n>.council-data` when that name is taken; always ends in the suffix. */
function dataName(root: string, rel: string): string {
  let candidate = `${rel}${COUNCIL_DATA_SUFFIX}`;
  for (let n = 2; lstatOrNull(join(root, candidate)) !== null; n++) candidate = `${rel}.${n}${COUNCIL_DATA_SUFFIX}`;
  return candidate;
}

function renameFiles(root: string, start: string, originOf: (rel: string) => string, out: SanitizedEntry[]): void {
  const renames: { rel: string; rule: string }[] = [];
  const stats = lstatOrNull(join(root, start));
  if (stats === null || !stats.isDirectory()) return;
  for (const entry of walk(root, start)) {
    if (entry.kind === 'dir') continue;
    const rule = agentConfigFile(basename(entry.rel));
    if (rule !== null) renames.push({ rel: entry.rel, rule });
  }
  for (const { rel, rule } of renames) {
    const to = dataName(root, rel);
    renameSync(join(root, rel), join(root, to));
    out.push({ from: originOf(rel), to, kind: 'file', rule });
  }
}

/**
 * The root sanitizer (plan 6.2). Runs recursively over the given trees (`<repo>/`, `_base/`, `context/`):
 * - an entry named like an agent-config directory moves whole to `_repo-agent-config/<original path>` (a link
 *   with that name moves too, since a CLI would follow it);
 * - a file or link named like an agent-config file gets the `.council-data` suffix, including inside the moved
 *   directories.
 * Names are matched case-insensitively. Returns every move and rename.
 */
export function sanitizeTrees(root: string, trees: readonly string[]): SanitizedEntry[] {
  const out: SanitizedEntry[] = [];
  const dirMoves: { rel: string; rule: string; isDir: boolean }[] = [];
  for (const tree of trees) {
    const stats = lstatOrNull(join(root, tree));
    if (stats === null || !stats.isDirectory()) continue;
    walk(root, tree, (entry) => {
      const rule = agentConfigDir(basename(entry.rel));
      return rule === null; // never descend into a directory that moves whole
    }).forEach((entry) => {
      const rule = agentConfigDir(basename(entry.rel));
      if (rule !== null) dirMoves.push({ rel: entry.rel, rule, isDir: entry.kind === 'dir' });
    });
  }
  // Entries inside a moving directory were not visited, so no move is nested in another.
  for (const move of dirMoves) {
    const to = `${AGENT_CONFIG_QUARANTINE}/${move.rel}`;
    mkdirSync(dirname(join(root, to)), { recursive: true });
    renameSync(join(root, move.rel), join(root, to));
    out.push({ from: move.rel, to, kind: 'dir', rule: move.rule });
    if (move.isDir) renameFiles(root, to, (rel) => `${move.rel}${rel.slice(to.length)}`, out);
  }
  for (const tree of trees) renameFiles(root, tree, (rel) => rel, out);
  return out;
}

/** Maps a pre-sanitizer root-relative path to where the sanitizer put it. */
export function sanitizedPathMap(entries: readonly SanitizedEntry[]): (path: string) => string {
  const files = new Map<string, string>();
  const dirs: SanitizedEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'file') files.set(e.from, e.to);
    else dirs.push(e);
  }
  return (path) => {
    const file = files.get(path);
    if (file !== undefined) return file;
    const dir = dirs.find((d) => path === d.from || path.startsWith(`${d.from}/`));
    return dir === undefined ? path : `${dir.to}${path.slice(dir.from.length)}`;
  };
}
