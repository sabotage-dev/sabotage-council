import { realpathSync } from 'node:fs';
import type { FailureClass } from '../../config/vocab.js';
import { workspaceConfigIn } from '../../root/sanitize.js';
import type { CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { CURSOR_FLOOR, CURSOR_LABEL, CURSOR_MODEL_MAP, CURSOR_TESTED_VERSIONS, compareCursorVersions, parseCursorVersion } from './known.js';
import { cursorEnv, cursorLegFiles, cursorVersionsDir, hasCursorKey, prepareCursorConfig } from './launch.js';

/*
 * Cursor preflight (plan 4.3), with no model call:
 *   - the binary is an unpacked release under `~/.local/share/cursor-agent/versions/` (called by path), and its
 *     `--version` is a Cursor version (`YYYY.MM.DD-sha7`), not another vendor's `agent`;
 *   - the sign-in: `CURSOR_API_KEY` only. The keychain route is refused (round 2): it keeps the user's HOME, so the
 *     council hooks written to the leg HOME are never read, and no live run shows them loading another way;
 *   - the slug (effort is part of it) is in `models`;
 *   - the root holds none of the files Cursor loads from a trusted workspace (`.cursor/`, `.claude/`, `AGENTS.md`,
 *     `CLAUDE.md`, `.cursorignore`, `.mcp.json`): `--trust` is required headless and would load them;
 *   - the council config dir is written outside the root, and again to the leg HOME's `.cursor/`.
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

/**
 * What a trusted Cursor workspace loads, at any depth (the research: `.cursor/` rules, hooks, MCP and CLI config,
 * the legacy `.cursorrules`, `AGENTS.md` at the root and nested, `CLAUDE.md`, `.claude/`, `.cursorignore`,
 * `.mcp.json`). The root sanitizer moves or renames every one.
 */
export const CURSOR_WORKSPACE_CONFIG = /^(?:\.cursor|\.claude|AGENTS[\s\S]*\.md|CLAUDE\.md|\.cursorrules|\.cursorignore|\.mcp\.json)$/i;

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
  const declared = CURSOR_MODEL_MAP[o.model];
  if (declared === undefined) {
    fail('model', `${o.model} has no declared model_id and effort to ratify against (declared: ${Object.keys(CURSOR_MODEL_MAP).join(', ')})`);
    return result(false, 'model', `no declared model_id for ${o.model}`, null);
  }
  if (o.effort !== undefined && o.effort !== declared.effort) {
    fail('occupant', `Cursor encodes effort in the slug; ${o.model} is effort ${declared.effort}, not ${o.effort} (leave effort unset or pick the matching slug)`);
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

  // Round 2 (codex F2, claude F1): on the keychain route HOME stays the user's, so the council hooks written to the
  // leg HOME's .cursor are never read and every leg would fail its hook-log check. No live run shows the council
  // hooks loading there, so the route is refused until one does.
  if (!apiKey) {
    fail('auth', 'no live run shows the council hooks load on the keychain route (HOME stays yours, so the hooks in the leg HOME are never read); use CURSOR_API_KEY');
    return result(false, 'auth', 'keychain route refused: use CURSOR_API_KEY', cliVersion);
  }
  checks.push({ name: 'auth', status: 'ok', detail: 'CURSOR_API_KEY (the leg HOME is its own empty dir, holding the council config and hooks)' });
  const models = await run(['models']);
  const escaped = o.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(^|[\\s,(])${escaped}([\\s,)]|$)`, 'm').test(models.stdout)) {
    fail('model', `${o.model} is not in cursor-agent models`);
    return result(false, 'model', `model ${o.model} not offered`, cliVersion);
  }
  checks.push({ name: 'model', status: 'ok', detail: `${o.model} offered; the council hook's model_id is the binding proof` });

  const planted = workspaceConfigIn(options.root, CURSOR_WORKSPACE_CONFIG);
  if (planted.length > 0) {
    fail('isolation', `the root holds files a trusted workspace loads, which the sanitizer should have moved: ${planted.join(', ')}`);
    return result(false, 'setup', 'root not sanitized', cliVersion);
  }
  checks.push({ name: 'isolation', status: 'note', detail: `council config dir ${files.configDir} (deny rules, sandbox, the deny-all-but-reads hook), outside the root` });
  userOwned.push('CURSOR_API_KEY');
  return result(true, null, null, cliVersion);
}
