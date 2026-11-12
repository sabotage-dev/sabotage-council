import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KIRO_AGENT, profileText } from './known.js';

/*
 * The kiro leg's command line, homes and files (plan 4.2):
 *   - `kiro-cli acp --agent-engine v2 --agent sabotage-council --model <m> [--effort <e>]`, never `--trust-tools` or
 *     `--trust-all-tools`, so every tool use is a permission request the client answers;
 *   - `KIRO_HOME` is the leg's own directory holding only the council agent profile, so the user's steering, hooks,
 *     MCP servers, agents and settings never load, and the session record lands beside the update log;
 *   - `HOME` is the seat's `auth_home` when set (a separate Kiro login, read from its own token store), else the
 *     user's HOME. Nothing else of the user's environment that could move the store (`XDG_*`) is passed.
 */

export const KIRO_ENV_ALLOW = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // The documented headless route. Passed through by name; the value is never read, logged or recorded.
  'KIRO_API_KEY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

export const KIRO_ENV_SET: Readonly<Record<string, string>> = { NO_COLOR: '1', TERM: 'dumb' };

/** Kills the leg the moment kiro-cli starts a browser sign-in (it would otherwise wait about 600 s). */
export const KIRO_KILL_ON = /Opening browser|Press enter to continue to the browser|let's get you signed in|Auth portal timed out/i;

/** Presence only: the value is never read. */
export function hasKiroKey(env: NodeJS.ProcessEnv): boolean {
  const v = env['KIRO_API_KEY'];
  return v !== undefined && v !== '';
}

/** The HOME kiro-cli runs with: the seat's `auth_home`, else the user's own. */
export function kiroHome(authHome: string | undefined, env: NodeJS.ProcessEnv): string | null {
  if (authHome !== undefined) return authHome;
  const home = env['HOME'];
  return home !== undefined && home !== '' ? home : null;
}

/** Where kiro-cli keeps its login under a HOME: the macOS app-support dir, else the XDG data default. */
export function kiroTokenStore(home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
    : join(home, '.local', 'share', 'kiro-cli', 'data.sqlite3');
}

export interface KiroLegFiles {
  log: string;
  stderr: string;
  process: string;
  kiroHome: string;
  profile: string;
}

export function kiroLegFiles(legDir: string): KiroLegFiles {
  const dir = resolve(legDir);
  const kh = join(dir, 'kiro-home');
  return {
    log: join(dir, 'updates.jsonl'),
    stderr: join(dir, 'stderr.log'),
    process: join(dir, 'process.json'),
    kiroHome: kh,
    profile: join(kh, 'agents', `${KIRO_AGENT}.json`),
  };
}

export function writeKiroProfile(files: KiroLegFiles, model: string, overlay?: Record<string, unknown>): void {
  mkdirSync(join(files.kiroHome, 'agents'), { recursive: true });
  writeFileSync(files.profile, profileText(model, overlay));
}

export function kiroArgs(model: string, effort: string | undefined): string[] {
  return ['acp', '--agent-engine', 'v2', '--agent', KIRO_AGENT, '--model', model, ...(effort !== undefined ? ['--effort', effort] : [])];
}

export function kiroEnv(source: NodeJS.ProcessEnv, home: string, files: KiroLegFiles, allow: readonly string[] = KIRO_ENV_ALLOW): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allow) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...KIRO_ENV_SET, HOME: home, KIRO_HOME: files.kiroHome };
}
