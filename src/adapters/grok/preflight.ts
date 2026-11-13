import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FailureClass } from '../../config/vocab.js';
import type { CommandRunner } from '../../transport/headless.js';
import { isObject, str } from '../codex/records.js';
import { rootAliases, underRoot } from '../paths.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { GROK_EFFORTS, GROK_FLOOR, GROK_TESTED_VERSIONS, compareVersions, grokDecl, grokLabel, type GrokSandbox } from './known.js';
import { grokEnv, grokLegFiles, legGrokHome, prepareGrokHomes } from './launch.js';

/*
 * Grok preflight (plan 4.3), with no model call:
 *   - the binary and version (`grok --version`), the floor 1.0.70;
 *   - the sign-in: `XAI_API_KEY` (an isolated grok home), else `grok models` under the leg's environment reports
 *     "logged in"; the pinned model is in that list, and the effort is in the model's menu (`models_cache.json`);
 *   - the sandbox: `read-only` refuses to start when `/var/run/docker.sock` is a symlink out of the deny list
 *     (Docker Desktop on macOS, measured on 1.0.70), so the seat must say `sandbox = "off"` there;
 *   - isolation: `grok inspect --json` from the root under the leg's environment lists no instructions, hooks,
 *     plugins, permission sources, MCP servers or project config layer. An MCP server listed there would start in
 *     the leg, and a leg that starts one fails (owner ruling), so preflight refuses it and names the servers.
 */

export interface GrokPreflightOptions {
  bin: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  legDir: string;
  timeoutMs?: number | undefined;
  /** The promotion canary's planted allow rules; any rule makes the leg not the council's, and preflight refuses. */
  allowRules?: readonly string[] | undefined;
  /** Where the docker socket lives (tests). Default `/var/run/docker.sock`. */
  dockerSocket?: string | undefined;
}

export function parseGrokVersion(text: string): string | null {
  return /\bgrok (\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

/** `grok models`: the login line and the model ids (`* grok-4.7 (default)`, `- grok-4.6`). */
export function parseGrokModels(text: string): { loggedIn: boolean; models: string[] } {
  const models: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*[*-]\s+([A-Za-z0-9][A-Za-z0-9.-]*)\b/.exec(line);
    if (m?.[1] !== undefined) models.push(m[1]);
  }
  return { loggedIn: /\blogged in\b/i.test(text) && !/not logged in/i.test(text), models };
}

/** The effort menu of a model in `models_cache.json` (`models` keyed by id, or a list), or null when unknown. */
export function grokEffortMenu(cacheText: string, model: string): string[] | null {
  try {
    const raw = JSON.parse(cacheText) as Record<string, unknown>;
    const models = raw['models'];
    const entries = Array.isArray(models) ? models : isObject(models) ? Object.values(models) : [];
    for (const entry of entries) {
      if (!isObject(entry)) continue;
      const info = isObject(entry['info']) ? entry['info'] : entry;
      if (str(info['id']) !== model) continue;
      const efforts = info['reasoning_efforts'];
      if (!Array.isArray(efforts)) return null;
      return efforts.map((e) => (isObject(e) ? str(e['id']) : str(e))).filter((e): e is string => e !== null);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether `--sandbox read-only` can start here: it refuses when the docker socket is a symlink (measured: Docker
 * Desktop's link to the user's home). Returns the link target when it is one.
 */
export function dockerSocketLink(path = '/var/run/docker.sock'): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

export interface GrokInspect {
  instructions: string[];
  hooks: string[];
  plugins: string[];
  permissionSources: string[];
  permissionRules: number;
  mcpServers: Array<{ name: string; source: string; path: string | null }>;
  projectLayers: string[];
  /** Items that come from the root (planted or project config), for `doctor --deep`. */
  fromRoot: string[];
  problem: string | null;
}

const label = (o: unknown): string => {
  if (!isObject(o)) return String(o);
  return str(o['path']) ?? str(o['name']) ?? str(o['target']) ?? JSON.stringify(o).slice(0, 120);
};

/** Reads the fields of `grok inspect --json` that the isolation proof needs. */
export function parseGrokInspect(text: string, root: string): GrokInspect {
  const out: GrokInspect = { instructions: [], hooks: [], plugins: [], permissionSources: [], permissionRules: 0, mcpServers: [], projectLayers: [], fromRoot: [], problem: null };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    out.problem = 'grok inspect --json did not print JSON';
    return out;
  }
  if (!isObject(raw)) {
    out.problem = 'grok inspect --json printed no object';
    return out;
  }
  const list = (k: string): unknown[] | null => (Array.isArray(raw[k]) ? (raw[k] as unknown[]) : null);
  const need = ['projectInstructions', 'hooks', 'plugins', 'mcpServers'];
  const missing = need.filter((k) => list(k) === null);
  const permissions = isObject(raw['permissions']) ? raw['permissions'] : null;
  if (missing.length > 0 || permissions === null) {
    out.problem = `grok inspect --json lacks ${[...missing, ...(permissions === null ? ['permissions'] : [])].join(', ')}`;
    return out;
  }
  const aliases = rootAliases(root);
  // A relative path is relative to the cwd, which is the root (round 1 row 7, grok F7).
  const inRoot = (p: string | null): boolean => p !== null && p !== '' && underRoot(resolve(root, p).replace(/\/+$/, ''), aliases);
  out.instructions = (list('projectInstructions') ?? []).map(label);
  out.hooks = (list('hooks') ?? []).map((h) => (isObject(h) ? `${str(h['event']) ?? '?'} ${label(h['source'])}` : String(h)));
  out.plugins = (list('plugins') ?? []).map(label);
  out.permissionSources = Array.isArray(permissions['sources']) ? permissions['sources'].map(String) : [];
  out.permissionRules = typeof permissions['loaded'] === 'number' ? permissions['loaded'] : 0;
  out.mcpServers = (list('mcpServers') ?? []).map((m) => {
    const source = isObject(m) && isObject(m['source']) ? m['source'] : {};
    return { name: isObject(m) ? (str(m['name']) ?? '?') : String(m), source: str(source['type']) ?? '?', path: str(source['path']) };
  });
  const layers = isObject(raw['configSources']) && Array.isArray(raw['configSources']['layers']) ? raw['configSources']['layers'] : [];
  out.projectLayers = layers.filter((l) => isObject(l) && str(l['role']) !== 'user').map(label);
  const instructionPaths = (list('projectInstructions') ?? []).map((i) => (isObject(i) ? str(i['path']) : null));
  out.fromRoot = [
    ...instructionPaths.filter(inRoot).map((p) => `instructions ${String(p)}`),
    ...(list('hooks') ?? []).filter((h) => isObject(h) && isObject(h['source']) && inRoot(str(h['source']['path']))).map((h) => `hook ${label((h as Record<string, unknown>)['source'])}`),
    ...out.mcpServers.filter((m) => inRoot(m.path)).map((m) => `MCP server ${m.name} (${String(m.path)})`),
    ...out.projectLayers.map((p) => `project config ${p}`),
    ...out.permissionSources.filter((s) => inRoot(s.split(' ')[0] ?? null)).map((s) => `permission rules ${s}`),
  ];
  return out;
}

export async function grokPreflight(o: Occupant, options: GrokPreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const sandbox: GrokSandbox = o.sandbox ?? 'read-only';
  const files = grokLegFiles(options.legDir);
  const { grokHome, route } = legGrokHome(options.env, files, o.authHome);
  let loaded: string[] = [];
  let dumped: string | null = null;
  let mcpListed = false;
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null, data: Record<string, unknown> = {}): Preflight => ({
    ok,
    backend: 'grok',
    cliVersion,
    enforcement: grokLabel(cliVersion, sandbox, mcpListed),
    checks,
    userOwned,
    failureClass,
    reason,
    data: { sandbox, route, grokHome, loaded, dumped, ...data },
  });
  const fail = (name: string, detail: string): void => {
    checks.push({ name, status: 'fail', detail });
  };

  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/.test(o.model)) {
    fail('occupant', `model "${o.model}" is not a grok model id`);
    return result(false, 'setup', 'bad model id', null);
  }
  if (o.effort === undefined || !(GROK_EFFORTS as readonly string[]).includes(o.effort)) {
    const why = `grok seats need an effort, one of ${GROK_EFFORTS.join(', ')} (effort is ratified from the session record)`;
    fail('occupant', why);
    return result(false, 'setup', why, null);
  }
  if (grokHome === null) {
    fail('home', 'no grok home: set GROK_HOME or HOME, or XAI_API_KEY');
    return result(false, 'auth', 'no grok home', null);
  }
  if (route === 'auth_home' && (!grokHome.startsWith('/') || !existsSync(grokHome) || !statSync(grokHome).isDirectory())) {
    fail('home', `the seat's auth_home ${grokHome} is not an existing absolute directory`);
    return result(false, 'setup', 'auth_home is not a directory', null);
  }
  checks.push({
    name: 'home',
    status: 'ok',
    detail:
      route === 'auth_home'
        ? `GROK_HOME=${grokHome} (the seat's auth_home: its own grok login and config; XAI_API_KEY is not passed)`
        : route === 'api-key'
          ? `GROK_HOME is the leg's own empty dir (XAI_API_KEY)`
          : `GROK_HOME=${grokHome} (the user's grok home)`,
  });
  prepareGrokHomes(files, route);
  const env = grokEnv(options.env, files.home, grokHome, route);
  const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });

  const version = await run(['--version']);
  if (version.error !== null || version.exitCode !== 0) {
    const why = version.error ?? `exit ${String(version.exitCode)}`;
    fail('binary', `${options.bin} --version failed: ${why}`);
    return result(false, 'setup', `grok binary not usable: ${why}`, null);
  }
  const cliVersion = parseGrokVersion(version.stdout);
  if (cliVersion === null || compareVersions(cliVersion, GROK_FLOOR) < 0) {
    fail('version', `grok ${String(cliVersion)} is below the floor ${GROK_FLOOR}`);
    return result(false, 'setup', `grok ${String(cliVersion)} is below the tested floor`, cliVersion);
  }
  checks.push(
    grokDecl(cliVersion)
      ? { name: 'version', status: 'ok', detail: `grok ${cliVersion} (tested)` }
      : { name: 'version', status: 'warn', detail: `grok ${cliVersion} is outside the tested versions (${GROK_TESTED_VERSIONS.join(', ')}); label weak` },
  );

  if (sandbox === 'read-only') {
    const link = dockerSocketLink(options.dockerSocket);
    if (link !== null) {
      fail('sandbox', `--sandbox read-only refuses to start here: ${options.dockerSocket ?? '/var/run/docker.sock'} is a symlink to ${link} (Docker Desktop); set sandbox = "off" on this seat (the read allowlist is then the only enforcement, label weak)`);
      return result(false, 'setup', 'grok read-only sandbox cannot start on this machine', cliVersion);
    }
    checks.push({ name: 'sandbox', status: 'ok', detail: '--sandbox read-only (no docker socket symlink in the way)' });
  } else {
    checks.push({ name: 'sandbox', status: 'warn', detail: '--sandbox off: the read allowlist is the only enforcement (label weak)' });
  }

  const listed = await run(['models']);
  const models = parseGrokModels(`${listed.stdout}\n${listed.stderr}`);
  if (route !== 'api-key' && !models.loggedIn) {
    const how = route === 'auth_home' ? `GROK_HOME=${grokHome} grok login` : '`grok login`, or set XAI_API_KEY';
    fail('auth', `grok models does not report a login in ${grokHome}; run ${how}`);
    return result(false, 'auth', 'grok is not logged in', cliVersion);
  }
  checks.push({ name: 'auth', status: 'ok', detail: route === 'api-key' ? 'XAI_API_KEY (the leg runs on its own empty grok home)' : `grok login in ${grokHome} (HOME isolated per leg)` });
  if (!models.models.includes(o.model)) {
    fail('model', `${o.model} is not in grok models (${models.models.join(', ') || 'none listed'})`);
    return result(false, 'model', `model ${o.model} not offered`, cliVersion);
  }
  const cachePath = `${grokHome}/models_cache.json`;
  const menu = existsSync(cachePath) ? grokEffortMenu(readFileSync(cachePath, 'utf8'), o.model) : null;
  if (menu !== null && !menu.includes(o.effort)) {
    fail('model', `${o.model} offers effort ${menu.join(', ')}, not ${o.effort}`);
    return result(false, 'model', `effort ${o.effort} not offered by ${o.model}`, cliVersion);
  }
  checks.push({ name: 'model', status: menu === null ? 'warn' : 'ok', detail: menu === null ? `${o.model} listed; its effort menu is not in models_cache.json (the record is the proof)` : `${o.model} / ${o.effort} offered` });

  if (options.allowRules !== undefined && options.allowRules.length > 0) {
    fail('isolation', `planted allow rules on the command line (${options.allowRules.join(', ')}); a leg passes none`);
    return result(false, 'setup', 'allow rules planted', cliVersion);
  }
  const inspected = await run(['inspect', '--json']);
  const inspect = parseGrokInspect(inspected.stdout, options.root);
  if (inspect.problem !== null) {
    fail('isolation', `${inspect.problem} (exit ${String(inspected.exitCode)})`);
    return result(false, 'setup', inspect.problem, cliVersion);
  }
  loaded = inspect.fromRoot;
  dumped = 'grok inspect --json: instructions, hooks, plugins, permission sources, MCP servers and config layers';
  mcpListed = inspect.mcpServers.length > 0;
  const problems = [
    ...(inspect.instructions.length > 0 ? [`instructions ${inspect.instructions.join(', ')}`] : []),
    ...(inspect.hooks.length > 0 ? [`hooks ${inspect.hooks.join(', ')}`] : []),
    ...(inspect.plugins.length > 0 ? [`plugins ${inspect.plugins.join(', ')}`] : []),
    ...(inspect.permissionSources.length > 0 || inspect.permissionRules > 0 ? [`permission rules from ${inspect.permissionSources.join(', ') || 'an unnamed source'}`] : []),
    ...(inspect.projectLayers.length > 0 ? [`project config ${inspect.projectLayers.join(', ')}`] : []),
  ];
  if (inspect.mcpServers.length > 0) {
    const names = inspect.mcpServers.map((m) => `${m.name} (${m.source}${m.path !== null ? ` ${m.path}` : ''})`).join(', ');
    const why = `MCP servers would start in the leg: ${names}. A leg that starts an MCP server fails (owner ruling); give the seat an auth_home (its own grok home, logged in once, with no MCP config), use XAI_API_KEY, or disable the servers in your grok config yourself`;
    fail('mcp', why);
    if (problems.length === 0) return result(false, 'setup', `MCP servers would start: ${inspect.mcpServers.map((m) => m.name).join(', ')}`, cliVersion);
  }
  if (problems.length > 0) {
    fail('isolation', `grok inspect lists ${problems.join('; ')}`);
    return result(false, 'setup', `grok would load ${problems.join('; ')}`, cliVersion);
  }
  checks.push({ name: 'isolation', status: 'ok', detail: 'grok inspect under the leg HOME lists no instructions, hooks, plugins, permission rules, MCP servers or project config' });
  userOwned.push(route === 'api-key' ? 'XAI_API_KEY (an isolated grok home)' : route === 'auth_home' ? `the seat's own grok login in ${grokHome} (auth_home)` : `the grok login in ${grokHome}`);
  return result(true, null, null, cliVersion);
}
