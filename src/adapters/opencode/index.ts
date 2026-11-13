import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, type CommandRunner } from '../../transport/headless.js';
import { createAcpAdapter, type AcpRecordResult } from '../acp/adapter.js';
import { collectPaths, isObject, judgePath, str, type ReadSet } from '../acp/policy.js';
import { rootAliases } from '../paths.js';
import { isRoot, type AcpCommonResult } from '../acp/ratify.js';
import type { LegHandle, Occupant, Preflight, RatificationCheck, RoundCtx, SeatAdapter } from '../types.js';
import { OPENCODE_AGENT, OPENCODE_FLOOR, OPENCODE_FREE_MODELS, OPENCODE_READ_TOOLS, OPENCODE_TESTED_VERSIONS, modelInfos, opencodeDecl, splitModel } from './known.js';
import { defaultOpencodeBin, opencodeEnv, opencodeLegFiles, opencodeSkillDefinitions, prepareOpencodeDirs } from './launch.js';
import { opencodePreflight, parseOpencodeModels } from './preflight.js';
import { modelRef, num, readOpencodeRecord } from './records.js';

export { OPENCODE_AGENT, OPENCODE_DECLARED, OPENCODE_DENIED_ACTIONS, OPENCODE_FREE_MODELS, OPENCODE_TOOL_ACTIONS, evaluateRules, familyOf, offeredTools, opencodeConfig, opencodeDecl, splitModel, whollyDisabled } from './known.js';
export { OPENCODE_ENV_ALLOW, OPENCODE_ENV_SET, defaultOpencodeBin, opencodeEnv, opencodeLegFiles, opencodeSkillDefinitions, opencodeSkillDirs } from './launch.js';
export { OPENCODE_SKILL_ROOTS, canonical, judgeConfigSources, judgeCouncilAgent, opencodePreflight, parseOpencodeModels, parseOpencodeVersion } from './preflight.js';
export { readOpencodeRecord } from './records.js';

/*
 * opencode failure signatures (plan 4.4), from stderr, ACP error responses (`data.errorName`, message) and non-JSON
 * stdout, never the answer. The structured `error.type` names are opencode's own (2.2.7 source).
 */
export const OPENCODE_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  { class: 'usage_limit', pattern: /provider\.(?:quota|chatgpt-limit|free-limit|budget-limit|model-budget-limit|go-limit)\b|Free usage limit reached|usage limit reached|Workspace usage limit/i },
  { class: 'auth', pattern: /provider\.auth\b|not logged in|requires a password|invalid api key|\bunauthori[sz]ed\b/i },
  { class: 'model', pattern: /provider\.no-route\b|Model unavailable|Invalid model reference|effort not found|model not found|InvalidModelError/i },
  { class: 'capacity', pattern: /provider\.rate-limit\b|rate limit|too many requests|overloaded/i },
  { class: 'timeout', pattern: /provider\.timeout\b/i },
  { class: 'transport', pattern: /provider\.transport\b|Can't reach|database is locked|SQLITE_BUSY|ECONNRESET|ECONNREFUSED|socket hang up/i },
  { class: 'setup', pattern: /unexpected argument|unknown option|InvalidConfigOptionError|mode not found/i },
];

export function classifyOpencodeText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of OPENCODE_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}

/**
 * opencode's own refusal of a call (its rules or policies): the call ends `failed` with `rawOutput.error`
 * `Permission denied: <action>` (2.2.7 `Permission.BlockedError`), or the documented policy text. The call was
 * stopped by the permission check, before the tool ran.
 */
const OPENCODE_DENIAL = /^(?:Permission denied: [A-Za-z0-9_.:*-]+|Blocked by configuration policy\.?)$/;

export function opencodeDenial(s: Record<string, unknown>): boolean {
  if (str(s['status']) !== 'failed') return false;
  const out = isObject(s['rawOutput']) ? str(s['rawOutput']['error']) : null;
  return out !== null && OPENCODE_DENIAL.test(out.trim());
}

/**
 * opencode's read tools (2.2.7): `read` (kind `read`; `filePath` or `path`), `glob` and `grep` (kind `search`; an
 * optional `path`, default the cwd). glob's `pattern` is a file glob; grep's `pattern` is a regex and its `include`
 * a file glob.
 */
export const OPENCODE_READS: ReadSet = {
  kinds: ['read', 'search'],
  names: OPENCODE_READ_TOOLS,
  nameOf: (s) => str(s['name']),
  cwdDefault: ['glob', 'grep'],
  denialNotice: opencodeDenial,
  args: {
    glob: { globs: ['pattern'] },
    grep: { text: ['pattern'], globs: ['include'] },
  },
};

const RECORD_CLASS: Readonly<Record<string, FailureClass>> = {
  'session-record': 'setup',
  'record-version': 'setup',
  'record-directory': 'contaminated',
  'record-agent': 'contaminated',
  'record-model': 'model',
  'record-effort': 'model',
  'record-tools': 'contaminated',
  'record-paths': 'contaminated',
  'record-calls': 'setup',
  offer: 'setup',
  'record-messages': 'contaminated',
  skill: 'contaminated',
  'record-children': 'contaminated',
  'record-instructions': 'contaminated',
  'record-outcome': 'transport',
};

/** Instruction entries that name a file opencode reads for instructions. */
const INSTRUCTION_FILE = /(?:^|[^A-Za-z0-9_])(?:AGENTS|CLAUDE|CONTEXT|GEMINI)\.md\b|\.opencode[/\\]|opencode\.jsonc?\b/i;

export function opencodeRecords(h: LegHandle, common: AcpCommonResult): AcpRecordResult {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const files = opencodeLegFiles(h.legDir);
  const rec = readOpencodeRecord(files.db, common.log.sessionId);
  const cliVersion = typeof h.data['cliVersion'] === 'string' ? h.data['cliVersion'] : null;
  const pin = splitModel(h.occupant.model);
  const effort = h.occupant.effort ?? null;
  const s = rec.session;
  check(
    'session-record',
    rec.problem === null && s !== null && rec.rootSessions === 1 && rec.assistants.length > 0,
    rec.problem !== null
      ? `${files.db}: ${rec.problem}`
      : s === null
        ? `no session_v2 row for ${String(common.log.sessionId)} (${rec.rootSessions} root session(s))`
        : `session ${String(s['id'])}: ${rec.assistants.length} assistant step(s)${rec.rootSessions !== 1 ? `; ${rec.rootSessions} root sessions in the leg database` : ''}`,
  );
  // With no session row only `session-record` fails (setup); the checks below judge a record that exists.
  const none = s === null;
  const noRecord = 'no session record (session-record fails)';
  check('record-version', none || str(s['version']) === cliVersion, none ? noRecord : `session version ${String(s['version'])}, preflight ${String(cliVersion)}`);
  check('record-directory', none || isRoot(str(s['directory']), h.root), none ? noRecord : `session directory ${String(s['directory'])}`);
  const agents = rec.assistants.map((a) => str(a['agent']));
  const rowAgent = none ? null : str(s['agent']);
  const badAgents = [...new Set([...agents, ...(rowAgent !== null ? [rowAgent] : [])].filter((a) => a !== OPENCODE_AGENT).map(String))];
  check('record-agent', none || (agents.length > 0 && badAgents.length === 0), none ? noRecord : badAgents.length === 0 ? `agent ${OPENCODE_AGENT} on ${agents.length} step(s)` : `agent not ${OPENCODE_AGENT}: ${badAgents.join(', ')}`);
  const models = rec.assistants.map((a) => modelRef(a['model']));
  const badModels = models.filter((m) => pin === null || m.providerID !== pin.providerID || m.id !== pin.id);
  check(
    'record-model',
    none || (models.length > 0 && badModels.length === 0),
    none ? noRecord : badModels.length === 0 ? `model ${h.occupant.model} on ${models.length} step(s)` : `model not the pin ${h.occupant.model}: ${[...new Set(badModels.map((m) => `${String(m.providerID)}/${String(m.id)}`))].join(', ')}`,
  );
  const variants = models.map((m) => m.variant);
  const badVariants = variants.filter((v) => (effort === null ? v !== null && v !== 'default' : v !== effort));
  check('record-effort', none || badVariants.length === 0, none ? noRecord : badVariants.length === 0 ? `variant ${effort ?? 'none/default'} on every step` : `variant not ${String(effort ?? 'default')}: ${[...new Set(badVariants.map(String))].join(', ')}`);
  const denied = (t: { status: string | null; error: string | null }) => t.status === 'error' && t.error !== null && OPENCODE_DENIAL.test(t.error.trim());
  const badTools = rec.tools.filter((t) => !(OPENCODE_READ_TOOLS as readonly string[]).includes(t.name) && !denied(t));
  check('record-tools', badTools.length === 0, badTools.length === 0 ? `${rec.tools.length} tool part(s), all reads or denied before running` : `tools beyond the read set: ${[...new Set(badTools.map((t) => `${t.name} (${String(t.status)})`))].join(', ')}`);
  // Every read the database records ran is path-audited by realpath, as the ACP log is (codex F1), and every
  // database call must be one the ACP log reported: the two records must tell the same story.
  const aliases = rootAliases(h.root);
  const outside: string[] = [];
  const unjudged: string[] = [];
  for (const t of rec.tools.filter((x) => !denied(x) && (OPENCODE_READ_TOOLS as readonly string[]).includes(x.name))) {
    const found = collectPaths([{ name: t.name, rawInput: t.input }], [], OPENCODE_READS, [t.name]);
    const paths = found.paths.length === 0 && found.problems.length === 0 && (OPENCODE_READS.cwdDefault ?? []).includes(t.name) ? ['.'] : found.paths;
    if (paths.length === 0 || found.problems.length > 0) unjudged.push(`${t.name} ${String(t.id)}`);
    for (const p of paths) {
      const j = judgePath(p, h.root, aliases);
      if (!j.inside) outside.push(`${t.name} ${p} (${j.why})`);
    }
  }
  check('record-paths', outside.length === 0 && unjudged.length === 0, outside.length > 0 ? `database reads outside the root: ${[...new Set(outside)].join('; ')}` : unjudged.length > 0 ? `database reads with no path the ratifier can judge: ${unjudged.join(', ')}` : 'every database read named paths inside the root');
  const acpIds = new Set(common.log.toolCalls.keys());
  const orphans = rec.tools.filter((t) => t.id === null || !acpIds.has(t.id));
  check('record-calls', orphans.length === 0, orphans.length === 0 ? `every database tool call is in the ACP log (${rec.tools.length})` : `database tool calls the ACP log never reported: ${orphans.map((t) => `${t.name} ${String(t.id)}`).join(', ')}`);
  // The offer, computed at preflight from the council agent's effective rules, must be the read set; and no MCP
  // server may be configured in the leg (grok F6).
  // The skill tool is accepted only when preflight proved the leg and the root hold no skill definition (owner
  // ruling, 2026-11-12).
  const offer = Array.isArray(h.data['offer']) ? (h.data['offer'] as unknown[]).map(String) : null;
  const mcp = Array.isArray(h.data['mcp']) ? (h.data['mcp'] as unknown[]).map(String) : null;
  const skillsEmpty = h.data['skillsEmpty'] === true;
  const allowedOffer: readonly string[] = [...OPENCODE_READ_TOOLS, ...(skillsEmpty ? ['skill'] : [])];
  const extraOffer = offer === null ? [] : offer.filter((t) => !allowedOffer.includes(t));
  check(
    'offer',
    offer !== null && extraOffer.length === 0 && mcp !== null && mcp.length === 0,
    offer === null
      ? 'no offer was computed at preflight for this leg'
      : extraOffer.length > 0
        ? `offered beyond the read set: ${extraOffer.join(', ')}`
        : mcp === null || mcp.length > 0
          ? `MCP servers configured in the leg: ${mcp === null ? 'not checked' : mcp.join(', ')}`
          : `offered ${offer.join(', ')}; no MCP server`,
  );
  const userTools = rec.messages.filter((m) => m.type === 'shell');
  check('record-messages', userTools.length === 0, userTools.length === 0 ? 'no shell message' : `shell messages: ${userTools.map((m) => `${m.type}@${m.seq}`).join(', ')}`);
  // Owner ruling (c): the offered skill tool must never be used. Any skill call (in the database or the ACP log,
  // run or refused), any skill message, any user message naming a skill, or a skill definition that appeared in
  // the leg's skill locations fails the leg.
  const skillUses = [
    ...rec.tools.filter((t) => t.name === 'skill').map((t) => `database skill call ${String(t.id)} (${String(t.status)})`),
    ...[...common.log.toolCalls.values()].filter((c) => c.titles.includes('skill') || c.kinds.includes('skill') || str(c.fields['name']) === 'skill').map((c) => `ACP skill call ${c.id}`),
    ...rec.messages.filter((m) => m.type === 'skill').map((m) => `skill message @${m.seq}`),
    ...rec.messages.filter((m) => m.type === 'user' && Array.isArray(m.data['skills']) && m.data['skills'].length > 0).map((m) => `user message @${m.seq} names skills`),
    ...opencodeSkillDefinitions(opencodeLegFiles(h.legDir)).map((p) => `skill definition in the leg: ${p}`),
  ];
  check('skill', skillUses.length === 0, skillUses.length === 0 ? 'no skill call, skill message or skill definition' : skillUses.join('; '));
  check('record-children', rec.children.length === 0, rec.children.length === 0 ? 'no child session' : `child sessions (subagents): ${rec.children.join(', ')}`);
  const injected = rec.instructions.filter((i) => !i.removed && INSTRUCTION_FILE.test(`${i.key} ${JSON.stringify(i.value)}`));
  check('record-instructions', injected.length === 0, injected.length === 0 ? `${rec.instructions.length} instruction entr(ies), none from an instruction file` : `instruction files injected: ${injected.map((i) => i.key).join(', ')}`);
  const idle = rec.messages.filter((m) => m.type === 'idle').map((m) => str(m.data['outcome']));
  const outcome = none ? null : (str(s['idle_outcome']) ?? idle[idle.length - 1] ?? null);
  check('record-outcome', none || outcome === 'succeeded', none ? noRecord : `idle outcome ${String(outcome)}`);
  const last = models[models.length - 1];
  return {
    checks,
    classOf: RECORD_CLASS,
    fields: {
      cliVersion,
      modelObserved: last ? `${String(last.providerID)}/${String(last.id)}` : null,
      effortObserved: last?.variant ?? null,
      costUsd: none ? null : num(s['cost']),
      tokensIn: none ? null : num(s['tokens_input']),
      tokensOut: none ? null : num(s['tokens_output']),
      recordPath: files.db,
      toolsUsed: [...new Set([...common.toolsUsed, ...rec.tools.filter((t) => !denied(t)).map((t) => t.name)])].sort(),
    },
    detail: { db: files.db, tools: rec.tools, instructions: rec.instructions.map((i) => i.key), steps: rec.assistants.length },
  };
}

export interface OpencodeAdapterOptions {
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
  /**
   * A config passed in `OPENCODE_CONFIG` (an extra file in the leg's temp dir). Only the promotion canary uses it,
   * to plant user-side allow rules; preflight refuses any.
   */
  planted?: Record<string, unknown> | undefined;
}

/** `opencode models` on a throwaway isolated home (no model call); the free models when the CLI is absent. */
async function listModelsVia(bin: string, runner: CommandRunner, env: NodeJS.ProcessEnv): Promise<ModelInfo[]> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sc-opencode-models-')));
  try {
    const files = opencodeLegFiles(dir);
    prepareOpencodeDirs(files);
    const r = await runner(bin, ['models', '--standalone'], { cwd: dir, env: opencodeEnv(env, files, dir, false), timeoutMs: 60_000 });
    const ids = r.exitCode === 0 ? parseOpencodeModels(r.stdout) : [];
    return modelInfos(ids.length > 0 ? ids : OPENCODE_FREE_MODELS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function createOpencodeAdapter(options: OpencodeAdapterOptions = {}): SeatAdapter {
  const runner = options.runner ?? runCommand;
  const binFor = (env: NodeJS.ProcessEnv): string => options.bin ?? defaultOpencodeBin(env);
  return createAcpAdapter({
    id: 'opencode',
    testedVersions: { floor: OPENCODE_FLOOR, tested: OPENCODE_TESTED_VERSIONS },
    enforcement: (version) => opencodeDecl(version)?.enforcement ?? 'pending',
    listModels: () => listModelsVia(binFor(process.env), runner, process.env),
    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> => {
      const env = ctx.env ?? process.env;
      return opencodePreflight(o, { bin: binFor(env), runner, env, root: ctx.root, legDir: ctx.legDir, planted: options.planted });
    },
    plan(o, ctx, pre) {
      const files = opencodeLegFiles(ctx.legDir);
      prepareOpencodeDirs(files, options.planted);
      const sourceEnv = ctx.env ?? process.env;
      // Model first: the effort option exists only once a model with variants is selected; then the agent.
      const pins = [
        { via: 'set_config_option' as const, configId: 'model', value: o.model },
        ...(o.effort !== undefined ? [{ via: 'set_config_option' as const, configId: 'effort', value: o.effort }] : []),
        { via: 'set_config_option' as const, configId: 'mode', value: OPENCODE_AGENT },
      ];
      return {
        command: binFor(sourceEnv),
        args: ['acp'],
        env: opencodeEnv(sourceEnv, files, ctx.root, options.planted !== undefined),
        pins,
        expect: [
          { id: 'mode', value: OPENCODE_AGENT, check: 'mode' },
          { id: 'model', value: o.model, check: 'model' },
          ...(o.effort !== undefined ? [{ id: 'effort', value: o.effort, check: 'effort' as const }] : []),
        ],
        files: { log: files.log, stderr: files.stderr, process: files.process, db: files.db },
        data: { db: files.db, offer: pre.data['offer'] ?? null, skillsEmpty: pre.data['skillsEmpty'] ?? null, mcp: pre.data['mcp'] ?? null },
      };
    },
    reads: OPENCODE_READS,
    ratifyRecords: opencodeRecords,
    classifyText: classifyOpencodeText,
  });
}
