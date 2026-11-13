import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MUSE_SAFETY_FLAGS } from './known.js';

/*
 * The muse leg's command line and environment (plan 4.2):
 *   - `muse exec --json --session-id <uuid> --workspace <root>`, the safety flags (read-only profile, write, shell,
 *     web tools, user input and reminders off, no foreign personal context, contributor mode off), one agent
 *     (`-c agents.execution_capacity=1`), a step cap, the model and effort, the brief by `--prompt-file`;
 *   - `HOME` is the leg's own dir (no user-level `.muse`, `.agents`, `.claude` or `.codex` hooks, rules, skills or MCP
 *     config can load); `XDG_CONFIG_HOME` is the leg's own dir holding only `{"schema_version": 1}` (no user settings,
 *     hooks, MCP servers, agents or skills), and `XDG_DATA_HOME` is the leg's own dir, so the session log lands there;
 *   - the sign-in: `META_API_KEY` wins over a stored session (and bills pay-as-you-go); otherwise the user's
 *     `muse login` session is read through `MUSE_AUTH_PATH`, which points at the user's own auth file;
 *   - `MUSE_NO_AUTO_UPDATE=1`, `MUSE_CONTRIBUTOR_MODE=0` (the flag wins too), `MUSE_LOGIN=0`.
 */

export const MUSE_ENV_ALLOW = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // The pay-as-you-go route. Passed through by name; the value is never read, logged or recorded.
  'META_API_KEY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

export const MUSE_ENV_SET: Readonly<Record<string, string>> = {
  MUSE_NO_AUTO_UPDATE: '1',
  MUSE_CONTRIBUTOR_MODE: '0',
  MUSE_LOGIN: '0',
  NO_COLOR: '1',
};

/** Presence only: the value is never read. */
export function hasMetaKey(env: NodeJS.ProcessEnv): boolean {
  const v = env['META_API_KEY'];
  return v !== undefined && v !== '';
}

/** The user's muse auth file: `MUSE_AUTH_PATH`, else `$XDG_CONFIG_HOME/muse/auth.json`, else `~/.config/muse/auth.json`. */
export function userMuseAuthPath(env: NodeJS.ProcessEnv): string | null {
  if (env['MUSE_AUTH_PATH']) return env['MUSE_AUTH_PATH'];
  if (env['XDG_CONFIG_HOME']) return join(env['XDG_CONFIG_HOME'], 'muse', 'auth.json');
  return env['HOME'] ? join(env['HOME'], '.config', 'muse', 'auth.json') : null;
}

/**
 * The native binary the launcher would run, by absolute path: the launcher (the council's own install, else
 * `~/.local/bin/muse`) records its version in `.muse-version` beside `muse-bin-<version>`. Calling the binary skips
 * the launcher's update check and its use of HOME, which each leg isolates. Falls back to the launcher, then `muse`.
 */
export function defaultMuseBin(env: NodeJS.ProcessEnv): string {
  const home = env['HOME'];
  const dirs = home ? [join(home, '.sabotage-council', 'tools', 'muse', 'bin'), join(home, '.local', 'bin')] : [];
  for (const dir of dirs) {
    const marker = join(dir, '.muse-version');
    if (existsSync(marker)) {
      const version = readFileSync(marker, 'utf8').trim();
      const bin = join(dir, `muse-bin-${version}`);
      if (/^[\w.-]+$/.test(version) && existsSync(bin)) return bin;
    }
    if (existsSync(join(dir, 'muse'))) return join(dir, 'muse');
  }
  return 'muse';
}

export interface MuseLegFiles {
  stream: string;
  stderr: string;
  process: string;
  config: string;
  data: string;
  /** The leg's own HOME (claude F2): no user-level muse, agents, claude or codex files reach the leg. */
  home: string;
  settings: string;
  export: string;
}

export function museLegFiles(legDir: string): MuseLegFiles {
  const dir = resolve(legDir);
  return {
    stream: join(dir, 'stream.jsonl'),
    stderr: join(dir, 'stderr.log'),
    process: join(dir, 'process.json'),
    config: join(dir, 'muse', 'config'),
    data: join(dir, 'muse', 'data'),
    home: join(dir, 'muse', 'home'),
    settings: join(dir, 'muse', 'config', 'muse', 'settings.json'),
    export: join(dir, 'export.json'),
  };
}

export function prepareMuseDirs(files: MuseLegFiles): void {
  mkdirSync(join(files.config, 'muse'), { recursive: true });
  mkdirSync(files.data, { recursive: true });
  mkdirSync(files.home, { recursive: true });
  writeFileSync(files.settings, `${JSON.stringify({ schema_version: 1 })}\n`);
}

export interface MuseArgsInput {
  sessionId: string;
  root: string;
  model: string;
  effort: string;
  briefFile: string;
  maxSteps?: number | undefined;
}

export function museArgs(input: MuseArgsInput): string[] {
  return [
    'exec',
    '--json',
    '--session-id',
    input.sessionId,
    '--workspace',
    input.root,
    ...MUSE_SAFETY_FLAGS,
    '--max-model-steps',
    String(input.maxSteps ?? 80),
    '-c',
    'agents.execution_capacity=1',
    '--model',
    input.model,
    '--reasoning-effort',
    input.effort,
    '--prompt-file',
    input.briefFile,
  ];
}

export function museEnv(source: NodeJS.ProcessEnv, files: MuseLegFiles): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of MUSE_ENV_ALLOW) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // The login file is resolved from the user's environment before HOME is replaced by the leg's own.
  const auth = userMuseAuthPath(source);
  return { ...env, ...MUSE_ENV_SET, HOME: files.home, XDG_CONFIG_HOME: files.config, XDG_DATA_HOME: files.data, ...(auth !== null ? { MUSE_AUTH_PATH: auth } : {}) };
}
