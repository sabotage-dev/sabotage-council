import type { ModelInfo } from '../../config/registry.js';
import type { EnforcementLabel } from '../types.js';

/*
 * What the opencode adapter declares per tested CLI version (plan 4.2, 5.2). Facts from opencode 2.2.7
 * (`@opencode/cli`, MIT), its source at the v2.2.7 tag, and no-model runs on 2026-11-12:
 *   - `opencode acp` speaks ACP; `session/new` reports config options `model` (`provider/model`), `mode` (the
 *     agent) and, only for a model with variants, `effort` (category `thought_level`). Setting `effort` on a model
 *     without variants is refused ("effort not found"), so a seat cannot silently lose its effort.
 *   - The council agent arrives in `OPENCODE_CONFIG_CONTENT`; with `default_agent: council` the session starts in
 *     mode `council`, and `debug agents` shows its effective rules (opencode prepends its own defaults; the last
 *     matching rule wins, so the council's deny-all and read allows decide).
 *   - Each leg runs on its own XDG dirs and `OPENCODE_DB`, so no shared service or saved account reaches it:
 *     credentials come from provider environment variables only (or the free `opencode/*` models, which need none).
 *   - Tool calls over ACP carry `name` (`read`, `glob`, `grep`, ...), `kind`, `rawInput` and `locations`; a call
 *     the agent's own rules block ends `failed` with `rawOutput.error` `Permission denied: <action>`.
 *   - The session record is SQLite: `session_v2` (directory, version, agent, model, idle outcome, totals) and
 *     `session_message` (each assistant step's agent, model `{providerID, id, variant}`, tokens, cost, content).
 */

export interface OpencodeVersionDecl {
  /** Plan 5.2: `pending` until the promotion canary passes on this version. */
  enforcement: EnforcementLabel;
}

export const OPENCODE_DECLARED: Readonly<Record<string, OpencodeVersionDecl>> = {
  '2.2.7': { enforcement: 'pending' },
};

export const OPENCODE_TESTED_VERSIONS = Object.keys(OPENCODE_DECLARED);
/** Below this, preflight refuses: the ACP options, config shape and record layout above are 2.2.7's. */
export const OPENCODE_FLOOR = '2.2.7';

export function opencodeDecl(version: string | null): OpencodeVersionDecl | null {
  if (version === null) return null;
  return OPENCODE_DECLARED[version] ?? null;
}

/** The council agent's id (the ACP session mode). */
export const OPENCODE_AGENT = 'council';

/** The read tools, by their opencode names. */
export const OPENCODE_READ_TOOLS = ['read', 'glob', 'grep'] as const;

/** Actions the council agent must have denied (checked on the effective rules at preflight). */
export const OPENCODE_DENIED_ACTIONS = ['shell', 'edit', 'write', 'patch', 'webfetch', 'websearch', 'execute', 'subagent', 'skill', 'external_directory', 'question', 'browser', 'context7_get_library_docs'] as const;

const SYSTEM =
  'You are a read-only code reviewer for a council review. You may only read, glob and grep files inside the working directory. Never write, run commands, fetch URLs or use skills.';

/**
 * The council config, passed whole in `OPENCODE_CONFIG_CONTENT`: one agent whose rules deny everything but
 * read/glob/grep (and deny `skill` and `external_directory` by name), plus binary policies that tighten after any
 * rule or saved approval, no snapshots, no update checks, no cache warming.
 */
export function opencodeConfig(overlay?: Record<string, unknown>): Record<string, unknown> {
  return {
    agents: {
      [OPENCODE_AGENT]: {
        mode: 'primary',
        system: SYSTEM,
        steps: 60,
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'read', resource: '*', effect: 'allow' },
          { action: 'glob', resource: '*', effect: 'allow' },
          { action: 'grep', resource: '*', effect: 'allow' },
          { action: 'skill', resource: '*', effect: 'deny' },
          { action: 'external_directory', resource: '*', effect: 'deny' },
        ],
      },
    },
    default_agent: OPENCODE_AGENT,
    policies: [
      { action: 'tool.use', resource: 'shell:*', effect: 'deny' },
      { action: 'tool.use', resource: 'edit:*', effect: 'deny' },
      { action: 'tool.use', resource: 'webfetch:*', effect: 'deny' },
      { action: 'tool.use', resource: 'websearch:*', effect: 'deny' },
      { action: 'tool.use', resource: 'execute:*', effect: 'deny' },
      { action: 'tool.use', resource: 'subagent:*', effect: 'deny' },
      { action: 'tool.use', resource: 'skill:*', effect: 'deny' },
      { action: 'tool.use', resource: 'external_directory:*', effect: 'deny' },
      { action: 'mcp.use', resource: '*', effect: 'deny' },
      { action: 'plugin.use', resource: '*', effect: 'deny' },
      { action: 'skill.use', resource: '*', effect: 'deny' },
      { action: 'websearch.use', resource: '*', effect: 'deny' },
    ],
    snapshots: false,
    update: 'disable',
    warming: false,
    ...(overlay ?? {}),
  };
}

export interface Rule {
  action: string;
  resource: string;
  effect: string;
}

/** opencode's wildcard match: `*` matches any run of characters (rules are glob-like over action and resource). */
export function wildcard(value: string, pattern: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(value);
}

/** Last matching rule wins; no match asks (opencode 2.2.7 `Permission.evaluate`). */
export function evaluateRules(rules: readonly Rule[], action: string, resource: string): string {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i] as Rule;
    if (wildcard(action, r.action) && wildcard(resource, r.resource)) return r.effect;
  }
  return 'ask';
}

/**
 * The tool permission actions opencode 2.2.7 registers (its `tool/plugin/*` sources, plus Code Mode's `execute`).
 * A tool is offered to the model unless the last rule matching its action is a deny on resource `*` (2.2.7
 * `whollyDisabled`), so the offer can be computed offline from the agent's effective rules (`debug agents`).
 */
export const OPENCODE_TOOL_ACTIONS = [
  'read',
  'glob',
  'grep',
  'edit',
  'write',
  'patch',
  'shell',
  'webfetch',
  'websearch',
  'skill',
  'subagent',
  'todowrite',
  'question',
  'experimental_image_generate',
  'list_mcp_resources',
  'read_mcp_resource',
  'artifact_create',
  'artifact_read',
  'artifact_update',
  'artifact_delete',
  'opencode',
  'session_rename',
  'session_move',
  'worktree_create',
  'schedule_create',
  'schedule_list',
  'schedule_pause',
  'schedule_resume',
  'execute',
] as const;

/** 2.2.7's `whollyDisabled`: the last rule matching the action denies resource `*`. */
export function whollyDisabled(action: string, rules: readonly Rule[]): boolean {
  for (let i = rules.length - 1; i >= 0; i--) {
    const r = rules[i] as Rule;
    if (wildcard(action, r.action)) return r.resource === '*' && r.effect === 'deny';
  }
  return false;
}

/**
 * The tools an agent with these effective rules is offered. Measured with the council config on 2.2.7: opencode
 * appends `skill browser deny` after the agent's own rules, so `skill` is the last match for the skill tool with a
 * resource other than `*`, and the skill tool stays offered whatever the council config says.
 */
export function offeredTools(rules: readonly Rule[]): string[] {
  return OPENCODE_TOOL_ACTIONS.filter((a) => !whollyDisabled(a, rules));
}

/** Splits a `provider/model` pin. */
export function splitModel(pin: string): { providerID: string; id: string } | null {
  const at = pin.indexOf('/');
  if (at <= 0 || at === pin.length - 1) return null;
  return { providerID: pin.slice(0, at), id: pin.slice(at + 1) };
}

/** A model family from a `provider/model` id, for the same-family warnings (plan 5.2). */
export function familyOf(pin: string): string {
  const m = splitModel(pin);
  const provider = m?.providerID ?? '';
  const id = (m?.id ?? pin).toLowerCase();
  const byProvider: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', google: 'google', 'google-vertex': 'google', xai: 'xai', meta: 'meta' };
  if (byProvider[provider] !== undefined) return byProvider[provider] as string;
  // A router's model id may name the upstream provider first (`openrouter/openai/gpt-5.5`).
  const upstream = id.includes('/') ? id.slice(0, id.indexOf('/')) : null;
  if (upstream !== null && byProvider[upstream] !== undefined) return byProvider[upstream] as string;
  const byName: Array<[RegExp, string]> = [
    [/claude/, 'anthropic'],
    [/^(?:gpt|o\d)/, 'openai'],
    [/gemini/, 'google'],
    [/grok/, 'xai'],
    [/deepseek/, 'deepseek'],
    [/glm/, 'zhipu'],
    [/qwen/, 'qwen'],
    [/minimax/, 'minimax'],
    [/kimi/, 'moonshot'],
    [/nemotron/, 'nvidia'],
    [/llama|muse/, 'meta'],
  ];
  for (const [re, family] of byName) if (re.test(id)) return family;
  return provider !== '' ? provider : 'unknown';
}

/** Models measured on 2.2.7 with no key: the free `opencode/*` list (`opencode models`). */
export const OPENCODE_FREE_MODELS: readonly string[] = [
  'opencode/beam-free',
  'opencode/big-pickle',
  'opencode/deepseek-v4.1-flash-free',
  'opencode/flint-40b-free',
  'opencode/glm-5.3-flash-free',
  'opencode/iceman-free',
  'opencode/inkling-2-small-free',
  'opencode/longcat-2.5-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/minimax-m3.1-flash-free',
  'opencode/nemotron-3.5-lightning-free',
  'opencode/nemotron-3.5-super-vl-free',
];

export function modelInfos(ids: readonly string[]): ModelInfo[] {
  return ids.map((id) => ({ id, family: familyOf(id) }));
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
