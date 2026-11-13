import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { FailureClass } from '../../config/vocab.js';
import type { CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { CURSOR_FLOOR, CURSOR_LABEL, CURSOR_TESTED_VERSIONS, compareCursorVersions, parseCursorVersion } from './known.js';
import { cursorEnv, cursorLegFiles, cursorVersionsDir, hasCursorKey, prepareCursorConfig } from './launch.js';

/*
 * Cursor preflight (plan 4.3), with no model call:
 *   - the binary is an unpacked release under `~/.local/share/cursor-agent/versions/` (called by path), and its
 *     `--version` is a Cursor version (`YYYY.MM.DD-sha7`), not another vendor's `agent`;
 *   - the sign-in: `CURSOR_API_KEY`, else `status` must not report a missing or invalid login;
 *   - the slug (effort is part of it) is in `models`;
 *   - the root holds none of the files Cursor loads from a trusted workspace (`.cursor/`, `.claude/`, `AGENTS.md`,
 *     `CLAUDE.md`, `.cursorignore`, `.mcp.json`): `--trust` is required headless and would load them;
 *   - the council config dir is written outside the root; on the keychain login, what the user's HOME holds that
 *     Cursor imports (`~/.claude/settings.json` hooks, `~/.cursor` hooks, MCP and rules) is listed as user-owned.
 * Every version is untested (D14), so the label is `weak` and `doctor` refuses Cursor seats for `auto`.
 */

export interface CursorPreflightOptions {
  bin: string | null;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  legDir: string;
  timeoutMs?: number | undefined;
}

const ROOT_AGENT_CONFIG = /^(?:\.cursor|\.claude|AGENTS.*\.md|CLAUDE\.md|\.cursorignore|\.mcp\.json)$/i;
const USER_IMPORTS = ['.claude/settings.json', '.claude/settings.local.json', '.cursor/hooks.json', '.cursor/mcp.json', '.cursor/rules'];

export async function cursorPreflight(o: Occupant, options: CursorPreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const files = cursorLegFiles(options.legDir);
  const apiKey = hasCursorKey(options.env);
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null): Preflight => ({
    ok,
    backend: 'cursor',
    cliVersion,
    enforcement: CURSOR_LABEL,
    checks,
    userOwned,
    failureClass,
    reason,
    data: { bin: options.bin, credential: apiKey ? 'CURSOR_API_KEY (HOME isolated per leg)' : 'Cursor login (the user HOME)', loaded: [], auto: false },
  });
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail });
  };

  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,79}$/.test(o.model) || o.model === 'auto') {
    fail('occupant', `model "${o.model}" is not a Cursor model slug a seat can pin (auto routes per request)`);
    return result(false, 'setup', 'bad model slug', null);
  }
  if (o.effort !== undefined && !o.model.endsWith(`-${o.effort}`)) {
    fail('occupant', `Cursor encodes effort in the slug; ${o.model} does not end in -${o.effort} (leave effort unset or pick the matching slug)`);
    return result(false, 'setup', 'effort not in the slug', null);
  }
  const versionsDir = cursorVersionsDir(options.env);
  if (options.bin === null) {
    fail('binary', `no Cursor release under ${String(versionsDir)}; the adapter never calls agent or cursor-agent from PATH`);
    return result(false, 'setup', 'cursor-agent not installed', null);
  }
  let real = options.bin;
  try {
    real = realpathSync(options.bin);
  } catch {
    // reported by the version check
  }
  if (versionsDir !== null && !real.startsWith(`${versionsDir}/`) && !options.bin.startsWith(`${versionsDir}/`)) {
    checks.push({ name: 'binary', status: 'warn', detail: `${options.bin} is not an unpacked release under ${versionsDir}` });
  }
  prepareCursorConfig(files, options.root);
  const env = cursorEnv(options.env, files);
  const run = (args: readonly string[]) => options.runner(options.bin as string, args, { cwd: options.root, env, timeoutMs });

  const version = await run(['--version']);
  const cliVersion = version.exitCode === 0 ? parseCursorVersion(version.stdout) : null;
  if (cliVersion === null) {
    fail('binary', `${options.bin} --version did not print a Cursor version (${version.error ?? version.stdout.trim().slice(0, 80)}); another vendor's agent binary?`);
    return result(false, 'setup', 'not a Cursor binary', null);
  }
  if (compareCursorVersions(cliVersion, CURSOR_FLOOR) < 0) {
    fail('version', `cursor-agent ${cliVersion} is below the floor ${CURSOR_FLOOR}`);
    return result(false, 'setup', `cursor-agent ${cliVersion} is below the floor`, cliVersion);
  }
  checks.push({ name: 'version', status: 'warn', detail: `cursor-agent ${cliVersion}: no Cursor version is tested in v1 (D14${CURSOR_TESTED_VERSIONS.length > 0 ? `; tested ${CURSOR_TESTED_VERSIONS.join(', ')}` : ''}); label weak` });

  if (apiKey) {
    checks.push({ name: 'auth', status: 'ok', detail: 'CURSOR_API_KEY (the leg HOME is its own empty dir)' });
  } else {
    const status = await run(['status']);
    const text = `${status.stdout}\n${status.stderr}`;
    if (status.exitCode !== 0 || /not (?:logged in|authenticated)|authentication is invalid|log in again|run '?(?:agent|cursor-agent) login/i.test(text)) {
      fail('auth', `cursor-agent status: ${text.trim().slice(0, 200) || `exit ${String(status.exitCode)}`}; run \`cursor-agent login\`, or set CURSOR_API_KEY`);
      return result(false, 'auth', 'cursor is not logged in', cliVersion);
    }
    checks.push({ name: 'auth', status: 'ok', detail: 'Cursor login (keychain)' });
  }
  const models = await run(['models']);
  const escaped = o.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[\\s,(])${escaped}([\\s,)]|$)`, 'm').test(models.stdout)) {
    fail('model', `${o.model} is not in cursor-agent models`);
    return result(false, 'model', `model ${o.model} not offered`, cliVersion);
  }
  checks.push({ name: 'model', status: 'ok', detail: `${o.model} offered; the council hook's model_id is the binding proof` });

  const planted = existsSync(options.root) ? readdirSync(options.root).filter((n) => ROOT_AGENT_CONFIG.test(n)) : [];
  if (planted.length > 0) {
    fail('isolation', `the root holds files a trusted workspace loads, which the sanitizer should have moved: ${planted.join(', ')}`);
    return result(false, 'setup', 'root not sanitized', cliVersion);
  }
  checks.push({ name: 'isolation', status: 'note', detail: `council config dir ${files.configDir} (deny rules, sandbox, the deny-all-but-reads hook), outside the root` });
  if (!apiKey) {
    const home = options.env['HOME'] ?? '';
    const present = USER_IMPORTS.filter((p) => home !== '' && existsSync(join(home, p)));
    for (const p of present) userOwned.push(`~/${p} (Cursor imports it on the keychain login)`);
    if (present.length > 0) checks.push({ name: 'user-owned', status: 'warn', detail: `the user HOME holds ${present.map((p) => `~/${p}`).join(', ')}, which Cursor may import; set CURSOR_API_KEY to run the leg on its own HOME` });
  }
  return result(true, null, null, cliVersion);
}
