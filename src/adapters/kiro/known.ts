import { createHash } from 'node:crypto';
import type { ModelInfo } from '../../config/registry.js';
import type { EnforcementLabel } from '../types.js';

/*
 * What the kiro adapter declares per tested `kiro-cli` version and engine (plan 4.2, 4.6, 5.2).
 *
 * The v2 engine (P3, kept as `engine = "v2"`), measured on 3.2.1, 2026-11-12, with no model turn unless the report
 * says otherwise:
 *   - `kiro-cli acp --help` marks `--agent`, `--model` and `--effort` as "v2 engine only", and the engine falls back
 *     to v3 when no v2-only flag is given. The adapter pins the engine explicitly: `--agent-engine v2` with the three
 *     flags.
 *   - Over ACP the v2 engine reports the agent and model in the older `modes.currentModeId` and
 *     `models.currentModelId` fields (no `configOptions`), honours an isolated `KIRO_HOME` (the agent profile loads
 *     from `$KIRO_HOME/agents`, the session record lands in `$KIRO_HOME/sessions/cli/<session id>.json`, the same id
 *     the ACP session carries), and accepts a profile carrying both the v2 `toolsSettings` and a `permissions`
 *     block.
 *   - P11 ran `seats test` on v2 again on 3.3.0 and on 3.5.0: both ratified.
 *
 * The v3 engine (P11, the default since D18), measured on 3.5.0, 2026-11-18:
 *   - `kiro-cli acp --agent-engine v3` takes no agent, model or effort flag. The session opens on kiro's default
 *     agent, and every pin is a `session/set_config_option` checked in the reported `configOptions`: `mode` (the
 *     agent), `model` (listed once kiro's model list loads), `effortLevel` (only for a model with effort levels;
 *     none on the measured account), `autopilot` (default `on`), `contentCollection` (default `enabled`),
 *     `memoryReflection` and `sessionToolsMessaging` (seen `off`).
 *   - It does not know the v2 tool names (`fs_read`), so the P3 profile gives it no tools at all; the leg writes the
 *     agent file `kiro-cli agent upgrade` produces, plus P3's two web denies (KIRO_V3_AGENT_TEXT), and the gate
 *     checks that kiro offers exactly the `read` tag.
 *   - It writes `$KIRO_HOME/sessions/<hash>/<session id>/session.json` and `messages.jsonl`, and logs its user
 *     agent (`KiroCLI/<version> KAS/<version>`) in `$KIRO_HOME/logs/<run>/kiro.log`.
 *   - It reads `$KIRO_HOME/settings/cli.json`; `kiro-cli settings list --all` on 3.5.0 lists the three keys the leg
 *     sets (KIRO_SETTINGS_KEYS), and an unknown key is ignored.
 */

export type KiroEngine = 'v2' | 'v3';
export const KIRO_ENGINES: readonly KiroEngine[] = ['v3', 'v2'];
/** D18: a kiro occupant with no `engine` runs v3. */
export const KIRO_DEFAULT_ENGINE: KiroEngine = 'v3';

export function kiroEngine(engine: string | undefined): KiroEngine {
  return engine === 'v2' ? 'v2' : 'v3';
}

/** The leg settings file's keys (4.6): no self-update, no telemetry, no content shared with AWS. */
export const KIRO_SETTINGS_KEYS = ['app.disableAutoupdates', 'telemetry.enabled', 'codeWhisperer.shareCodeWhispererContentWithAWS'] as const;

export interface KiroVersionDecl {
  /** The engines measured on this version, each with its label (plan 5.2: `pending` until a canary passes). */
  engines: Partial<Record<KiroEngine, { enforcement: EnforcementLabel }>>;
  /** The settings keys `kiro-cli settings list --all` showed on this version; null: no leg settings file. */
  settings: readonly string[] | null;
}

export const KIRO_DECLARED: Readonly<Record<string, KiroVersionDecl>> = {
  '3.2.1': { engines: { v2: { enforcement: 'pending' } }, settings: null },
  '3.3.0': { engines: { v2: { enforcement: 'pending' } }, settings: null },
  '3.5.0': { engines: { v2: { enforcement: 'pending' }, v3: { enforcement: 'pending' } }, settings: KIRO_SETTINGS_KEYS },
};

export const KIRO_TESTED_VERSIONS = Object.keys(KIRO_DECLARED);
/** Below this, preflight refuses: the v2 acp flags and record layout were measured on 3.2.1. */
export const KIRO_FLOOR = '3.2.1';
/** Below this, a v3 occupant is refused (Q17): 3.5.0 is the only version the v3 agent file was measured on. */
export const KIRO_V3_FLOOR = '3.5.0';

export function kiroDecl(version: string | null): KiroVersionDecl | null {
  if (version === null) return null;
  return KIRO_DECLARED[version] ?? null;
}

/** The declared entry of one engine on one version, or null (an undeclared version, or an engine not measured there). */
export function kiroEngineDecl(version: string | null, engine: KiroEngine): { enforcement: EnforcementLabel } | null {
  return kiroDecl(version)?.engines[engine] ?? null;
}

/** The leg settings file for a version: its JSON text, or null when the version declares no settings keys. */
export function kiroSettingsText(version: string | null): string | null {
  const keys = kiroDecl(version)?.settings ?? null;
  if (keys === null) return null;
  const values: Record<string, boolean> = { 'app.disableAutoupdates': true, 'telemetry.enabled': false, 'codeWhisperer.shareCodeWhispererContentWithAWS': false };
  return `${JSON.stringify(Object.fromEntries(keys.map((k) => [k, values[k] ?? false])), null, 2)}\n`;
}

/** The one-key settings file preflight's `--version` runs with, and any version that declares no settings keys. */
export const KIRO_UPDATE_OFF_TEXT = `${JSON.stringify({ 'app.disableAutoupdates': true }, null, 2)}\n`;

/** The council agent's name, in `$KIRO_HOME/agents/<name>.json`. */
export const KIRO_AGENT = 'sabotage-council';

/*
 * The v3 agent file (4.6), one constant file shipped as these exact bytes (no trailing newline). Its base is the output
 * of `kiro-cli agent upgrade` (3.5.0) for the P3 profile minus its `model` key and its hand-written `permissions`
 * block: tools `glob`, `grep` and `read`; P3's `toolsSettings`; no hooks, MCP servers or resources; a generated
 * `permissions` block (shell deny `*`, fs_write deny `**`, fs_read allow `./**`); and the `kiroUpgrade` block of that
 * exact input. On top of that base, P3's `web_fetch` and `web_search` denies, which kiro's conversion drops. The model
 * is never in the file: it is pinned over ACP. A test asserts the bytes; the leg hashes the file on disk.
 */
export const KIRO_V3_AGENT_TEXT = [
  '{',
  '  "name": "sabotage-council",',
  '  "description": "sabotage-council read-only review seat",',
  '  "tools": [',
  '    "glob",',
  '    "grep",',
  '    "read"',
  '  ],',
  '  "allowedTools": [],',
  '  "toolsSettings": {',
  '    "execute_bash": {',
  '      "denyByDefault": true',
  '    },',
  '    "fs_write": {',
  '      "deniedPaths": [',
  '        "**"',
  '      ]',
  '    }',
  '  },',
  '  "resources": [],',
  '  "hooks": [],',
  '  "mcpServers": {},',
  '  "includeMcpJson": false,',
  '  "permissions": {',
  '    "rules": [',
  '      {',
  '        "capability": "shell",',
  '        "match": [',
  '          "*"',
  '        ],',
  '        "effect": "deny"',
  '      },',
  '      {',
  '        "capability": "fs_write",',
  '        "match": [',
  '          "**"',
  '        ],',
  '        "effect": "deny"',
  '      },',
  '      {',
  '        "capability": "fs_read",',
  '        "match": [',
  '          "./**"',
  '        ],',
  '        "effect": "allow"',
  '      },',
  '      {',
  '        "capability": "web_fetch",',
  '        "match": [',
  '          "*"',
  '        ],',
  '        "effect": "deny"',
  '      },',
  '      {',
  '        "capability": "web_search",',
  '        "match": [',
  '          "*"',
  '        ],',
  '        "effect": "deny"',
  '      }',
  '    ]',
  '  },',
  '  "kiroUpgrade": {',
  '    "revision": 3,',
  '    "fingerprint": "sha256:05eb4a75778be2d65203627b438cc4f87e8a8bab0ad164e5ad776d5957adec28",',
  '    "source": "sha256:af853cf771d041b0b0789c8654b296b991b614b5e4fa213c37557c575020f3f4"',
  '  }',
  '}',
].join('\n');

/** sha256 of KIRO_V3_AGENT_TEXT (the measured file's hash). */
export const KIRO_V3_AGENT_SHA256 = 'a97e6cc036f21ce50c79380883b93edd4b05943279942aa339f2fc0cf0bb8dca';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The v3 agent file with an overlay merged in (the promotion canary only; preflight refuses any overlay). */
export function kiroV3AgentText(overlay?: Record<string, unknown>): string {
  if (overlay === undefined || Object.keys(overlay).length === 0) return KIRO_V3_AGENT_TEXT;
  return JSON.stringify({ ...(JSON.parse(KIRO_V3_AGENT_TEXT) as Record<string, unknown>), ...overlay }, null, 2);
}

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
 * The council agent profile for the v2 engine (P3, measured to load on 3.2.1): read tools only, nothing pre-approved (every
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
  return sha256Hex(profileText(model));
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
