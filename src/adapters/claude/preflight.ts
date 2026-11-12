import type { FailureClass } from '../../config/vocab.js';
import { scrubEnv, type CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { CLAUDE_EFFORTS, CLAUDE_FLOOR, CLAUDE_MODELS, CLAUDE_TESTED_VERSIONS, claudeDecl, compareVersions } from './known.js';
import { CLAUDE_ENV_ALLOW, CLAUDE_ENV_SET, hasApiKey } from './launch.js';
import { claudeProjectsDir } from './records.js';

/*
 * Claude preflight (plan 4.3), with no model call: the binary and version, the login state, the model id
 * against the adapter's table, and the isolation question P2 measured: does the leg's settings-source set drop
 * installed-plugin tools while the subscription login still works?
 *
 *   - On a declared version where the measurement holds, the leg uses that set (and `--restricted`).
 *   - With ANTHROPIC_API_KEY the leg runs `--bare`, which drops plugins, user hooks and CLAUDE.md discovery.
 *   - Otherwise (an untested version, subscription login, plugins installed) preflight refuses and names the
 *     API-key route, so a plugin tool can never reach a leg.
 *
 * `claude auth status` reports login state; the adapter reads only the fields below and never the credentials.
 */

export const API_KEY_ROUTE =
  'set ANTHROPIC_API_KEY so Claude seats run with --bare (no plugins, user hooks or CLAUDE.md discovery), or use a tested claude version';

export interface ClaudePreflightOptions {
  bin: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  timeoutMs?: number | undefined;
}

export function parseClaudeVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

interface AuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  loginExpiresAt: string | null;
  projectsDirectory: string | null;
}

/** Reads only the login-state fields of `claude auth status --json`; email and org fields are ignored. */
export function parseAuthStatus(text: string): AuthStatus | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const s = (k: string): string | null => (typeof raw[k] === 'string' ? (raw[k] as string) : null);
    return {
      loggedIn: raw['loggedIn'] === true,
      authMethod: s('authMethod'),
      apiProvider: s('apiProvider'),
      loginExpiresAt: s('loginExpiresAt'),
      projectsDirectory: s('projectsDirectory'),
    };
  } catch {
    return null;
  }
}

export async function claudePreflight(o: Occupant, options: ClaudePreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const env = scrubEnv(options.env, CLAUDE_ENV_ALLOW, CLAUDE_ENV_SET);
  const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });
  const bare = hasApiKey(options.env);
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null, data: Record<string, unknown> = {}): Preflight => ({
    ok,
    backend: 'claude',
    cliVersion,
    enforcement: claudeDecl(cliVersion)?.enforcement ?? 'pending',
    checks,
    userOwned,
    failureClass,
    reason,
    data,
  });
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail });
  };

  if (!/^[A-Za-z0-9][A-Za-z0-9.[\]-]{0,99}$/.test(o.model)) {
    fail('occupant', `model "${o.model}" is not a claude model id`);
    return result(false, 'setup', 'bad model id', null);
  }
  if (o.effort === undefined || !(CLAUDE_EFFORTS as readonly string[]).includes(o.effort)) {
    const why = `claude seats need an effort, one of ${CLAUDE_EFFORTS.join(', ')} (effort is ratified per request)`;
    fail('occupant', why);
    return result(false, 'setup', why, null);
  }

  const version = await run(['--version']);
  if (version.error !== null || version.exitCode !== 0) {
    const why = version.error ?? `exit ${String(version.exitCode)}`;
    fail('binary', `${options.bin} --version failed: ${why}`);
    return result(false, 'setup', `claude binary not usable: ${why}`, null);
  }
  const cliVersion = parseClaudeVersion(version.stdout);
  if (cliVersion === null || compareVersions(cliVersion, CLAUDE_FLOOR) < 0) {
    fail('version', `claude ${String(cliVersion)} is below the floor ${CLAUDE_FLOOR}`);
    return result(false, 'setup', `claude ${String(cliVersion)} is below the tested floor`, cliVersion);
  }
  const decl = claudeDecl(cliVersion);
  checks.push(
    decl
      ? { name: 'version', status: 'ok', detail: `claude ${cliVersion} (tested)` }
      : { name: 'version', status: 'warn', detail: `claude ${cliVersion} is outside the tested versions (${CLAUDE_TESTED_VERSIONS.join(', ')})` },
  );

  const auth = await run(['auth', 'status', '--json']);
  const status = parseAuthStatus(auth.stdout);
  const thirdParty = status?.apiProvider !== null && status?.apiProvider !== undefined && status.apiProvider !== 'firstParty';
  if (bare) {
    checks.push({ name: 'auth', status: 'ok', detail: 'ANTHROPIC_API_KEY is set: the leg runs --bare' });
  } else if (status?.loggedIn || thirdParty) {
    const expires = status?.loginExpiresAt ? Date.parse(status.loginExpiresAt) : NaN;
    if (Number.isFinite(expires) && expires < Date.now()) {
      fail('auth', `the claude login expired at ${status?.loginExpiresAt ?? '?'}; run \`claude auth login\``);
      return result(false, 'auth', 'claude login expired', cliVersion);
    }
    checks.push({ name: 'auth', status: 'ok', detail: `logged in (${status?.authMethod ?? status?.apiProvider ?? 'unknown method'})` });
  } else {
    fail('auth', 'claude is not logged in and ANTHROPIC_API_KEY is not set; run `claude auth login`');
    return result(false, 'auth', 'claude is not logged in', cliVersion);
  }

  if (!CLAUDE_MODELS.includes(o.model)) {
    fail('model', `${o.model} is not in the adapter's model table (claude has no offline model list)`);
    return result(false, 'model', `model ${o.model} is not a known claude model id`, cliVersion);
  }
  checks.push({ name: 'model', status: 'ok', detail: `${o.model} in the adapter's model table; the record is the binding proof` });

  // Isolation: the settings-source measurement, or the API-key route, or a refusal.
  if (bare) {
    checks.push({ name: 'isolation', status: 'ok', detail: '--bare drops installed plugins, user hooks and CLAUDE.md discovery' });
  } else if (decl?.dropsPluginTools) {
    checks.push({
      name: 'isolation',
      status: 'ok',
      detail: `--setting-sources "${decl.settingSources}" with --restricted drops installed-plugin tools and user hooks on ${cliVersion} (measured); the leg's system/init is the binding proof`,
    });
  } else {
    const plugins = await run(['plugin', 'list', '--json']);
    let enabled: string[] = [];
    let readable = true;
    try {
      const list: unknown = JSON.parse(plugins.stdout);
      if (!Array.isArray(list)) throw new Error('not a list');
      enabled = list
        .filter((p) => (p as { enabled?: unknown }).enabled === true)
        .map((p) => String((p as { id?: unknown }).id ?? '?'));
    } catch {
      readable = false;
    }
    if (!readable || enabled.length > 0) {
      const why = readable
        ? `installed plugins (${enabled.join(', ')}) can add tools to a subscription leg on untested claude ${cliVersion}`
        : `cannot list installed plugins on untested claude ${cliVersion}`;
      fail('isolation', `${why}; ${API_KEY_ROUTE}`);
      return result(false, 'setup', `${why}; ${API_KEY_ROUTE}`, cliVersion);
    }
    checks.push({ name: 'isolation', status: 'ok', detail: 'no installed plugin is enabled' });
  }
  if (!bare) {
    // Measured on 2.1.322 with the leg's flags: no CLAUDE.md attachment and no user hook ran. Managed (policy)
    // settings are outside every settings source and still apply.
    userOwned.push('managed (policy) settings always apply');
    checks.push({ name: 'user-owned', status: 'note', detail: 'managed (policy) settings apply to every leg; user settings, hooks and CLAUDE.md did not load (measured)' });
  }

  return result(true, null, null, cliVersion, {
    bare,
    projectsDir: status?.projectsDirectory ?? claudeProjectsDir(options.env),
  });
}
