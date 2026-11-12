import { existsSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { FailureClass } from '../../config/vocab.js';
import { sqlite } from '../../store/sqlite.js';
import type { CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { KIRO_EFFORTS, KIRO_FLOOR, KIRO_NO_EFFORT, KIRO_TESTED_VERSIONS, compareVersions, kiroDecl, profileHash } from './known.js';
import { KIRO_ENV_ALLOW, KIRO_KILL_ON, hasKiroKey, kiroHome, kiroTokenStore } from './launch.js';

/*
 * Kiro preflight (plan 4.3), with no model call and without risking the browser sign-in:
 *   - the HOME kiro-cli will use (`auth_home` or the user's), shown by `doctor`;
 *   - the token store under that HOME: only `expires_at` and whether a refresh token exists are read, never a
 *     value. No token and no `KIRO_API_KEY` = not signed in, and kiro-cli is not started;
 *   - `kiro-cli --version`, then `kiro-cli chat --list-models --format json` with stdin /dev/null and a short cap: it
 *     proves the sign-in (refreshing it once, serially, before parallel legs) and lists the account's models. A
 *     browser prompt in its output is an auth failure;
 *   - the agent profile hash, and an empty `KIRO_HOME` (created per leg: no steering, hooks or MCP config);
 *   - the root holds no `.kiro/` or `AGENTS*.md` the sanitizer should have moved.
 */

export interface KiroPreflightOptions {
  bin: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  timeoutMs?: number | undefined;
  platform?: NodeJS.Platform | undefined;
  /** The promotion canary's planted rules; any overlay makes the profile not the council's, and preflight refuses. */
  profileOverlay?: Record<string, unknown> | undefined;
}

export function parseKiroVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

export interface TokenState {
  present: boolean;
  expiresAt: string | null;
  expired: boolean | null;
  refreshToken: boolean;
  problem: string | null;
}

/**
 * Reads the login state from the token store: the `kirocli:odic:token` row's `expires_at` and whether its
 * `refresh_token` is non-empty. No value is returned or logged.
 */
export function readTokenState(storePath: string, now = Date.now()): TokenState {
  const none = (problem: string): TokenState => ({ present: false, expiresAt: null, expired: null, refreshToken: false, problem });
  if (!existsSync(storePath)) return none('no token store');
  let db: InstanceType<ReturnType<typeof sqlite>['DatabaseSync']> | null = null;
  try {
    db = new (sqlite().DatabaseSync)(storePath, { readOnly: true });
    const row = db.prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'").get() as { value?: unknown } | undefined;
    if (!row || typeof row.value !== 'string') return none('no sign-in token in the store');
    const token = JSON.parse(row.value) as Record<string, unknown>;
    const expiresAt = typeof token['expires_at'] === 'string' ? token['expires_at'] : null;
    const at = expiresAt !== null ? Date.parse(expiresAt) : NaN;
    const refresh = typeof token['refresh_token'] === 'string' && token['refresh_token'] !== '';
    return { present: true, expiresAt, expired: Number.isFinite(at) ? at <= now : null, refreshToken: refresh, problem: null };
  } catch (error) {
    return none(`token store unreadable: ${error instanceof Error ? error.message.split('\n')[0] : 'error'}`);
  } finally {
    db?.close();
  }
}

/** `chat --list-models --format json`: the model ids. */
export function parseKiroModels(text: string): string[] {
  try {
    const raw = JSON.parse(text) as { models?: Array<{ model_id?: unknown }> };
    return (raw.models ?? []).map((m) => m.model_id).filter((m): m is string => typeof m === 'string');
  } catch {
    return [];
  }
}

const ROOT_AGENT_CONFIG = /^(?:\.kiro|AGENTS.*\.md)$/i;

export async function kiroPreflight(o: Occupant, options: KiroPreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const apiKey = hasKiroKey(options.env);
  const home = kiroHome(o.authHome, options.env);
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null, data: Record<string, unknown> = {}): Preflight => ({
    ok,
    backend: 'kiro',
    cliVersion,
    enforcement: kiroDecl(cliVersion)?.enforcement ?? 'pending',
    checks,
    userOwned,
    failureClass,
    reason,
    data: { home, authHome: o.authHome ?? null, ...data },
  });
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail });
  };

  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(o.model) || o.model === 'auto') {
    fail('occupant', `model "${o.model}" is not a kiro model id a seat can pin (auto routes per request)`);
    return result(false, 'setup', 'bad model id', null);
  }
  const noEffort = KIRO_NO_EFFORT.includes(o.model);
  if (o.effort !== undefined && (noEffort || !(KIRO_EFFORTS as readonly string[]).includes(o.effort))) {
    const why = noEffort ? `${o.model} offers no effort levels; leave effort unset` : `kiro effort is one of ${KIRO_EFFORTS.join(', ')}`;
    fail('occupant', why);
    return result(false, 'setup', why, null);
  }

  if (home === null || !isAbsolute(home) || !existsSync(home) || !statSync(home).isDirectory()) {
    fail('home', `the HOME for kiro-cli (${String(home)}) is not an existing absolute directory`);
    return result(false, 'setup', 'no usable HOME for kiro-cli', null);
  }
  checks.push({ name: 'home', status: 'ok', detail: o.authHome !== undefined ? `kiro-cli runs with HOME=${home} (the seat's auth_home)` : `kiro-cli runs with the user's HOME (${home})` });
  const env: Record<string, string> = {};
  for (const name of KIRO_ENV_ALLOW) {
    const value = options.env[name];
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, { HOME: home, NO_COLOR: '1', TERM: 'dumb' });

  const store = kiroTokenStore(home, options.platform);
  const token = readTokenState(store);
  if (!apiKey) {
    if (!token.present) {
      fail('auth', `Not logged in (${token.problem ?? 'no token'} under ${home}); run \`kiro-cli login\` with HOME=${home}, or set KIRO_API_KEY`);
      return result(false, 'auth', 'kiro is not signed in under this HOME', null);
    }
    if (token.expired === true && !token.refreshToken) {
      fail('auth', `the kiro sign-in expired at ${String(token.expiresAt)} and holds no refresh token; run \`kiro-cli login\` with HOME=${home}`);
      return result(false, 'auth', 'kiro sign-in expired', null);
    }
  }
  checks.push({
    name: 'token',
    status: 'ok',
    detail: apiKey ? 'KIRO_API_KEY is set' : `token store present; expires ${String(token.expiresAt)}${token.expired ? ' (expired, refresh token present)' : ''}; values not read`,
  });

  const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });
  const version = await run(['--version']);
  if (version.error !== null || version.exitCode !== 0) {
    const why = version.error ?? `exit ${String(version.exitCode)}`;
    fail('binary', `${options.bin} --version failed: ${why}`);
    return result(false, 'setup', `kiro-cli not usable: ${why}`, null);
  }
  const cliVersion = parseKiroVersion(version.stdout);
  if (cliVersion === null || compareVersions(cliVersion, KIRO_FLOOR) < 0) {
    fail('version', `kiro-cli ${String(cliVersion)} is below the floor ${KIRO_FLOOR}`);
    return result(false, 'setup', `kiro-cli ${String(cliVersion)} is below the tested floor`, cliVersion);
  }
  const decl = kiroDecl(cliVersion);
  checks.push(
    decl
      ? { name: 'version', status: 'ok', detail: `kiro-cli ${cliVersion} (tested; engine ${decl.engine} pinned)` }
      : { name: 'version', status: 'warn', detail: `kiro-cli ${cliVersion} is outside the tested versions (${KIRO_TESTED_VERSIONS.join(', ')})` },
  );

  const listed = await run(['chat', '--list-models', '--format', 'json']);
  const text = `${listed.stdout}\n${listed.stderr}`;
  if (KIRO_KILL_ON.test(text) || /not logged in/i.test(text)) {
    fail('auth', `kiro-cli asked for a browser sign-in or reported no login; run \`kiro-cli login\` with HOME=${home}`);
    return result(false, 'auth', 'kiro sign-in needed', cliVersion);
  }
  if (/monthly request limit|limits reset on|enable overages/i.test(text)) {
    fail('quota', 'the kiro account reports its usage limit');
    return result(false, 'usage_limit', 'kiro usage limit', cliVersion);
  }
  const models = parseKiroModels(listed.stdout);
  if (listed.timedOut || models.length === 0) {
    fail('model', `chat --list-models gave no models (${listed.timedOut ? 'timed out' : `exit ${String(listed.exitCode)}`})`);
    return result(false, listed.timedOut ? 'auth' : 'setup', 'kiro model list failed', cliVersion);
  }
  if (!models.includes(o.model)) {
    fail('model', `${o.model} is not in this account's model list (${models.join(', ')})`);
    return result(false, 'model', `model ${o.model} not offered`, cliVersion);
  }
  checks.push({ name: 'model', status: 'ok', detail: `${o.model}${o.effort ? ` / ${o.effort}` : ''} in the account's model list` });

  if (options.profileOverlay !== undefined && Object.keys(options.profileOverlay).length > 0) {
    const keys = Object.keys(options.profileOverlay).join(', ');
    fail('isolation', `the agent profile is not the council profile (overlaid: ${keys}); a rule there could approve a tool with no permission request`);
    return result(false, 'setup', `agent profile overlaid (${keys})`, cliVersion);
  }
  const planted = existsSync(options.root) ? readdirSync(options.root).filter((n) => ROOT_AGENT_CONFIG.test(n)) : [];
  if (planted.length > 0) {
    fail('isolation', `the root holds agent config the sanitizer should have moved: ${planted.join(', ')}`);
    return result(false, 'setup', 'root not sanitized', cliVersion);
  }
  checks.push({
    name: 'isolation',
    status: 'ok',
    detail: `agent profile sha256 ${profileHash(o.model).slice(0, 16)}; KIRO_HOME is the leg's own dir (no steering, hooks, MCP config or other agents)`,
  });
  userOwned.push(`the kiro sign-in under ${home}`);
  return result(true, null, null, cliVersion, { profileHash: profileHash(o.model), engine: decl?.engine ?? 'v2' });
}
