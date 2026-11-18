import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { FailureClass } from '../../config/vocab.js';
import { sqlite } from '../../store/sqlite.js';
import type { CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import {
  KIRO_AGENT,
  KIRO_DECLARED,
  KIRO_EFFORTS,
  KIRO_FLOOR,
  KIRO_NO_EFFORT,
  KIRO_UPDATE_OFF_TEXT,
  KIRO_V3_AGENT_SHA256,
  KIRO_V3_AGENT_TEXT,
  KIRO_V3_FLOOR,
  compareVersions,
  kiroEngine,
  kiroEngineDecl,
  kiroSettingsText,
  profileHash,
} from './known.js';
import { KIRO_KILL_ON, hasKiroKey, kiroCredential, kiroEnvAllow, kiroHome, kiroTokenStore, writeAgentFile, writeKiroSettings } from './launch.js';

/*
 * Kiro preflight (plan 4.3, 4.6), with no model call and without risking the browser sign-in:
 *   - the engine (`engine`, default v3), the HOME kiro-cli will use (`auth_home` or the user's), shown by `doctor`;
 *   - the token store under that HOME: only `expires_at` and whether a refresh token exists are read, never a
 *     value. No token and no `KIRO_API_KEY` = not signed in, and kiro-cli is not started;
 *   - `kiro-cli --version`, then `kiro-cli chat --list-models --format json` with stdin /dev/null and a short cap: it
 *     proves the sign-in (refreshing it once, serially, before parallel legs) and lists the account's models. A
 *     browser prompt in its output is an auth failure. Both run on a scratch `KIRO_HOME`, never the user's settings:
 *     `--version` with only `app.disableAutoupdates: true` in its settings file (the version is not known yet), the
 *     model listing with the settings file declared for the version it reported (else the same one key). The scratch
 *     dir is removed after;
 *   - on v3, the version is at least the v3 floor (3.5.0): an older kiro-cli is refused with "update kiro-cli, or set
 *     engine = v2";
 *   - the agent file: on v2 the profile's hash (P3); on v3 the constant file written into the scratch `KIRO_HOME` and
 *     hashed on disk, which must be the declared bytes. The leg's own `KIRO_HOME` is created per leg (no steering,
 *     hooks or MCP config);
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
  /** The v3 promotion canary's planted permission preset; preflight refuses any. */
  presetPlant?: string | undefined;
  /** Where the scratch `KIRO_HOME` is made (default the OS temp dir). */
  scratchDir?: string | undefined;
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
 * The login state, computed inside SQLite: only the row's `expires_at` (when it is a string) and whether its
 * `refresh_token` is a non-empty string leave the query, so no token value ever reaches the engine. A value that is
 * not JSON fails `json_type` ("malformed JSON").
 */
const TOKEN_STATE_SQL = `SELECT
  typeof(value) = 'text' AS is_text,
  CASE WHEN typeof(value) <> 'text' THEN NULL
       WHEN json_type(value, '$.expires_at') = 'text' THEN json_extract(value, '$.expires_at') END AS expires_at,
  CASE WHEN typeof(value) <> 'text' THEN 0
       WHEN json_type(value, '$.refresh_token') = 'text' AND length(json_extract(value, '$.refresh_token')) > 0 THEN 1
       ELSE 0 END AS has_refresh
FROM auth_kv WHERE key = 'kirocli:odic:token'`;

/**
 * Reads the login state from the token store: the `kirocli:odic:token` row's `expires_at` and whether its
 * `refresh_token` is non-empty, selected in SQL (TOKEN_STATE_SQL). No token value is read, returned or logged.
 */
export function readTokenState(storePath: string, now = Date.now()): TokenState {
  const none = (problem: string): TokenState => ({ present: false, expiresAt: null, expired: null, refreshToken: false, problem });
  if (!existsSync(storePath)) return none('no token store');
  let db: InstanceType<ReturnType<typeof sqlite>['DatabaseSync']> | null = null;
  try {
    db = new (sqlite().DatabaseSync)(storePath, { readOnly: true });
    const row = db.prepare(TOKEN_STATE_SQL).get() as { is_text?: unknown; expires_at?: unknown; has_refresh?: unknown } | undefined;
    if (!row || row.is_text !== 1) return none('no sign-in token in the store');
    const expiresAt = typeof row.expires_at === 'string' ? row.expires_at : null;
    const at = expiresAt !== null ? Date.parse(expiresAt) : NaN;
    const refresh = row.has_refresh === 1;
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
  const engine = kiroEngine(o.engine);
  const credential = kiroCredential(o.authHome, options.env);
  const apiKey = credential === 'KIRO_API_KEY';
  const home = kiroHome(o.authHome, options.env);
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null, data: Record<string, unknown> = {}): Preflight => ({
    ok,
    backend: 'kiro',
    cliVersion,
    enforcement: kiroEngineDecl(cliVersion, engine)?.enforcement ?? 'pending',
    checks,
    userOwned,
    failureClass,
    reason,
    data: { home, authHome: o.authHome ?? null, credential, engine, ...data },
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
  for (const name of kiroEnvAllow(o.authHome)) {
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
    detail: apiKey
      ? 'credential: KIRO_API_KEY (no auth_home is set)'
      : `credential: the ${credential}${o.authHome !== undefined && hasKiroKey(options.env) ? ' (KIRO_API_KEY is set but not passed: auth_home wins)' : ''}; expires ${String(token.expiresAt)}${token.expired ? ' (expired, refresh token present)' : ''}; values not read`,
  });

  // Every kiro-cli command preflight runs gets a scratch KIRO_HOME of its own (4.6): never the user's settings, whose
  // default lets the CLI update itself on startup. Removed when preflight returns.
  const scratch = mkdtempSync(join(options.scratchDir ?? tmpdir(), 'sc-kiro-preflight-'));
  try {
    return await withScratch(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  async function withScratch(scratchHome: string): Promise<Preflight> {
    env['KIRO_HOME'] = scratchHome;
    const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });
    // The version is not known yet: the one key that stops an update on startup.
    writeKiroSettings(scratchHome, KIRO_UPDATE_OFF_TEXT);
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
    if (engine === 'v3' && compareVersions(cliVersion, KIRO_V3_FLOOR) < 0) {
      const why = `kiro-cli ${cliVersion} is below the v3 floor ${KIRO_V3_FLOOR}: update kiro-cli, or set engine = v2`;
      fail('version', why);
      return result(false, 'setup', why, cliVersion);
    }
    const decl = kiroEngineDecl(cliVersion, engine);
    const testedOn = Object.entries(KIRO_DECLARED)
      .filter(([, d]) => d.engines[engine] !== undefined)
      .map(([v]) => v);
    checks.push(
      decl
        ? { name: 'version', status: 'ok', detail: `kiro-cli ${cliVersion} (tested on the ${engine} engine)` }
        : { name: 'version', status: 'warn', detail: `kiro-cli ${cliVersion} is outside the versions tested on the ${engine} engine (${testedOn.join(', ')}); the same checks apply` },
    );

    // The model listing runs with the settings file declared for this version (else the same one key).
    const settings = kiroSettingsText(cliVersion);
    writeKiroSettings(scratchHome, settings ?? KIRO_UPDATE_OFF_TEXT);
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
    if (options.presetPlant !== undefined) {
      fail('isolation', "a permission preset is planted in the leg's KIRO_HOME; a preset there could approve a tool with no permission request");
      return result(false, 'setup', 'permission preset planted', cliVersion);
    }
    const planted = existsSync(options.root) ? readdirSync(options.root).filter((n) => ROOT_AGENT_CONFIG.test(n)) : [];
    if (planted.length > 0) {
      fail('isolation', `the root holds agent config the sanitizer should have moved: ${planted.join(', ')}`);
      return result(false, 'setup', 'root not sanitized', cliVersion);
    }
    // v3: the constant agent file, hashed on disk where it was written (never the generated text).
    const agentHash = engine === 'v3' ? writeAgentFile(join(scratchHome, 'agents', `${KIRO_AGENT}.json`), KIRO_V3_AGENT_TEXT) : null;
    if (agentHash !== null && agentHash !== KIRO_V3_AGENT_SHA256) {
      fail('isolation', `the v3 agent file reads back as sha256 ${agentHash.slice(0, 16)}, not the declared ${KIRO_V3_AGENT_SHA256.slice(0, 16)}`);
      return result(false, 'setup', 'v3 agent file hash', cliVersion);
    }
    const settingsNote = settings !== null ? `; legs on ${cliVersion} get settings/cli.json (${(kiroDeclKeys(cliVersion) ?? []).join(', ')})` : `; ${cliVersion} declares no leg settings file`;
    checks.push({
      name: 'isolation',
      status: 'ok',
      detail:
        engine === 'v3'
          ? `v3 agent file sha256 ${KIRO_V3_AGENT_SHA256.slice(0, 16)} (read back from disk); KIRO_HOME is the leg's own dir (no steering, hooks, MCP config or other agents)${settingsNote}; the session is gated before the prompt`
          : `agent profile sha256 ${profileHash(o.model).slice(0, 16)}; KIRO_HOME is the leg's own dir (no steering, hooks, MCP config or other agents)${settingsNote}`,
    });
    checks.push({ name: 'scratch', status: 'ok', detail: "preflight's kiro-cli commands ran on a scratch KIRO_HOME (removed after), never the user's settings" });
    userOwned.push(`the kiro sign-in under ${home}`);
    return result(true, null, null, cliVersion, engine === 'v3' ? { agentHash, settings: settings !== null } : { profileHash: profileHash(o.model), settings: settings !== null });
  }
}

function kiroDeclKeys(version: string): readonly string[] | null {
  return KIRO_DECLARED[version]?.settings ?? null;
}
