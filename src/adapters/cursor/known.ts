import type { EnforcementLabel } from '../types.js';

/*
 * What the cursor adapter declares (plan 4.2, 5.2). Built from Cursor's CLI documentation and changelog only:
 * owner ruling D14 allows no Cursor live run in v1, so no version is tested, every leg is `weak`, and `doctor`
 * refuses Cursor seats for `auto`. The facts the adapter relies on, each still to be measured by a canary:
 *   - the installer unpacks each release to `~/.local/share/cursor-agent/versions/<YYYY.MM.DD-sha7>/cursor-agent` and
 *     repoints `~/.local/bin/agent`, a name other CLIs use, so the adapter calls the versioned binary by path;
 *   - headless print mode (`-p --output-format stream-json`) needs `--trust`, which also enables project hooks, so
 *     the root must be sanitized first; `--mode ask` is the read-only mode; `--sandbox enabled` sandboxes shell;
 *   - `CURSOR_CONFIG_DIR` relocates the CLI config (`cli-config.json`: approval mode, permissions, sandbox and its
 *     read boundary); hooks (`hooks.json`) can deny a tool before it runs and receive `model_id`,
 *     `model_params` (effort) and `workspace_roots`; `system/init.model` is a display name only;
 *   - Cursor imports Claude Code hooks from `~/.claude/settings.json` by default.
 */

export const CURSOR_DECLARED: Readonly<Record<string, { enforcement: EnforcementLabel }>> = {};
export const CURSOR_TESTED_VERSIONS = Object.keys(CURSOR_DECLARED);
/** Grep and Glob honour the read boundary from this release on (changelog); older builds are refused. */
export const CURSOR_FLOOR = '2026.10.15';
/** Weakest enforcement of the eight (plan 4.2), and below `strong` in v1 whatever a canary shows (plan 10). */
export const CURSOR_LABEL: EnforcementLabel = 'weak';

/** A Cursor CLI version: `YYYY.MM.DD-<sha7>`. */
export function parseCursorVersion(text: string): string | null {
  return /\b(\d{4}\.\d{2}\.\d{2})-[0-9a-f]{7}\b/.exec(text)?.[1] ?? null;
}

export function compareCursorVersions(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stream `tool_call` kinds that read (the stream names each call by its kind key). */
export const CURSOR_READ_CALLS = ['readToolCall', 'grepToolCall', 'globToolCall', 'lsToolCall'] as const;
/** Hook `tool_name`s the council hook lets through: reads only. */
export const CURSOR_READ_TOOLS = ['read', 'read_file', 'grep', 'glob', 'ls', 'list_dir', 'file_search'] as const;

/** Permissions in the council-owned `cli-config.json` (deny wins over allow). */
export const CURSOR_PERMISSIONS = {
  allow: ['Read(**)'],
  deny: ['Write(**)', 'Write(/**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)'],
} as const;

/** Flags a leg never passes. */
export const CURSOR_FORBIDDEN_FLAGS = ['-f', '--force', '--yolo', '--approve-mcps'] as const;
