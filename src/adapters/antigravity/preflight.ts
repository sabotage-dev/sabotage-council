import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FailureClass } from '../../config/vocab.js';
import { scrubEnv, type CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { AGY_EFFORTS, AGY_FLOOR, AGY_TESTED_VERSIONS, agyDecl, agySlug, compareVersions, parseAgyModels } from './known.js';
import { AGY_ENV_ALLOW, AGY_ENV_SET, agyLegSettings, hasGeminiKey } from './launch.js';

/*
 * Antigravity preflight (plan 4.3), with no model call:
 *   - the binary and its version;
 *   - auth and quota: `agy -p "/usage" --output-format json` (a slash command the CLI answers itself: no turn, no
 *     quota, no conversation) gives SUCCESS and the quota groups; on the API-key route, `agy models` instead;
 *   - the model and effort against the account's own list (`agy models`);
 *   - the rules the leg will load: the leg's own settings file. A rule that allows anything, an auto-approving
 *     mode or tool permission, or access outside the workspace is refused, since it would let a tool run without
 *     a permission request.
 *   - the root holds no agent config the sanitizer should have moved (`.agents/`, `AGENTS.md`, `GEMINI.md`).
 */

export const AGY_API_KEY_NOTE =
  "Google's FAQ says wrapping agy on a consumer plan is not supported; the documented headless route is GEMINI_API_KEY (with modelProvider gemini in the leg's settings)";

export interface AgyPreflightOptions {
  bin: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  settingsOverlay?: Record<string, unknown> | undefined;
  timeoutMs?: number | undefined;
}

export function parseAgyVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

export interface QuotaGroup {
  name: string;
  description: string;
  remaining: number | null;
  reset: string | null;
}

/** Reads `/usage` JSON: status and the quota groups (names, remaining fraction, reset time). */
export function parseAgyUsage(text: string): { status: string | null; groups: QuotaGroup[] } | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const command = raw['command'] as { data?: { groups?: unknown } } | undefined;
    const groups = Array.isArray(command?.data?.groups) ? (command.data.groups as Array<Record<string, unknown>>) : [];
    return {
      status: typeof raw['status'] === 'string' ? raw['status'] : null,
      groups: groups.map((g) => {
        const buckets = Array.isArray(g['buckets']) ? (g['buckets'] as Array<Record<string, unknown>>) : [];
        const fractions = buckets.map((b) => b['remaining_fraction']).filter((f): f is number => typeof f === 'number');
        return {
          name: String(g['name'] ?? ''),
          description: String(g['description'] ?? ''),
          remaining: fractions.length > 0 ? Math.min(...fractions) : null,
          reset: buckets.map((b) => b['reset_time']).find((r): r is string => typeof r === 'string') ?? null,
        };
      }),
    };
  } catch {
    return null;
  }
}

/** The quota group a model draws from: Gemini models, or the third-party group. */
export function quotaGroupFor(model: string, groups: readonly QuotaGroup[]): QuotaGroup | null {
  const gemini = model.startsWith('gemini');
  return groups.find((g) => (gemini ? /gemini/i.test(g.name) : /claude|gpt/i.test(g.name))) ?? null;
}

/**
 * The rules a leg would load from its settings, judged before launch. Any `allow` rule is refused (it could
 * auto-approve a write, a command, a fetch or an outside read with no permission request), and so is an
 * auto-approving mode or tool permission and access outside the workspace.
 */
export function agyRuleProblems(settings: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const permissions = settings['permissions'];
  if (permissions !== undefined) {
    if (typeof permissions !== 'object' || permissions === null) problems.push('permissions is not an object');
    else {
      const allow = (permissions as Record<string, unknown>)['allow'];
      if (allow !== undefined && (!Array.isArray(allow) || allow.length > 0)) problems.push(`permissions.allow holds ${JSON.stringify(allow)}`);
    }
  }
  const mode = settings['agentMode'];
  if (mode !== undefined && mode !== '' && mode !== 'default') problems.push(`agentMode is ${JSON.stringify(mode)}`);
  const tool = settings['toolPermission'];
  if (tool !== undefined && tool !== 'request-review') problems.push(`toolPermission is ${JSON.stringify(tool)}`);
  if (settings['allowNonWorkspaceAccess'] !== false) problems.push('allowNonWorkspaceAccess is not false');
  if (settings['dangerouslySkipPermissions'] !== undefined) problems.push('dangerouslySkipPermissions is set');
  return problems;
}

const ROOT_AGENT_CONFIG = ['.agents', 'AGENTS.md', 'GEMINI.md', '.gemini'];

export async function agyPreflight(o: Occupant, options: AgyPreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const env = scrubEnv(options.env, AGY_ENV_ALLOW, AGY_ENV_SET);
  const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });
  const apiKey = hasGeminiKey(options.env);
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null, data: Record<string, unknown> = {}): Preflight => ({
    ok,
    backend: 'antigravity',
    cliVersion,
    enforcement: agyDecl(cliVersion)?.enforcement ?? 'pending',
    checks,
    userOwned,
    failureClass,
    reason,
    data,
  });
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail });
  };

  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(o.model)) {
    fail('occupant', `model "${o.model}" is not an antigravity model id`);
    return result(false, 'setup', 'bad model id', null);
  }
  if (o.effort !== undefined && !(AGY_EFFORTS as readonly string[]).includes(o.effort)) {
    const why = `antigravity effort is a thinking level, one of ${AGY_EFFORTS.join(', ')}`;
    fail('occupant', why);
    return result(false, 'setup', why, null);
  }

  const version = await run(['--version']);
  if (version.error !== null || version.exitCode !== 0) {
    const why = version.error ?? `exit ${String(version.exitCode)}`;
    fail('binary', `${options.bin} --version failed: ${why}`);
    return result(false, 'setup', `agy binary not usable: ${why}`, null);
  }
  const cliVersion = parseAgyVersion(version.stdout);
  if (cliVersion === null || compareVersions(cliVersion, AGY_FLOOR) < 0) {
    fail('version', `agy ${String(cliVersion)} is below the floor ${AGY_FLOOR}`);
    return result(false, 'setup', `agy ${String(cliVersion)} is below the tested floor`, cliVersion);
  }
  checks.push(
    agyDecl(cliVersion)
      ? { name: 'version', status: 'ok', detail: `agy ${cliVersion} (tested)` }
      : { name: 'version', status: 'warn', detail: `agy ${cliVersion} is outside the tested versions (${AGY_TESTED_VERSIONS.join(', ')})` },
  );

  let quota: QuotaGroup[] = [];
  if (apiKey) {
    checks.push({ name: 'auth', status: 'ok', detail: 'GEMINI_API_KEY is set: the leg runs with modelProvider gemini (the documented headless route)' });
  } else {
    const usage = await run(['-p', '/usage', '--output-format', 'json']);
    const parsed = parseAgyUsage(usage.stdout);
    if (parsed === null || parsed.status !== 'SUCCESS') {
      const text = `${usage.stdout}\n${usage.stderr}`;
      const auth = /authentication required|authentication expired|log back in|verify your account|sign-in update needed/i.test(text);
      fail('auth', `agy /usage did not succeed (${parsed?.status ?? `exit ${String(usage.exitCode)}`}); sign in with \`agy\` interactively or set GEMINI_API_KEY`);
      return result(false, auth ? 'auth' : 'setup', 'agy is not signed in or /usage failed', cliVersion);
    }
    quota = parsed.groups;
    checks.push({ name: 'auth', status: 'ok', detail: `signed in (keyring); ${AGY_API_KEY_NOTE}` });
    userOwned.push('the keyring sign-in (shared with the user, not copied)');
  }

  const models = await run(['models']);
  const listed = parseAgyModels(models.stdout);
  if (models.exitCode !== 0 || listed.length === 0) {
    fail('model', `agy models listed nothing (exit ${String(models.exitCode)})`);
    return result(false, 'setup', 'agy models failed', cliVersion);
  }
  const slugs = listed.map((m) => m.slug);
  const slug = agySlug(o.model, o.effort, slugs);
  const effortSuffixed = slugs.some((s) => (AGY_EFFORTS as readonly string[]).some((e) => s === `${o.model}-${e}`));
  if (slug === null || (effortSuffixed && o.effort === undefined)) {
    const why = slug === null ? `${o.model}${o.effort ? ` at ${o.effort}` : ''} is not in this account's model list (${slugs.join(', ')})` : `${o.model} needs an effort (its slugs carry one)`;
    fail('model', why);
    return result(false, 'model', why, cliVersion);
  }
  const label = listed.find((m) => m.slug === slug)?.label ?? null;
  checks.push({ name: 'model', status: 'ok', detail: `${o.model}${o.effort ? ` / ${o.effort}` : ''} = ${slug} (${String(label)})` });

  const group = quotaGroupFor(o.model, quota);
  if (!apiKey) {
    if (group !== null && group.remaining !== null && group.remaining <= 0) {
      fail('quota', `the ${group.name} quota is used up until ${String(group.reset)}`);
      return result(false, 'usage_limit', `${group.name} quota used up`, cliVersion);
    }
    checks.push({ name: 'quota', status: 'ok', detail: group ? `${group.name}: ${Math.round((group.remaining ?? 0) * 100)}% left` : 'no quota group matched; the leg proceeds' });
  }

  const settings = agyLegSettings(apiKey, options.settingsOverlay);
  const problems = agyRuleProblems(settings);
  if (problems.length > 0) {
    fail('rules', `the leg's settings would let a tool run without a permission request: ${problems.join('; ')}`);
    return result(false, 'setup', `unsafe agy rules: ${problems.join('; ')}`, cliVersion);
  }
  checks.push({
    name: 'rules',
    status: 'ok',
    detail: "the leg's own settings (--gemini-dir in the leg dir) hold no allow rule; agy reads settings and MCP config from that dir, not ~/.gemini (measured); ~/.gemini instructions, skills, plugins and hooks are not measured",
  });
  const planted = ROOT_AGENT_CONFIG.filter((name) => existsSync(join(options.root, name)));
  if (planted.length > 0) {
    fail('isolation', `the root holds agent config the sanitizer should have moved: ${planted.join(', ')}`);
    return result(false, 'setup', 'root not sanitized', cliVersion);
  }
  checks.push({ name: 'isolation', status: 'note', detail: 'no preflight proof exists over ACP (plan 4.3); the update log and the leg records are the proof' });

  return result(true, null, null, cliVersion, { slug, label, apiKey, quota: group });
}

/** Reads a JSON settings file; null when it is missing or unreadable. */
export function readSettings(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
