import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GROK_DENY_RULES, GROK_DISALLOWED_TOOLS, GROK_READ_TOOLS, GROK_SWITCHES, type GrokSandbox } from './known.js';

/*
 * The grok leg's command line, homes and files (plan 4.2, the working leg command):
 *   - headless `--prompt-file <brief> --cwd <root> -s <session uuid> -m <model> --effort <effort>`, with
 *     `--output-format streaming-messages-json` (the only format that reports the tool list, permission mode and
 *     MCP status at start) and `--permission-mode dontAsk`;
 *   - the read allowlist, the disallow list and the deny rules, and the headless switches (no web search,
 *     subagents, plan mode, memory, auto-update or background wait);
 *   - `--sandbox read-only` where it starts, else `--sandbox off`, as the seat config says (recorded on the leg);
 *   - `HOME` is the leg's own empty directory, so Claude Code compatibility (the user's `~/.claude` instructions,
 *     plugins, hooks, MCP servers and permission rules) never loads; `GROK_HOME` is the user's grok home for the
 *     subscription login, or the leg's own empty one when `XAI_API_KEY` is set (no `config.toml`, so no MCP).
 *   - stdin is /dev/null: headless mode never reads stdin into the prompt.
 */

export const GROK_ENV_ALLOW = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // The API-key route. Passed through by name; the value is never read, logged or recorded.
  'XAI_API_KEY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

/** Set for every grok leg: no self-update, no cross-session memory, no subagents, no web fetch, no colour codes. */
export const GROK_ENV_SET: Readonly<Record<string, string>> = {
  GROK_DISABLE_AUTOUPDATER: '1',
  GROK_MEMORY: '0',
  GROK_SUBAGENTS: '0',
  GROK_WEB_FETCH: '0',
  NO_COLOR: '1',
};

/** Presence only: the value is never read. */
export function hasXaiKey(env: NodeJS.ProcessEnv): boolean {
  const v = env['XAI_API_KEY'];
  return v !== undefined && v !== '';
}

/** The user's grok home: `GROK_HOME`, else `~/.grok`. */
export function userGrokHome(env: NodeJS.ProcessEnv): string | null {
  const explicit = env['GROK_HOME'];
  if (explicit !== undefined && explicit !== '') return explicit;
  const home = env['HOME'];
  return home !== undefined && home !== '' ? join(home, '.grok') : null;
}

/** The binary: `$GROK_HOME/bin/grok` when it exists (called by absolute path), else `grok` on PATH. */
export function defaultGrokBin(env: NodeJS.ProcessEnv): string {
  const home = userGrokHome(env);
  const bin = home !== null ? join(home, 'bin', 'grok') : null;
  return bin !== null && existsSync(bin) ? bin : 'grok';
}

export interface GrokLegFiles {
  stream: string;
  stderr: string;
  process: string;
  /** The leg's own empty HOME. */
  home: string;
  /** The leg's own empty grok home (API-key route only). */
  grokHome: string;
  /** Where the leg's session dir is copied after the leg, for the run store and fixtures. */
  session: string;
}

export function grokLegFiles(legDir: string): GrokLegFiles {
  const dir = resolve(legDir);
  return {
    stream: join(dir, 'stream.jsonl'),
    stderr: join(dir, 'stderr.log'),
    process: join(dir, 'process.json'),
    home: join(dir, 'home'),
    grokHome: join(dir, 'grok-home'),
    session: join(dir, 'session'),
  };
}

export type GrokRoute = 'auth_home' | 'api-key' | 'login';

/**
 * Which grok home a leg uses, and why: the seat's `auth_home` (its own grok login and config; `XAI_API_KEY` is then
 * not passed, so the leg signs in with that home's login, as a kiro `auth_home` does), else an empty home of the
 * leg's own with `XAI_API_KEY`, else the user's grok home.
 */
export function legGrokHome(env: NodeJS.ProcessEnv, files: GrokLegFiles, authHome?: string): { grokHome: string | null; route: GrokRoute } {
  if (authHome !== undefined) return { grokHome: authHome, route: 'auth_home' };
  if (hasXaiKey(env)) return { grokHome: files.grokHome, route: 'api-key' };
  return { grokHome: userGrokHome(env), route: 'login' };
}

export function prepareGrokHomes(files: GrokLegFiles, route: GrokRoute): void {
  mkdirSync(files.home, { recursive: true });
  if (route === 'api-key') mkdirSync(files.grokHome, { recursive: true });
}

export interface GrokArgsInput {
  briefFile: string;
  root: string;
  sessionId: string;
  model: string;
  effort: string;
  sandbox: GrokSandbox;
  maxTurns?: number | undefined;
  /** Planted allow rules: the promotion canary only. Preflight refuses any. */
  allowRules?: readonly string[] | undefined;
}

export function grokArgs(input: GrokArgsInput): string[] {
  const args = [
    '--prompt-file',
    input.briefFile,
    '--cwd',
    input.root,
    '-s',
    input.sessionId,
    '-m',
    input.model,
    '--effort',
    input.effort,
    '--output-format',
    'streaming-messages-json',
    '--permission-mode',
    'dontAsk',
    '--tools',
    GROK_READ_TOOLS.join(','),
    '--disallowed-tools',
    GROK_DISALLOWED_TOOLS.join(','),
    ...GROK_DENY_RULES.flatMap((rule) => ['--deny', rule]),
    ...GROK_SWITCHES,
    '--sandbox',
    input.sandbox,
  ];
  if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns));
  for (const rule of input.allowRules ?? []) args.push('--allow', rule);
  return args;
}

/** The leg's environment: the allowlist, the fixed switches, the leg's HOME and the chosen grok home. */
export function grokEnv(source: NodeJS.ProcessEnv, home: string, grokHome: string, route: GrokRoute = 'login'): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GROK_ENV_ALLOW) {
    if (route === 'auth_home' && name === 'XAI_API_KEY') continue;
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...GROK_ENV_SET, HOME: home, GROK_HOME: grokHome };
}
