import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CURSOR_PERMISSIONS, CURSOR_READ_BOUNDARY, CURSOR_READ_TOOLS, compareCursorVersions } from './known.js';
import { CURSOR_GATE_EVENTS, CURSOR_LOG_EVENTS, councilHookScript } from './hook.js';

/*
 * The cursor leg's command line, config dir and environment (plan 4.2):
 *   - the versioned binary by absolute path, never `agent` or `cursor-agent` on PATH;
 *   - `-p --output-format stream-json --trust --mode ask --sandbox enabled --workspace <root> --model <slug>`, the
 *     brief as the prompt argument (print mode reads no file), never `--force`, `--yolo` or `--approve-mcps`;
 *   - `CURSOR_CONFIG_DIR` is a council-owned dir outside the root holding `cli-config.json` (allowlist approvals,
 *     the deny rules, a workspace read boundary) and `hooks.json` (the council hook on every gate and log event);
 *     both are also written to the leg HOME's `.cursor/`; nothing is written into the root at launch;
 *   - with `CURSOR_API_KEY`, `HOME` is the leg's own dir (no `~/.claude` hooks or user `~/.cursor` config can load,
 *     and the workspace read boundary's `~/.cursor` is the leg's own); the keychain route keeps the user's HOME, and
 *     preflight refuses it wherever that HOME holds anything Cursor imports or would read.
 */

export const CURSOR_ENV_ALLOW = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // The API-key route. Passed through by name; the value is never read, logged or recorded.
  'CURSOR_API_KEY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const;

export const CURSOR_ENV_SET: Readonly<Record<string, string>> = { NO_OPEN_BROWSER: '1', NO_COLOR: '1' };

/** Presence only: the value is never read. */
export function hasCursorKey(env: NodeJS.ProcessEnv): boolean {
  const v = env['CURSOR_API_KEY'];
  return v !== undefined && v !== '';
}

/** Where the installer unpacks releases. */
export function cursorVersionsDir(env: NodeJS.ProcessEnv): string | null {
  const home = env['HOME'];
  return home !== undefined && home !== '' ? join(home, '.local', 'share', 'cursor-agent', 'versions') : null;
}

/** The newest unpacked release's binary, by absolute path; null when none is installed. */
export function defaultCursorBin(env: NodeJS.ProcessEnv): string | null {
  const dir = cursorVersionsDir(env);
  if (dir === null || !existsSync(dir)) return null;
  const versions = readdirSync(dir).filter((v) => /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]{7}$/.test(v) && existsSync(join(dir, v, 'cursor-agent')));
  const newest = versions.sort(compareCursorVersions).at(-1);
  return newest === undefined ? null : join(dir, newest, 'cursor-agent');
}

export interface CursorLegFiles {
  stream: string;
  stderr: string;
  process: string;
  configDir: string;
  cliConfig: string;
  hooksJson: string;
  hookScript: string;
  hookLog: string;
  home: string;
}

export function cursorLegFiles(legDir: string): CursorLegFiles {
  const dir = resolve(legDir);
  const configDir = join(dir, 'cursor-config');
  return {
    stream: join(dir, 'stream.jsonl'),
    stderr: join(dir, 'stderr.log'),
    process: join(dir, 'process.json'),
    configDir,
    cliConfig: join(configDir, 'cli-config.json'),
    hooksJson: join(configDir, 'hooks.json'),
    hookScript: join(configDir, 'council-hook.mjs'),
    hookLog: join(dir, 'hooks.ndjson'),
    home: join(dir, 'home'),
  };
}

/** The council's `cli-config.json`, by the documented keys only (see CURSOR_READ_BOUNDARY). */
export function cursorCliConfig(): Record<string, unknown> {
  return {
    version: 1,
    editor: { vimMode: false },
    approvalMode: 'allowlist',
    permissions: { allow: [...CURSOR_PERMISSIONS.allow], deny: [...CURSOR_PERMISSIONS.deny] },
    sandbox: { readBoundary: CURSOR_READ_BOUNDARY },
  };
}

export function cursorHooks(files: CursorLegFiles, root: string, node: string): Record<string, unknown> {
  const hook = (event: string) => [{ command: `${JSON.stringify(node)} ${JSON.stringify(files.hookScript)} ${event} ${JSON.stringify(root)} ${JSON.stringify(files.hookLog)}` }];
  return { version: 1, hooks: Object.fromEntries([...CURSOR_GATE_EVENTS, ...CURSOR_LOG_EVENTS].map((e) => [e, hook(e)])) };
}

/**
 * Writes the council-owned config dir (outside the root) and the leg's own HOME. `CURSOR_CONFIG_DIR` is documented to
 * relocate `cli-config.json` only, so the same config and the council `hooks.json` also go to the leg HOME's
 * `.cursor/`, the user-level location, which on the API-key route is the leg's own. A leg whose hooks did not load
 * leaves no hook log and fails ratification.
 */
export function prepareCursorConfig(files: CursorLegFiles, root: string, node = process.execPath): void {
  mkdirSync(files.configDir, { recursive: true });
  mkdirSync(join(files.home, '.cursor'), { recursive: true });
  const config = `${JSON.stringify(cursorCliConfig(), null, 2)}\n`;
  const hooks = `${JSON.stringify(cursorHooks(files, root, node), null, 2)}\n`;
  writeFileSync(files.cliConfig, config);
  writeFileSync(files.hookScript, councilHookScript(CURSOR_READ_TOOLS), { mode: 0o755 });
  writeFileSync(files.hooksJson, hooks);
  writeFileSync(join(files.home, '.cursor', 'cli-config.json'), config);
  writeFileSync(join(files.home, '.cursor', 'hooks.json'), hooks);
}

export function cursorArgs(input: { root: string; model: string; prompt: string }): string[] {
  return ['-p', '--output-format', 'stream-json', '--trust', '--mode', 'ask', '--sandbox', 'enabled', '--workspace', input.root, '--model', input.model, input.prompt];
}

export function cursorEnv(source: NodeJS.ProcessEnv, files: CursorLegFiles): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of CURSOR_ENV_ALLOW) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  const home = hasCursorKey(source) ? files.home : (source['HOME'] ?? files.home);
  return { ...env, ...CURSOR_ENV_SET, HOME: home, CURSOR_CONFIG_DIR: files.configDir };
}

export function readBrief(path: string): string {
  return readFileSync(path, 'utf8');
}
