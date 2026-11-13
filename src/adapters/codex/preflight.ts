import type { FailureClass } from '../../config/vocab.js';
import { scrubEnv, type CommandRunner } from '../../transport/headless.js';
import type { Occupant, Preflight, PreflightCheck } from '../types.js';
import { CODEX_ENV_ALLOW, CODEX_ENV_SET, codexConfigFlags, codexHomeOf, MCP_NAME, validateCodexOccupant } from './launch.js';
import { codexDecl } from './native.js';

/*
 * Codex preflight (plan 4.3), with no model call:
 *   1. the binary and its version, which must have a declared native list (4.5);
 *   2. `codex login status` (or CODEX_API_KEY);
 *   3. `codex debug models` lists the model, and its effort;
 *   4. `codex mcp list --json` names every configured MCP server, so the leg can disable each by name (N12);
 *   5. `codex debug prompt-input` with the leg's exact -c/--disable flags, run from the root, offers only the
 *      declared names, no MCP tool and no repository instructions. The global AGENTS.md is user-owned.
 */

export interface CodexPreflightOptions {
  bin: string;
  runner: CommandRunner;
  env: NodeJS.ProcessEnv;
  root: string;
  timeoutMs?: number | undefined;
}

export function parseCodexVersion(text: string): string | null {
  const m = /codex(?:-cli)?\s+v?(\d+\.\d+\.\d+)/i.exec(text) ?? /\b(\d+\.\d+\.\d+)\b/.exec(text);
  return m?.[1] ?? null;
}

interface ToolNode {
  type?: unknown;
  name?: unknown;
  tools?: unknown;
}

/** Offered tool names in a prompt-input render: namespaces and `namespace.tool`, as the rollout lists them. */
export function promptInputTools(items: unknown): string[] {
  const names: string[] = [];
  const walk = (tools: unknown, prefix: string): void => {
    if (!Array.isArray(tools)) return;
    for (const raw of tools) {
      const tool = raw as ToolNode;
      if (typeof tool.name !== 'string') continue;
      const full = prefix === '' ? tool.name : `${prefix}.${tool.name}`;
      names.push(full);
      walk(tool.tools, full);
    }
  };
  if (Array.isArray(items)) {
    for (const item of items) {
      const it = item as { type?: unknown; tools?: unknown };
      if (it.type === 'additional_tools') walk(it.tools, '');
    }
  }
  return names.sort();
}

/** Every text part of the rendered messages. */
export function promptInputTexts(items: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const text = (part as { text?: unknown }).text;
      if (typeof text === 'string') out.push(text);
    }
  }
  return out;
}

/**
 * The nested tools the exec script can call, from the `### \`name\`` headings of the exec tool's description
 * (measured on 0.167.0). Null when the render has no exec tool.
 */
export function execNestedTools(items: unknown): string[] | null {
  let found: string[] | null = null;
  const walk = (tools: unknown, prefix: string): void => {
    if (!Array.isArray(tools)) return;
    for (const raw of tools) {
      const tool = raw as ToolNode & { description?: unknown };
      if (typeof tool.name !== 'string') continue;
      const full = prefix === '' ? tool.name : `${prefix}.${tool.name}`;
      if (full === 'functions.exec' && typeof tool.description === 'string') {
        found = [...tool.description.matchAll(/^### `([^`]+)`/gm)].map((m) => m[1] as string).sort();
      }
      walk(tool.tools, full);
    }
  };
  if (Array.isArray(items)) {
    for (const item of items) {
      const it = item as { type?: unknown; tools?: unknown };
      if (it.type === 'additional_tools') walk(it.tools, '');
    }
  }
  return found;
}

export interface PromptInputVerdict {
  offered: string[];
  /** Nested exec tools in the render; null when the exec description could not be read. */
  nested: string[] | null;
  /** Nested exec tools the adapter does not declare. */
  undeclaredNested: string[];
  undeclared: string[];
  mcpTools: string[];
  deferredNamespaces: boolean;
  repoInstructions: boolean;
  globalAgentsMd: boolean;
}

/** Judges a prompt-input render against the declared native list (plan 4.3). */
export function judgePromptInput(items: unknown, nativeOffer: readonly string[], declaredNested: readonly string[] = []): PromptInputVerdict {
  const offered = promptInputTools(items);
  const texts = promptInputTexts(items);
  const nested = execNestedTools(items);
  return {
    offered,
    nested,
    undeclaredNested: (nested ?? []).filter((n) => !declaredNested.includes(n)),
    undeclared: offered.filter((n) => !nativeOffer.includes(n)),
    mcpTools: offered.filter((n) => /(^|\.)mcp__/.test(n)),
    deferredNamespaces: texts.some((t) => t.includes('Deferred tool namespaces')),
    // Project instructions render as "# AGENTS.md instructions for <dir>" (measured on 0.167.0); the global
    // file renders without a directory.
    repoInstructions: texts.some((t) => /AGENTS\.md instructions for /.test(t)),
    globalAgentsMd: texts.some((t) => /^# AGENTS\.md instructions\s*$/m.test(t)),
  };
}

function fail(checks: PreflightCheck[], name: string, detail: string): void {
  checks.push({ name, status: 'fail', detail });
}

export async function codexPreflight(o: Occupant, options: CodexPreflightOptions): Promise<Preflight> {
  const checks: PreflightCheck[] = [];
  const userOwned: string[] = [];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const env = scrubEnv(options.env, CODEX_ENV_ALLOW, CODEX_ENV_SET);
  const run = (args: readonly string[]) => options.runner(options.bin, args, { cwd: options.root, env, timeoutMs });
  const result = (
    ok: boolean,
    failureClass: FailureClass | null,
    reason: string | null,
    cliVersion: string | null,
    data: Record<string, unknown> = {},
  ): Preflight => ({
    ok,
    backend: 'codex',
    cliVersion,
    enforcement: codexDecl(cliVersion) ? 'sandboxed-exec' : 'pending',
    checks,
    userOwned,
    failureClass,
    reason,
    data,
  });

  const occupantProblem = validateCodexOccupant(o.model, o.effort);
  if (occupantProblem) {
    fail(checks, 'occupant', occupantProblem);
    return result(false, 'setup', occupantProblem, null);
  }
  const effort = o.effort as string;

  const version = await run(['--version']);
  if (version.error !== null || version.exitCode !== 0) {
    const why = version.error ?? `exit ${String(version.exitCode)}: ${version.stderr.trim().slice(0, 200)}`;
    fail(checks, 'binary', `${options.bin} --version failed: ${why}`);
    return result(false, 'setup', `codex binary not usable: ${why}`, null);
  }
  const cliVersion = parseCodexVersion(version.stdout + version.stderr);
  const decl = codexDecl(cliVersion);
  if (!decl) {
    fail(checks, 'version', `codex ${String(cliVersion)} has no declared native tool list; tested: 0.167.0`);
    return result(false, 'setup', `codex ${String(cliVersion)} is not a tested version (no declared native list, plan 4.5)`, cliVersion);
  }
  checks.push({ name: 'version', status: 'ok', detail: `codex ${cliVersion} (declared native list of ${decl.nativeOffer.length} names)` });

  const login = await run(['login', 'status']);
  const loginText = `${login.stdout}\n${login.stderr}`.trim();
  const apiKey = (options.env['CODEX_API_KEY'] ?? '') !== '';
  if (login.exitCode === 0 && /logged in/i.test(loginText)) {
    checks.push({ name: 'auth', status: 'ok', detail: loginText.split('\n')[0] ?? 'logged in' });
  } else if (apiKey) {
    checks.push({ name: 'auth', status: 'ok', detail: 'CODEX_API_KEY is set (API-key route)' });
  } else {
    fail(checks, 'auth', `codex login status: ${loginText.slice(0, 200) || `exit ${String(login.exitCode)}`}; run \`codex login\``);
    return result(false, 'auth', 'codex is not logged in', cliVersion);
  }

  const models = await run(['debug', 'models']);
  let slugs: Array<{ slug: string; efforts: string[] }> = [];
  try {
    const parsed = JSON.parse(models.stdout) as { models?: unknown };
    const list = Array.isArray(parsed.models) ? parsed.models : [];
    slugs = list.map((m) => {
      const model = m as { slug?: unknown; supported_reasoning_levels?: unknown };
      const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
      return {
        slug: typeof model.slug === 'string' ? model.slug : '',
        efforts: levels
          .map((l) => (typeof l === 'string' ? l : typeof (l as { effort?: unknown }).effort === 'string' ? (l as { effort: string }).effort : ''))
          .filter((e) => e !== ''),
      };
    });
  } catch {
    fail(checks, 'model', `codex debug models did not print JSON (exit ${String(models.exitCode)})`);
    return result(false, 'setup', 'cannot read the codex model list', cliVersion);
  }
  const model = slugs.find((m) => m.slug === o.model);
  if (!model) {
    fail(checks, 'model', `codex debug models does not list ${o.model}`);
    return result(false, 'model', `model ${o.model} is not in the codex model list`, cliVersion);
  }
  if (model.efforts.length > 0 && !model.efforts.includes(effort)) {
    fail(checks, 'effort', `${o.model} supports ${model.efforts.join(', ')}, not ${effort}`);
    return result(false, 'model', `effort ${effort} is not supported by ${o.model}`, cliVersion);
  }
  checks.push({ name: 'model', status: 'ok', detail: `${o.model} listed by codex debug models; effort ${effort}` });

  // N12: MCP server names come from `codex mcp list --json`, which reads the effective config.
  const mcp = await run(['mcp', 'list', '--json']);
  let mcpNames: string[];
  try {
    const parsed: unknown = JSON.parse(mcp.stdout);
    if (!Array.isArray(parsed)) throw new Error('not a list');
    mcpNames = parsed.map((s) => (s as { name?: unknown }).name).filter((n): n is string => typeof n === 'string');
  } catch {
    fail(checks, 'mcp', `codex mcp list --json did not print a JSON list (exit ${String(mcp.exitCode)})`);
    return result(false, 'setup', 'cannot enumerate the MCP servers to disable', cliVersion);
  }
  const badNames = mcpNames.filter((n) => !MCP_NAME.test(n));
  if (badNames.length > 0) {
    fail(checks, 'mcp', `MCP server name(s) cannot be disabled by a -c key: ${badNames.join(', ')}`);
    return result(false, 'setup', 'an MCP server name cannot be disabled by name', cliVersion);
  }
  checks.push({ name: 'mcp', status: 'ok', detail: `${mcpNames.length} MCP server(s) to disable by name: ${mcpNames.join(', ') || 'none'}` });

  // prompt-input takes no -m, so the model goes in as a config value; everything else is the leg's exact set.
  const flags = codexConfigFlags({ model: o.model, effort, mcpNames });
  const render = await run(['debug', 'prompt-input', '-c', `model="${o.model}"`, ...flags, 'x']);
  let items: unknown;
  try {
    items = JSON.parse(render.stdout);
  } catch {
    fail(checks, 'isolation', `codex debug prompt-input did not print JSON (exit ${String(render.exitCode)}): ${render.stderr.trim().slice(0, 200)}`);
    return result(false, 'setup', 'cannot render the leg prompt offline', cliVersion);
  }
  const verdict = judgePromptInput(items, decl.nativeOffer, Object.keys(decl.execNested));
  const problems: string[] = [];
  if (verdict.offered.length === 0) problems.push('no tools in the render');
  if (verdict.nested === null || verdict.nested.length === 0) problems.push('cannot read the nested tools of exec from the render');
  if (verdict.undeclaredNested.length > 0) problems.push(`exec offers undeclared nested tools: ${verdict.undeclaredNested.join(', ')}`);
  if (verdict.undeclared.length > 0) problems.push(`offered outside the declared list: ${verdict.undeclared.join(', ')}`);
  if (verdict.mcpTools.length > 0) problems.push(`MCP tools offered: ${verdict.mcpTools.join(', ')}`);
  if (verdict.deferredNamespaces) problems.push('a "Deferred tool namespaces" block (MCP) is in the prompt');
  if (verdict.repoInstructions) problems.push('repository AGENTS.md instructions load from the root');
  if (problems.length > 0) {
    fail(checks, 'isolation', problems.join('; '));
    // What the render shows loading from the root (for `doctor --deep`).
    const loaded = [...(verdict.repoInstructions ? ['repository AGENTS.md instructions'] : []), ...verdict.mcpTools.map((t) => `MCP tool ${t}`)];
    return result(false, 'setup', `the leg's config does not isolate: ${problems.join('; ')}`, cliVersion, { loaded });
  }
  checks.push({
    name: 'isolation',
    status: 'ok',
    detail: `prompt-input offers ${verdict.offered.length} declared names and ${verdict.nested?.length ?? 0} declared nested exec tools, no MCP tool, no repository instructions`,
  });
  if (verdict.globalAgentsMd) {
    const where = `${codexHomeOf(options.env)}/AGENTS.md`;
    userOwned.push(`global AGENTS.md (${where}) loads into every codex leg`);
    checks.push({ name: 'user-owned', status: 'note', detail: `global AGENTS.md loads (user-owned): ${where}` });
  }
  return result(true, null, null, cliVersion, { mcpNames, codexHome: codexHomeOf(options.env), effort });
}
