import { CLAUDE_READ_TOOLS, type ClaudeVersionDecl } from './known.js';

/*
 * The claude leg's command line (plan 4.2, brief P2 item 4). Never reads, stores or forwards Claude credentials
 * (D15): the engine runs the user's unmodified `claude` binary, which uses whatever the user signed into.
 *
 * The prompt goes on stdin. Measured on 2.1.322: a prompt argument placed after the variadic `--disallowedTools`
 * list is taken as one more tool name, and the run stops with "Input must be provided"; stdin always works.
 */

/** Environment the claude leg may see (plan 6.5). */
export const CLAUDE_ENV_ALLOW = [
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
  'CLAUDE_CONFIG_DIR',
  // The API-key route (`--bare`) and the Bedrock/Vertex routes. Passed through by name; values are never read,
  // logged or recorded by the engine.
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

/** Set for every claude leg: no self-update during a leg (plan 6.7), no colour codes. */
export const CLAUDE_ENV_SET: Readonly<Record<string, string>> = { DISABLE_AUTOUPDATER: '1', NO_COLOR: '1' };

/** The leg's own settings: reads outside the working directory are blocked (plan 4.2). */
export const CLAUDE_LEG_SETTINGS = { permissions: { blockReadsOutsideWorkingDirectories: true } } as const;

export interface ClaudeArgsInput {
  model: string;
  effort: string;
  sessionId: string;
  /** Path of the settings JSON the leg passes with `--settings`. */
  settingsFile: string;
  decl: ClaudeVersionDecl;
  /** `ANTHROPIC_API_KEY` is set: run `--bare` (drops plugins, user hooks and CLAUDE.md discovery). */
  bare: boolean;
  maxTurns?: number | undefined;
  maxBudgetUsd?: number | undefined;
}

export function claudeArgs(input: ClaudeArgsInput): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.model,
    '--effort',
    input.effort,
    '--restricted',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    CLAUDE_READ_TOOLS.join(','),
    '--strict-mcp-config',
    '--setting-sources',
    input.decl.settingSources,
    '--settings',
    input.settingsFile,
    '--session-id',
    input.sessionId,
  ];
  if (input.bare) args.push('--bare');
  if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns));
  if (input.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(input.maxBudgetUsd));
  // The two variadic lists go last; nothing positional follows them (the prompt is on stdin).
  args.push('--allowedTools', ...CLAUDE_READ_TOOLS, '--disallowedTools', ...input.decl.nonReadBuiltins);
  return args;
}

/** Presence only: the value is never read. */
export function hasApiKey(env: NodeJS.ProcessEnv): boolean {
  const v = env['ANTHROPIC_API_KEY'];
  return v !== undefined && v !== '';
}
