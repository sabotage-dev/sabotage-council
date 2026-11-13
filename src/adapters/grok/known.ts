import type { ModelInfo } from '../../config/registry.js';
import type { EnforcementLabel } from '../types.js';

/*
 * What the grok adapter declares per tested CLI version (plan 4.2, 5.2). Facts measured on grok 1.0.70 (the
 * shell route, stable channel), 2026-11-12:
 *   - `--tools read_file,grep,list_dir` leaves exactly those three in `tool_definitions.json` and in the stream's
 *     `system/init.tools`. A `--disallowed-tools` list of names from the other internal route is silently a no-op,
 *     so the allowlist is the enforcement and the offer is ratified on every leg.
 *   - `--sandbox read-only` and `strict` refuse to start (exit 1 in about 0.1 s) on a Mac whose
 *     `/var/run/docker.sock` is a symlink to a path outside the sandbox's deny list (Docker Desktop).
 *   - MCP servers in `$GROK_HOME/config.toml` start under the allowlist and the `MCPTool` deny rule; the deny gates
 *     their use, not their start. Owner ruling: a leg that starts an MCP server fails.
 *   - With `HOME` isolated (and `GROK_HOME` pointing at the user's grok home for its login), `grok inspect --json`
 *     lists no Claude-compat instructions, hooks, plugins or permission rules, and planted project files in an
 *     untrusted root (`AGENTS.md`, a `.claude` hook) were not loaded by a live leg.
 *   - The served model id is the requested id with `-build` (`grok-4.7` is served as `grok-4.7-build`).
 *   - No `--sandbox read-only` leg is recorded: on the measuring Mac the sandbox refuses to start (above), so every
 *     recorded leg ran `--sandbox off`. The `pending` label for a sandbox-on leg with no MCP server is N1's
 *     placeholder, not a measured result.
 */

/** The only tools a grok seat may be offered or use (plan 4.2). */
export const GROK_READ_TOOLS = ['read_file', 'grep', 'list_dir'] as const;

/**
 * The `--disallowed-tools` list of the working leg command (shell-route and daemon-route names). The allowlist is
 * what enforces; this list only narrows further and costs nothing when a name does not exist.
 */
export const GROK_DISALLOWED_TOOLS = [
  'run_terminal_cmd',
  'run_terminal_command',
  'search_replace',
  'write',
  'task',
  'spawn_subagent',
  'web_fetch',
  'search_tool',
  'use_tool',
  'workflow',
  'monitor',
  'scheduler_create',
  'image_gen',
  'image_edit',
  'Agent',
] as const;

/** Permission deny rules every leg passes (`--deny`). Deny wins over any allow rule, whatever its source. */
export const GROK_DENY_RULES = ['Bash', 'Edit', 'Write', 'MCPTool', 'WebFetch'] as const;

/** Headless switches every leg passes. */
export const GROK_SWITCHES = [
  '--disable-web-search',
  '--no-subagents',
  '--no-plan',
  '--no-memory',
  '--no-auto-update',
  '--no-wait-for-background',
] as const;

export type GrokSandbox = 'read-only' | 'off';

export interface GrokVersionDecl {
  /**
   * The label with the OS sandbox running and no MCP server started (N1): `pending` until a configuration proves
   * reads cannot leave the root before execution. `--sandbox off`, or a started user MCP server, is always `weak`.
   */
  sandboxed: EnforcementLabel;
}

export const GROK_DECLARED: Readonly<Record<string, GrokVersionDecl>> = {
  '1.0.70': { sandboxed: 'pending' },
};

export const GROK_TESTED_VERSIONS = Object.keys(GROK_DECLARED);
/** Below this, preflight refuses: the flags and the record layout above were measured on 1.0.70. */
export const GROK_FLOOR = '1.0.70';

export function grokDecl(version: string | null): GrokVersionDecl | null {
  if (version === null) return null;
  return GROK_DECLARED[version] ?? null;
}

/**
 * The enforcement label of a grok leg (plan 5.2, N1): `weak` with `--sandbox off` or with an MCP server started,
 * else the declared label for the version (`pending` on 1.0.70); an undeclared version is `weak`. Never `strong`:
 * the read audit at ratification is detection, not a pre-execution boundary.
 */
export function grokLabel(version: string | null, sandbox: GrokSandbox | null, mcpStarted: boolean): EnforcementLabel {
  const decl = grokDecl(version);
  if (decl === null || sandbox !== 'read-only' || mcpStarted) return 'weak';
  return decl.sandboxed;
}

/** Canonical effort levels (a model accepts only its own menu, read from `models_cache.json`). */
export const GROK_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Model ids a seat names, with families for config validation. `grok models` is the binding list. */
export const GROK_MODELS: readonly ModelInfo[] = [
  { id: 'grok-4.7', family: 'xai' },
  { id: 'grok-4.7-build-fast', family: 'xai' },
  { id: 'grok-4.6', family: 'xai' },
  { id: 'grok-4.5', family: 'xai' },
];

/**
 * A served model id matches the pin when it is the pin or the pin with `-build` (measured on 1.0.70). A pin of
 * `grok-4.7` never matches `grok-4.7-build-fast` (twice the price): the fast model must be pinned by name.
 */
export function grokModelMatches(observed: string, pin: string): boolean {
  return observed === pin || observed === `${pin}-build`;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n));
  const pb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
