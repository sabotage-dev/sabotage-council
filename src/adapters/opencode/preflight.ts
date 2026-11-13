import { existsSync, readdirSync } from 'node:fs';
import type { FailureClass } from '../../config/vocab.js';
import type { CommandRunner } from '../../transport/headless.js';
import { isObject, str } from '../codex/records.js';
import { rootAliases, underRoot } from '../paths.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import {
  OPENCODE_AGENT,
  OPENCODE_DENIED_ACTIONS,
  OPENCODE_FLOOR,
  OPENCODE_READ_TOOLS,
  OPENCODE_TESTED_VERSIONS,
  compareVersions,
  evaluateRules,
  opencodeConfig,
  opencodeDecl,
  splitModel,
  type Rule,
} from './known.js';
import { opencodeEnv, opencodeLegFiles, prepareOpencodeDirs } from './launch.js';

/*
 * opencode preflight (plan 4.3), with no model call. Every command runs a private server (`--standalone`) on the
 * leg's own XDG dirs and database, from the root, with the leg's exact environment, so it also warms the leg's
 * database before the leg starts (concurrent cold starts on one database were a reported failure):
 *   - `--version`, the floor 2.2.7;
 *   - `debug config`: the configuration sources are exactly the leg's empty config dir and the council config
 *     document (no global, project, managed or extra file);
 *   - `debug agents`: the council agent's effective rules (opencode's defaults, then the council's; last match
 *     wins) deny every non-read action, `skill` and `external_directory` included, and allow read, glob and grep;
 *   - `models`: the pinned `provider/model` is offered (a provider with no credential lists no model);
 *   - `mcp list` and `plugin list`: none;
 *   - `auth list`: recorded (credentials come from provider environment variables only).
 */

export interface OpencodePreflightOptions {
  bin: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  legDir: string;
  timeoutMs?: number | undefined;
  /** The promotion canary's planted config; any makes the leg not the council's, and preflight refuses. */
  planted?: Record<string, unknown> | undefined;
}

export function parseOpencodeVersion(text: string): string | null {
  return /\bv?(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

/** `opencode models`: one `provider/model` per line. */
export function parseOpencodeModels(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[A-Za-z0-9][\w.-]*\/\S+$/.test(l));
}

/** Deterministic JSON: keys sorted at every level. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export interface ConfigSources {
  /** Every source other than the leg's config dir and the council document. */
  extra: string[];
  /** The council document is present and equal to the one the adapter passes. */
  councilDocument: boolean;
  /** Sources that come from the root (for `doctor --deep`). */
  fromRoot: string[];
  problem: string | null;
}

/** Reads `debug config` (a list of `{type: directory, path}` and `{type: document, info}` sources, at least). */
export function judgeConfigSources(text: string, configDir: string, root: string): ConfigSources {
  const out: ConfigSources = { extra: [], councilDocument: false, fromRoot: [], problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    out.problem = 'debug config did not print JSON';
    return out;
  }
  if (!Array.isArray(raw)) {
    out.problem = 'debug config printed no list';
    return out;
  }
  const want = canonical(opencodeConfig());
  const aliases = rootAliases(root);
  const ownDir = new Set([`${configDir}/opencode`, configDir].map((p) => p.replace(/\/+$/, '')));
  for (const s of raw) {
    const type = isObject(s) ? str(s['type']) : null;
    const path = isObject(s) ? str(s['path']) : null;
    if (type === 'directory' && path !== null && ownDir.has(path.replace(/\/+$/, ''))) continue;
    if (type === 'document' && isObject(s) && canonical(s['info']) === want && !out.councilDocument) {
      out.councilDocument = true;
      continue;
    }
    const name = path ?? `${String(type)} ${JSON.stringify(isObject(s) ? (s['info'] ?? s) : s).slice(0, 160)}`;
    out.extra.push(`${String(type)} ${name}`);
    if (path !== null && path.startsWith('/') && underRoot(path.replace(/\/+$/, ''), aliases)) out.fromRoot.push(`config ${path}`);
  }
  return out;
}

/** The council agent's rules from `debug agents`, judged action by action. */
export function judgeCouncilAgent(text: string): { found: boolean; problems: string[]; problem: string | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { found: false, problems: [], problem: 'debug agents did not print JSON' };
  }
  const agents = Array.isArray(raw) ? raw : [];
  const council = agents.find((a) => isObject(a) && str(a['id']) === OPENCODE_AGENT);
  if (!isObject(council)) return { found: false, problems: [], problem: `no ${OPENCODE_AGENT} agent in debug agents` };
  const rules: Rule[] = Array.isArray(council['permissions'])
    ? council['permissions'].filter(isObject).map((r) => ({ action: String(r['action']), resource: String(r['resource']), effect: String(r['effect']) }))
    : [];
  const problems: string[] = [];
  for (const action of OPENCODE_DENIED_ACTIONS) {
    const effect = evaluateRules(rules, action, '*');
    if (effect !== 'deny') problems.push(`${action} is ${effect}, not deny`);
  }
  for (const action of OPENCODE_READ_TOOLS) {
    const effect = evaluateRules(rules, action, '*');
    if (effect !== 'allow') problems.push(`${action} is ${effect}, not allow`);
  }
  return { found: true, problems, problem: null };
}

const ROOT_AGENT_CONFIG = /^(?:\.opencode|opencode\.jsonc?|AGENTS.*\.md|CONTEXT\.md|\.claude)$/i;

export async function opencodePreflight(o: Occupant, options: OpencodePreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const files = opencodeLegFiles(options.legDir);
  let loaded: string[] = [];
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null, data: Record<string, unknown> = {}): Preflight => ({
    ok,
    backend: 'opencode',
    cliVersion,
    enforcement: opencodeDecl(cliVersion)?.enforcement ?? 'pending',
    checks,
    userOwned,
    failureClass,
    reason,
    data: { db: files.db, loaded, ...data },
  });
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail });
  };

  const pin = splitModel(o.model);
  if (pin === null || !/^[\w.-]+\/[\w.:@/-]+$/.test(o.model)) {
    fail('occupant', `model "${o.model}" is not an opencode provider/model id`);
    return result(false, 'setup', 'bad model id', null);
  }
  if (o.effort !== undefined && !/^[\w.-]{1,32}$/.test(o.effort)) {
    fail('occupant', `effort "${o.effort}" is not an opencode variant name`);
    return result(false, 'setup', 'bad effort', null);
  }
  prepareOpencodeDirs(files, options.planted);
  const env = opencodeEnv(options.env, files, options.root, options.planted !== undefined);
  const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });

  const version = await run(['--version']);
  if (version.error !== null || version.exitCode !== 0) {
    const why = version.error ?? `exit ${String(version.exitCode)}`;
    fail('binary', `${options.bin} --version failed: ${why}`);
    return result(false, 'setup', `opencode binary not usable: ${why}`, null);
  }
  const cliVersion = parseOpencodeVersion(version.stdout);
  if (cliVersion === null || compareVersions(cliVersion, OPENCODE_FLOOR) < 0) {
    fail('version', `opencode ${String(cliVersion)} is below the floor ${OPENCODE_FLOOR} (V1 is not supported)`);
    return result(false, 'setup', `opencode ${String(cliVersion)} is below the tested floor`, cliVersion);
  }
  checks.push(
    opencodeDecl(cliVersion)
      ? { name: 'version', status: 'ok', detail: `opencode ${cliVersion} (tested)` }
      : { name: 'version', status: 'warn', detail: `opencode ${cliVersion} is outside the tested versions (${OPENCODE_TESTED_VERSIONS.join(', ')})` },
  );

  if (options.planted !== undefined) {
    fail('isolation', `a planted config is passed in OPENCODE_CONFIG (${files.planted}); a leg passes none`);
    return result(false, 'setup', 'planted config', cliVersion);
  }
  const planted = existsSync(options.root) ? readdirSync(options.root).filter((n) => ROOT_AGENT_CONFIG.test(n)) : [];
  if (planted.length > 0) {
    fail('isolation', `the root holds agent config the sanitizer should have moved: ${planted.join(', ')}`);
    return result(false, 'setup', 'root not sanitized', cliVersion);
  }

  const config = await run(['debug', 'config', '--standalone']);
  const sources = judgeConfigSources(config.stdout, files.config, options.root);
  loaded = sources.fromRoot;
  if (sources.problem !== null || !sources.councilDocument || sources.extra.length > 0) {
    const why = sources.problem ?? (!sources.councilDocument ? 'the council config document is not among the sources' : `configuration sources beyond the council config: ${sources.extra.join('; ')}`);
    fail('isolation', `${why} (exit ${String(config.exitCode)})`);
    return result(false, 'setup', why, cliVersion);
  }
  const agents = await run(['debug', 'agents', '--standalone']);
  const agent = judgeCouncilAgent(agents.stdout);
  if (agent.problem !== null || agent.problems.length > 0) {
    const why = agent.problem ?? `the council agent's effective rules: ${agent.problems.join('; ')}`;
    fail('isolation', why);
    return result(false, 'setup', why, cliVersion);
  }
  const mcp = await run(['mcp', 'list', '--standalone']);
  if (!/No MCP servers configured/i.test(mcp.stdout)) {
    fail('mcp', `opencode lists MCP servers: ${mcp.stdout.trim().slice(0, 300) || `exit ${String(mcp.exitCode)}`}`);
    return result(false, 'setup', 'MCP servers configured', cliVersion);
  }
  const plugins = await run(['plugin', 'list', '--standalone']);
  if (!/No plugins found/i.test(plugins.stdout)) {
    fail('plugins', `opencode lists plugins: ${plugins.stdout.trim().slice(0, 300) || `exit ${String(plugins.exitCode)}`}`);
    return result(false, 'setup', 'plugins configured', cliVersion);
  }
  checks.push({ name: 'isolation', status: 'ok', detail: 'config sources: the leg config dir and the council document only; council agent denies every non-read action (skill, external_directory included); no MCP server, no plugin' });

  const listed = await run(['models', '--standalone']);
  const models = parseOpencodeModels(listed.stdout);
  if (!models.includes(o.model)) {
    const sameProvider = models.some((m) => m.startsWith(`${pin.providerID}/`));
    if (!sameProvider && pin.providerID !== 'opencode') {
      fail('auth', `no ${pin.providerID} model is offered: set that provider's API key in the environment (legs never read saved opencode accounts)`);
      return result(false, 'auth', `no credential for ${pin.providerID}`, cliVersion);
    }
    fail('model', `${o.model} is not in opencode models (${models.length} listed)`);
    return result(false, 'model', `model ${o.model} not offered`, cliVersion);
  }
  checks.push({ name: 'model', status: 'ok', detail: `${o.model} offered${o.effort !== undefined ? `; effort ${o.effort} is set over ACP and refused there if the model has no such variant` : ''}` });
  const auth = await run(['auth', 'list', '--format', 'json']);
  checks.push({ name: 'auth', status: 'note', detail: `saved accounts in the leg database: ${auth.stdout.trim().slice(0, 120) || 'none'}; credentials come from provider environment variables` });
  userOwned.push('provider credentials from the environment');
  return result(true, null, null, cliVersion);
}
