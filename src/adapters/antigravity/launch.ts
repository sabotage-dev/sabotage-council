import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/*
 * The antigravity leg's command line and its own files (plan 4.2, D7): `agy acp`, the documented client route,
 * never `agy -p` for a review. The leg gets:
 *   - its own gemini dir (`--gemini-dir`, absolute) in the leg dir, so the user's settings, rules, plugins, skills,
 *     hooks and global instruction file stay out, and the conversation records land beside the update log;
 *   - telemetry off, the terminal sandbox on, and the default customizations off;
 *   - its own log file, read by the ratifier;
 *   - auto-update off (the CLI updated itself overnight during planning).
 * The process is detached into its own session, so it has no controlling terminal: a sign-in that would read an
 * OAuth code from /dev/tty fails instead of waiting.
 */

export const AGY_ENV_ALLOW = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // The documented headless route: a Gemini API key with `modelProvider: "gemini"` in the leg's own settings.
  // Passed through by name; the value is never read, logged or recorded by the engine.
  'GEMINI_API_KEY',
  'GOOGLE_GEMINI_BASE_URL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

/** Set for every leg: no self-update, no terminal escape sequences, no colour. */
export const AGY_ENV_SET: Readonly<Record<string, string>> = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true', AGY_CLI_OSC7501: 'off', NO_COLOR: '1' };

/** Presence only: the value is never read. */
export function hasGeminiKey(env: NodeJS.ProcessEnv): boolean {
  const v = env['GEMINI_API_KEY'];
  return v !== undefined && v !== '';
}

export interface AgyLegFiles {
  log: string;
  stderr: string;
  process: string;
  agyLog: string;
  geminiDir: string;
  settings: string;
}

export function agyLegFiles(legDir: string): AgyLegFiles {
  const dir = resolve(legDir);
  const geminiDir = join(dir, 'gemini');
  return {
    log: join(dir, 'updates.jsonl'),
    stderr: join(dir, 'stderr.log'),
    process: join(dir, 'process.json'),
    agyLog: join(dir, 'agy.log'),
    geminiDir,
    settings: join(geminiDir, 'antigravity-cli', 'settings.json'),
  };
}

/**
 * The leg's settings file. Workspace-only access is spelled out; the API-key route adds `modelProvider`. An
 * overlay (the promotion canary only) is merged on top, which is how a planted allow rule reaches a test leg.
 */
export function agyLegSettings(apiKey: boolean, overlay?: Record<string, unknown>): Record<string, unknown> {
  return { allowNonWorkspaceAccess: false, ...(apiKey ? { modelProvider: 'gemini' } : {}), ...(overlay ?? {}) };
}

export function writeAgySettings(files: AgyLegFiles, settings: Record<string, unknown>): void {
  mkdirSync(join(files.geminiDir, 'antigravity-cli'), { recursive: true });
  writeFileSync(files.settings, `${JSON.stringify(settings, null, 2)}\n`);
}

export function agyArgs(files: AgyLegFiles): string[] {
  return [
    'acp',
    '--disable-telemetry',
    '--sandbox',
    '--include-default-customizations=false',
    '--gemini-dir',
    files.geminiDir,
    '--log-file',
    files.agyLog,
  ];
}
