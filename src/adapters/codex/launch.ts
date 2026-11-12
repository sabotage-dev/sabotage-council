import { homedir } from 'node:os';
import { join } from 'node:path';

/*
 * The codex leg's command line (plan 4.2, brief P2 item 3). The prompt goes on stdin with `-` (a prompt argument
 * plus an open stdin pipe gives zero events, measured). The leg never combines per-server MCP flags with
 * `--ignore-user-config` (together they fail config load, measured), and never copies `auth.json`.
 */

/** Model slugs and effort words become `-m` and a TOML value; anything else is refused before launch. */
export const MODEL_SLUG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const EFFORT_WORD = /^[a-z]{1,16}$/;
/** MCP server names become a dotted `-c` key; a name that is not a bare TOML key cannot be disabled safely. */
export const MCP_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** Environment the codex leg may see (plan 6.5). Everything else is scrubbed. */
export const CODEX_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'CODEX_HOME',
  // The API-key route (plan 4.2). Passed through by name; the value is never read or recorded.
  'CODEX_API_KEY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

/** Variables the adapter sets for every codex leg. */
export const CODEX_ENV_SET: Readonly<Record<string, string>> = { NO_COLOR: '1' };

export interface CodexFlagInput {
  model: string;
  effort: string;
  /** Every configured MCP server, disabled by name (N12). */
  mcpNames: readonly string[];
}

/**
 * The `-c` and `--disable` flags a leg runs with. `codex debug prompt-input` accepts only these, so preflight
 * renders the leg's exact config with them (plan 4.3).
 */
export function codexConfigFlags(input: CodexFlagInput): string[] {
  const flags = [
    '-c',
    `model_reasoning_effort="${input.effort}"`,
    '--disable',
    'apps',
    '--disable',
    'plugins',
    '--disable',
    'hooks',
    '--disable',
    'multi_agent',
    '-c',
    'project_doc_max_bytes=0',
    '-c',
    'skills.include_instructions=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'analytics.enabled=false',
    '-c',
    'check_for_update_on_startup=false',
  ];
  for (const name of input.mcpNames) flags.push('-c', `mcp_servers.${name}.enabled=false`);
  return flags;
}

export interface CodexExecInput extends CodexFlagInput {
  root: string;
  lastFile: string;
}

/** `codex exec ...`, ending with `-` so the prompt is read from stdin. */
export function codexExecArgs(input: CodexExecInput): string[] {
  const flags = codexConfigFlags(input);
  // The brief's order: effort right after -m, then the rest of the config flags, then -o and `-`.
  return [
    'exec',
    '--json',
    '--color',
    'never',
    '-C',
    input.root,
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '-m',
    input.model,
    ...flags,
    '-o',
    input.lastFile,
    '-',
  ];
}

/** Where codex keeps its rollouts: `$CODEX_HOME`, else `~/.codex`. */
export function codexHomeOf(env: NodeJS.ProcessEnv): string {
  const set = env['CODEX_HOME'];
  if (set !== undefined && set !== '') return set;
  return join(env['HOME'] ?? homedir(), '.codex');
}

export function validateCodexOccupant(model: string, effort: string | undefined): string | null {
  if (!MODEL_SLUG.test(model)) return `model "${model}" is not a codex model slug`;
  if (effort === undefined) return 'codex seats need an effort: some models default to low (plan 4.2)';
  if (!EFFORT_WORD.test(effort)) return `effort "${effort}" is not an effort word`;
  return null;
}
