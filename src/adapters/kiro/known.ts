import { createHash } from 'node:crypto';
import type { ModelInfo } from '../../config/registry.js';
import type { EnforcementLabel } from '../types.js';

/*
 * What the kiro adapter declares per tested `kiro-cli` version (plan 4.2, 5.2). Facts measured on 3.2.1,
 * 2026-11-12, with no model turn unless the report says otherwise:
 *   - `kiro-cli acp --help` marks `--agent`, `--model` and `--effort` as "v2 engine only", and the engine falls back
 *     to v3 when no v2-only flag is given. The adapter pins the engine explicitly: `--agent-engine v2` with the three
 *     flags.
 *   - Over ACP the v2 engine reports the agent and model in the older `modes.currentModeId` and
 *     `models.currentModelId` fields (no `configOptions`), honours an isolated `KIRO_HOME` (the agent profile loads
 *     from `$KIRO_HOME/agents`, the session record lands in `$KIRO_HOME/sessions/cli/<session id>.json`, the same id
 *     the ACP session carries), and accepts a profile carrying both the v2 `toolsSettings` and a `permissions`
 *     block.
 *   - The v3 engine over ACP reports `configOptions` `mode` (agent), `autopilot` (default `on`), `memoryReflection`
 *     and `contentCollection` (default `enabled`), and no model option before a turn, so v2 is the engine with a
 *     verifiable pin today.
 */

export type KiroEngine = 'v2' | 'v3';

export interface KiroVersionDecl {
  engine: KiroEngine;
  /** Plan 5.2: `pending` until the promotion canary passes on this version. */
  enforcement: EnforcementLabel;
}

export const KIRO_DECLARED: Readonly<Record<string, KiroVersionDecl>> = {
  '3.2.1': { engine: 'v2', enforcement: 'pending' },
};

export const KIRO_TESTED_VERSIONS = Object.keys(KIRO_DECLARED);
/** Below this, preflight refuses: the acp flags and the record layout above were measured on 3.2.1. */
export const KIRO_FLOOR = '3.2.1';

export function kiroDecl(version: string | null): KiroVersionDecl | null {
  if (version === null) return null;
  return KIRO_DECLARED[version] ?? null;
}

/** The council agent's name, in `$KIRO_HOME/agents/<name>.json`. */
export const KIRO_AGENT = 'sabotage-council';

export const KIRO_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Models that offer no effort levels (an effort is then refused at preflight instead of being dropped silently). */
export const KIRO_NO_EFFORT = ['glm-5', 'deepseek-3.2', 'qwen3-coder-next', 'claude-haiku-4.5'];

/**
 * The model ids a seat names, with families for config validation. The account's own list (preflight, `chat
 * --list-models`) is the binding check. `auto` routes per request and is never a council pin.
 */
export const KIRO_MODELS: readonly ModelInfo[] = [
  { id: 'claude-opus-5.5', family: 'anthropic' },
  { id: 'claude-sonnet-5.5', family: 'anthropic' },
  { id: 'claude-haiku-5.5', family: 'anthropic' },
  { id: 'claude-opus-5', family: 'anthropic' },
  { id: 'claude-sonnet-5', family: 'anthropic' },
  { id: 'claude-opus-4.8', family: 'anthropic' },
  { id: 'claude-opus-4.7', family: 'anthropic' },
  { id: 'claude-opus-4.6', family: 'anthropic' },
  { id: 'claude-sonnet-4.6', family: 'anthropic' },
  { id: 'claude-opus-4.5', family: 'anthropic' },
  { id: 'claude-sonnet-4.5', family: 'anthropic' },
  { id: 'claude-haiku-4.5', family: 'anthropic' },
  { id: 'gpt-5.6-sol', family: 'openai' },
  { id: 'gpt-5.6-terra', family: 'openai' },
  { id: 'gpt-5.6-luna', family: 'openai' },
  { id: 'grok-4.7', family: 'xai' },
  { id: 'deepseek-3.2', family: 'deepseek' },
  { id: 'minimax-m2.5', family: 'minimax' },
  { id: 'minimax-m2.1', family: 'minimax' },
  { id: 'glm-5', family: 'zhipu' },
  { id: 'qwen3-coder-next', family: 'qwen' },
];

/**
 * The council agent profile (v2 shape, measured to load on 3.2.1): read tools only, nothing pre-approved (every
 * tool use becomes a permission request the client answers), shell, write and web denied both by `toolsSettings`
 * and by a `permissions` block, no MCP servers (`includeMcpJson: false`), no resources (so no steering or
 * `AGENTS.md` is added), no hooks.
 */
export function kiroProfile(model: string, overlay?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: KIRO_AGENT,
    description: 'sabotage-council read-only review seat',
    model,
    tools: ['fs_read', 'grep', 'glob'],
    allowedTools: [],
    toolsSettings: {
      execute_bash: { denyByDefault: true },
      fs_write: { deniedPaths: ['**'] },
    },
    permissions: {
      rules: [
        { capability: 'shell', effect: 'deny' },
        { capability: 'fs_write', effect: 'deny' },
        { capability: 'web_fetch', effect: 'deny' },
        { capability: 'web_search', effect: 'deny' },
      ],
    },
    resources: [],
    hooks: {},
    mcpServers: {},
    includeMcpJson: false,
    ...(overlay ?? {}),
  };
}

export function profileText(model: string, overlay?: Record<string, unknown>): string {
  return `${JSON.stringify(kiroProfile(model, overlay), null, 2)}\n`;
}

export function profileHash(model: string): string {
  return createHash('sha256').update(profileText(model)).digest('hex');
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
