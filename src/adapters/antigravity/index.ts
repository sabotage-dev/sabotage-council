import { join } from 'node:path';
import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, scrubEnv, type CommandRunner } from '../../transport/headless.js';
import { createAcpAdapter, type AcpRecordResult } from '../acp/adapter.js';
import { ACP_READ_KINDS } from '../acp/policy.js';
import type { AcpCommonResult } from '../acp/ratify.js';
import type { LegHandle, Occupant, Preflight, RatificationCheck, RoundCtx, SeatAdapter } from '../types.js';
import { AGY_CONFIG, AGY_FLOOR, AGY_MODE, AGY_MODELS, AGY_TESTED_VERSIONS, agyDecl } from './known.js';
import { AGY_ENV_ALLOW, AGY_ENV_SET, agyArgs, agyLegFiles, agyLegSettings, hasGeminiKey, writeAgySettings } from './launch.js';
import { agyPreflight } from './preflight.js';
import { readAgyGenerations, readAgyLog } from './records.js';

export { AGY_DECLARED, AGY_MODE, AGY_MODELS, agyDecl, agySlug, parseAgyModels } from './known.js';
export { AGY_ENV_ALLOW, agyArgs, agyLegFiles, agyLegSettings } from './launch.js';
export { agyPreflight, agyRuleProblems, parseAgyUsage, quotaGroupFor, AGY_API_KEY_NOTE } from './preflight.js';
export { AGY_GEN_FIELDS, readAgyGenerations, readAgyLog } from './records.js';

/*
 * Antigravity failure signatures (plan 4.4), applied to stderr, RPC errors and non-JSON stdout, never to the
 * answer. `You are not logged into Antigravity.` is startup noise that precedes a successful keyring load, so no
 * pattern here matches it.
 */
export const AGY_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  {
    class: 'usage_limit',
    pattern: /RESOURCE_EXHAUSTED|"code":\s*429|quota (?:exceeded|exhausted|reached)|exhausted (?:your|the) quota|(?:weekly|daily) limit (?:reached|exhausted)|spend cap|prepaid credits|out of credits|usage limit/i,
  },
  {
    class: 'auth',
    pattern: /authentication required|Authentication expired\. Please log back in|Verify your account to continue|Sign-in update needed|Eligibility check failed|GEMINI_API_KEY environment variable is not set/i,
  },
  { class: 'model', pattern: /invalid model selection|is not recognized as a known model|--effort is not supported for model|conflicts with --effort=/i },
  { class: 'capacity', pattern: /"canonical_status":\s*"UNAVAILABLE"|"code":\s*503|overloaded|temporarily unavailable/i },
  { class: 'transport', pattern: /ECONNRESET|ECONNREFUSED|socket hang up|exited before answering/i },
  { class: 'setup', pattern: /unknown setting|flags provided but not defined|must be an absolute path/i },
];

export function classifyAgyText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of AGY_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}

export interface AntigravityAdapterOptions {
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
  /**
   * Merged into the leg's settings file. Only the promotion canary uses it, to plant a user-side allow rule in
   * the leg's temp gemini dir; a real leg passes nothing here, and preflight refuses any allow rule.
   */
  settingsOverlay?: Record<string, unknown> | undefined;
}

const RECORD_CLASS: Readonly<Record<string, FailureClass>> = {
  'agy-log': 'setup',
  'cli-version': 'setup',
  'gemini-dir': 'contaminated',
  'record-model': 'model',
};

function agyRecords(h: LegHandle, common: AcpCommonResult): AcpRecordResult {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const files = agyLegFiles(h.legDir);
  const facts = readAgyLog(files.agyLog);
  const sessionId = common.log.sessionId;
  check(
    'agy-log',
    facts.exists && sessionId !== null && facts.conversations.includes(sessionId),
    !facts.exists ? `no agy log at ${files.agyLog}` : `conversations ${facts.conversations.join(', ') || 'none'}; session ${String(sessionId)}`,
  );
  const want = String(h.data['cliVersion'] ?? '');
  const versions = [...new Set(facts.versions)];
  check('cli-version', versions.length === 1 && versions[0] === want, `log version ${versions.join(', ') || 'none'}, preflight ${want}`);
  const appDir = join(files.geminiDir, 'antigravity-cli');
  const dirs = [...new Set(facts.appDataDirs)];
  // A missing log fails `agy-log`; this check judges the directory a present log names.
  check('gemini-dir', (!facts.exists && dirs.length === 0) || (dirs.length > 0 && dirs.every((d) => d === appDir || d === `/private${appDir}` || `/private${d}` === appDir)), `app data dir ${dirs.join(', ') || 'none'} (want the leg's own ${appDir})`);
  const label = typeof h.data['label'] === 'string' ? h.data['label'] : null;
  const slug = typeof h.data['slug'] === 'string' ? h.data['slug'] : null;
  const gen = readAgyGenerations(join(appDir, 'conversations', `${String(sessionId)}.db`));
  const badLabels = [...new Set(gen.labels.filter((l) => l !== label))];
  const badSlugs = [...new Set(gen.slugs.filter((s) => s !== slug))];
  check(
    'record-model',
    gen.exists && gen.problem === null && gen.rows > 0 && label !== null && badLabels.length === 0 && badSlugs.length === 0,
    !gen.exists
      ? `no conversation DB for ${String(sessionId)} in the leg's gemini dir`
      : gen.problem !== null
        ? `conversation DB unreadable: ${gen.problem}`
        : badLabels.length + badSlugs.length === 0
          ? `${gen.rows} model call(s), every one ${String(label)}${gen.slugs.length > 0 ? ` (${[...new Set(gen.slugs)].join(', ')})` : ''}`
          : `model calls not on the pin ${String(label)} / ${String(slug)}: ${[...badLabels.map(String), ...badSlugs].join(', ')}`,
  );
  return {
    checks,
    classOf: RECORD_CLASS,
    fields: {
      cliVersion: versions[0] ?? null,
      modelObserved: gen.labels.find((l) => l !== null) ?? null,
      effortObserved: common.log.configBefore[AGY_CONFIG.effort] ?? null,
      recordPath: gen.dbPath,
      toolsOffered: gen.toolsOffered,
    },
    detail: { modelCalls: gen.rows, modelLabels: [...new Set(gen.labels)], slugs: [...new Set(gen.slugs)], logModelLabels: facts.modelLabels },
  };
}

export function createAntigravityAdapter(options: AntigravityAdapterOptions = {}): SeatAdapter {
  const bin = options.bin ?? 'agy';
  const runner = options.runner ?? runCommand;
  return createAcpAdapter({
    id: 'antigravity',
    testedVersions: { floor: AGY_FLOOR, tested: AGY_TESTED_VERSIONS },
    enforcement: (version) => agyDecl(version)?.enforcement ?? 'pending',
    listModels: async (): Promise<ModelInfo[]> => [...AGY_MODELS],
    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> =>
      agyPreflight(o, { bin, runner, env: ctx.env ?? process.env, root: ctx.root, settingsOverlay: options.settingsOverlay }),
    plan(o, ctx, pre) {
      const files = agyLegFiles(ctx.legDir);
      const sourceEnv = ctx.env ?? process.env;
      const apiKey = hasGeminiKey(sourceEnv);
      writeAgySettings(files, agyLegSettings(apiKey, options.settingsOverlay));
      const pins = [
        { via: 'set_config_option' as const, configId: AGY_CONFIG.model, value: o.model },
        ...(o.effort !== undefined ? [{ via: 'set_config_option' as const, configId: AGY_CONFIG.effort, value: o.effort }] : []),
        { via: 'set_config_option' as const, configId: AGY_CONFIG.mode, value: AGY_MODE },
      ];
      return {
        command: bin,
        args: agyArgs(files),
        env: scrubEnv(sourceEnv, AGY_ENV_ALLOW, AGY_ENV_SET),
        pins,
        expect: [
          { id: AGY_CONFIG.model, value: o.model, check: 'model' },
          ...(o.effort !== undefined ? [{ id: AGY_CONFIG.effort, value: o.effort, check: 'effort' as const }] : []),
          { id: AGY_CONFIG.mode, value: AGY_MODE, check: 'mode' },
        ],
        files: { log: files.log, stderr: files.stderr, process: files.process, agyLog: files.agyLog, settings: files.settings },
        data: { slug: pre.data['slug'] ?? null, label: pre.data['label'] ?? null, apiKey, geminiDir: files.geminiDir },
      };
    },
    readKinds: ACP_READ_KINDS,
    ratifyRecords: agyRecords,
    classifyText: classifyAgyText,
  });
}
