import { existsSync, readdirSync } from 'node:fs';
import type { FailureClass } from '../../config/vocab.js';
import type { CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { MUSE_EFFORTS, MUSE_FLOOR, MUSE_MODELS, MUSE_TESTED_VERSIONS, compareVersions, museDecl } from './known.js';
import { hasMetaKey, museEnv, museLegFiles, prepareMuseDirs, userMuseAuthPath } from './launch.js';

/*
 * Muse preflight (plan 4.3), with no model call:
 *   - the occupant: a declared model (never a contributor variant) and an effort the Meta provider takes;
 *   - `muse --version`, the floor 1.4.15;
 *   - the sign-in: `META_API_KEY` (pay-as-you-go; it hides a stored login session, and doctor says so), else
 *     `muse usage` on the leg's environment must not report "not logged in";
 *   - the root holds none of the files muse loads from a workspace (`.muse/`, `.agents/` incl. the committed
 *     memory that loads even untrusted, `.claude/`, `.codex/`, `.mcp.json`, `AGENTS.md`, `CLAUDE.md`);
 *   - the leg's settings are the council's own (`{"schema_version": 1}` under the leg's XDG config dir).
 * Muse has no offline isolation dump, so the label stays `weak` (plan 5.2).
 */

export interface MusePreflightOptions {
  bin: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  legDir: string;
  timeoutMs?: number | undefined;
}

export function parseMuseVersion(text: string): string | null {
  return /Muse Code (\d+\.\d+\.\d+)/.exec(text)?.[1] ?? /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

const ROOT_AGENT_CONFIG = /^(?:\.muse|\.agents|\.claude|\.codex|\.mcp\.json|AGENTS.*\.md|CLAUDE\.md)$/i;

export async function musePreflight(o: Occupant, options: MusePreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const files = museLegFiles(options.legDir);
  const apiKey = hasMetaKey(options.env);
  const credential = apiKey ? 'META_API_KEY (pay-as-you-go)' : 'muse login session';
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null): Preflight => ({
    ok,
    backend: 'muse',
    cliVersion,
    enforcement: museDecl(cliVersion)?.enforcement ?? 'weak',
    checks,
    userOwned,
    failureClass,
    reason,
    data: { credential, loaded: [] },
  });
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail });
  };

  if (/-contributor$/.test(o.model)) {
    fail('occupant', `${o.model} is a contributor-mode model; council seats run with contributor mode off`);
    return result(false, 'setup', 'contributor model', null);
  }
  if (!MUSE_MODELS.some((m) => m.id === o.model)) {
    fail('model', `${o.model} is not a declared muse model (${MUSE_MODELS.map((m) => m.id).join(', ')})`);
    return result(false, 'model', `model ${o.model} not declared`, null);
  }
  if (o.effort === undefined || !(MUSE_EFFORTS as readonly string[]).includes(o.effort)) {
    const why = `muse seats need an effort, one of ${MUSE_EFFORTS.join(', ')}`;
    fail('occupant', why);
    return result(false, 'setup', why, null);
  }
  prepareMuseDirs(files);
  const env = museEnv(options.env, files);
  const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });

  const version = await run(['--version']);
  if (version.error !== null || version.exitCode !== 0) {
    const why = version.error ?? `exit ${String(version.exitCode)}`;
    fail('binary', `${options.bin} --version failed: ${why}`);
    return result(false, 'setup', `muse binary not usable: ${why}`, null);
  }
  const cliVersion = parseMuseVersion(version.stdout);
  if (cliVersion === null || compareVersions(cliVersion, MUSE_FLOOR) < 0) {
    fail('version', `muse ${String(cliVersion)} is below the floor ${MUSE_FLOOR}`);
    return result(false, 'setup', `muse ${String(cliVersion)} is below the tested floor`, cliVersion);
  }
  checks.push(
    museDecl(cliVersion)
      ? { name: 'version', status: 'ok', detail: `muse ${cliVersion} (tested)` }
      : { name: 'version', status: 'warn', detail: `muse ${cliVersion} is outside the tested versions (${MUSE_TESTED_VERSIONS.join(', ')})` },
  );

  if (apiKey) {
    checks.push({ name: 'auth', status: 'warn', detail: 'META_API_KEY is set: it wins over a stored muse login and bills pay-as-you-go, not a subscription' });
  } else {
    const usage = await run(['usage']);
    const text = `${usage.stdout}\n${usage.stderr}`;
    if (/not logged in/i.test(text) || usage.exitCode !== 0) {
      fail('auth', `muse usage: ${text.trim().slice(0, 200) || `exit ${String(usage.exitCode)}`}; run \`muse login\`, or set META_API_KEY`);
      return result(false, 'auth', 'muse is not logged in', cliVersion);
    }
    checks.push({ name: 'auth', status: 'ok', detail: `muse login session (${userMuseAuthPath(options.env) ?? 'default store'})` });
  }
  checks.push({ name: 'model', status: 'ok', detail: `${o.model} / ${o.effort} (declared; muse has no offline model list, the record is the proof)` });

  const planted = existsSync(options.root) ? readdirSync(options.root).filter((n) => ROOT_AGENT_CONFIG.test(n)) : [];
  if (planted.length > 0) {
    fail('isolation', `the root holds files muse loads from a workspace, which the sanitizer should have moved: ${planted.join(', ')}`);
    return result(false, 'setup', 'root not sanitized', cliVersion);
  }
  checks.push({ name: 'isolation', status: 'note', detail: 'the leg runs on its own XDG config (settings schema_version 1 only) and data dirs, untrusted, with no foreign personal context; muse has no offline isolation dump (label weak)' });
  userOwned.push(credential);
  return result(true, null, null, cliVersion);
}
