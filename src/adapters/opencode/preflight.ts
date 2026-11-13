import { resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { FailureClass } from '../../config/vocab.js';
import { workspaceConfigIn } from '../../root/sanitize.js';
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
  offeredTools,
  type Rule,
} from './known.js';
import { opencodeEnv, opencodeLegFiles, opencodeSkillDefinitions, prepareOpencodeDirs } from './launch.js';

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
    // A relative path is relative to the cwd, which is the root (round 1 row 7).
    if (path !== null && path !== '' && underRoot(resolve(root, path).replace(/\/+$/, ''), aliases)) out.fromRoot.push(`config ${path}`);
  }
  return out;
}

/** The council agent's rules from `debug agents`, judged action by action, and the tools it is offered. */
export function judgeCouncilAgent(text: string): { found: boolean; problems: string[]; problem: string | null; offered: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { found: false, problems: [], problem: 'debug agents did not print JSON', offered: [] };
  }
  const agents = Array.isArray(raw) ? raw : [];
  const council = agents.find((a) => isObject(a) && str(a['id']) === OPENCODE_AGENT);
  if (!isObject(council)) return { found: false, problems: [], problem: `no ${OPENCODE_AGENT} agent in debug agents`, offered: [] };
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
  return { found: true, problems, problem: null, offered: offeredTools(rules) };
}

const ROOT_AGENT_CONFIG = /^(?:\.opencode|opencode\.jsonc?|AGENTS.*\.md|CONTEXT\.md|\.claude|\.agents)$/i;

/**
 * The directories opencode reads skills from in a workspace (`.opencode/skill(s)`, `.claude/skills`,
 * `.agents/skills`, from the cwd up), checked at any depth (owner ruling, condition b). The root sanitizer moves
 * every one whole.
 */
export const OPENCODE_SKILL_ROOTS = /^(?:\.opencode|\.claude|\.agents)$/i;

export async function opencodePreflight(o: Occupant, options: OpencodePreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const files = opencodeLegFiles(options.legDir);
  let loaded: string[] = [];
  let offer: string[] | null = null;
  let skillsEmpty: boolean | null = null;
  let mcpServers: string[] | null = null;
  let dumped: string | null = null;
  const result = (ok: boolean, failureClass: FailureClass | null, reason: string | null, cliVersion: string | null, data: Record<string, unknown> = {}): Preflight => ({
    ok,
    backend: 'opencode',
    cliVersion,
    enforcement: opencodeDecl(cliVersion)?.enforcement ?? 'pending',
    checks,
    userOwned,
    failureClass,
    reason,
    data: { db: files.db, loaded, offer, skillsEmpty, mcp: mcpServers, dumped, ...data },
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
  // The load dump runs before the filename scan, so `doctor --deep` sees what opencode itself loads from a planted
  // root (a planted plugin that runs leaves a marker) rather than a refusal by filename (round 1 row 7).
  const config = await run(['debug', 'config', '--standalone']);
  const sources = judgeConfigSources(config.stdout, files.config, options.root);
  loaded = sources.fromRoot;
  if (sources.problem === null) dumped = 'opencode debug config: its config sources (instructions files are checked per leg from its database)';
  const planted = [
    ...(existsSync(options.root) ? readdirSync(options.root).filter((n) => ROOT_AGENT_CONFIG.test(n)) : []),
    ...workspaceConfigIn(options.root, OPENCODE_SKILL_ROOTS).filter((r) => r.includes('/')),
  ];
  if (planted.length > 0) {
    fail('isolation', `the root holds agent config the sanitizer should have moved: ${planted.join(', ')}`);
    return result(false, 'setup', 'root not sanitized', cliVersion, { refusedBy: 'root-scan' });
  }
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
  offer = agent.offered;
  // The leg must be offered only the read set (plan 4.2, grok F6). On 2.2.7 the skill tool always is: opencode
  // appends `skill browser deny` after the council's rules, so no council rule can remove the tool. Owner ruling
  // (2026-11-12): the offered skill tool is allowed only when provably empty: (a) no skill definition in the leg's
  // skill locations, (b) none in the root, at any depth; (c), no skill call or skill message, is ratification's.
  const legSkills = opencodeSkillDefinitions(files);
  const rootSkills = workspaceConfigIn(options.root, OPENCODE_SKILL_ROOTS);
  skillsEmpty = legSkills.length === 0 && rootSkills.length === 0;
  const allowed: readonly string[] = [...OPENCODE_READ_TOOLS, ...(skillsEmpty ? ['skill'] : [])];
  const extra = offer.filter((t) => !allowed.includes(t));
  if (extra.length > 0) {
    const skillWhy = !extra.includes('skill')
      ? ''
      : `; the skill tool stays offered (opencode appends \`skill browser deny\` after the council rules) and skill definitions exist: ${[...legSkills, ...rootSkills.map((r) => `${r} in the root`)].slice(0, 10).join(', ')}`;
    fail('offer', `the council agent is offered ${extra.join(', ')} beside the read set (computed from its effective rules)${skillWhy}`);
    return result(false, 'setup', `offered beyond the read set: ${extra.join(', ')}`, cliVersion);
  }
  if (offer.includes('skill')) {
    checks.push({
      name: 'offer',
      status: 'note',
      detail:
        "offered the read set and the skill tool, which is accepted as provably empty (owner ruling): no skill definition in the leg's skill locations or in the root; 2.2.7's built-in in-memory skills are removed by the council's skill.use policy and denied by its skill rule, and any skill call or skill message fails the leg",
    });
  }
  const mcp = await run(['mcp', 'list', '--standalone']);
  if (!/No MCP servers configured/i.test(mcp.stdout)) {
    mcpServers = mcp.stdout.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    fail('mcp', `opencode lists MCP servers: ${mcp.stdout.trim().slice(0, 300) || `exit ${String(mcp.exitCode)}`}`);
    return result(false, 'setup', 'MCP servers configured', cliVersion);
  }
  mcpServers = [];
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
  // No `auth list`: it takes no --standalone and starts a detached background service (measured on 2.2.7).
  checks.push({ name: 'auth', status: 'note', detail: 'credentials come from provider environment variables (the leg database holds no saved account)' });
  userOwned.push('provider credentials from the environment');
  return result(true, null, null, cliVersion);
}
