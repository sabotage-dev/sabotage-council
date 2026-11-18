import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, type CommandRunner } from '../../transport/headless.js';
import { createAcpAdapter, type AcpLaunchPlan, type AcpRecordResult } from '../acp/adapter.js';
import { isObject, type ReadSet } from '../acp/policy.js';
import { isRoot, type AcpCommonResult } from '../acp/ratify.js';
import { pathInsideRoot, rootAliases } from '../paths.js';
import type { LegHandle, Occupant, Preflight, RatificationCheck, RoundCtx, SeatAdapter } from '../types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  KIRO_AGENT,
  KIRO_FLOOR,
  KIRO_MODELS,
  KIRO_TESTED_VERSIONS,
  KIRO_V3_AGENT_SHA256,
  kiroDecl,
  kiroEngine,
  kiroSettingsText,
  kiroV3AgentText,
} from './known.js';
import { KIRO_KILL_ON, kiroArgs, kiroEnv, kiroEnvAllow, kiroHome, kiroLegFiles, writeAgentFile, writeKiroProfile, writeKiroSettings } from './launch.js';
import { kiroPreflight } from './preflight.js';
import { readKiroRecord } from './records.js';
import { KIRO_V3_READS, kiroV3Gate, kiroV3Policy, kiroV3Records } from './v3.js';

export {
  KIRO_AGENT,
  KIRO_DECLARED,
  KIRO_DEFAULT_ENGINE,
  KIRO_ENGINES,
  KIRO_MODELS,
  KIRO_SETTINGS_KEYS,
  KIRO_UPDATE_OFF_TEXT,
  KIRO_V3_AGENT_SHA256,
  KIRO_V3_AGENT_TEXT,
  KIRO_V3_FLOOR,
  kiroDecl,
  kiroEngine,
  kiroEngineDecl,
  kiroProfile,
  kiroSettingsText,
  profileHash,
  type KiroEngine,
} from './known.js';
export { KIRO_ENV_ALLOW, KIRO_KILL_ON, kiroArgs, kiroCredential, kiroEnv, kiroEnvAllow, kiroHome, kiroLegFiles, kiroTokenStore } from './launch.js';
export { kiroPreflight, parseKiroModels, readTokenState } from './preflight.js';
export { readKiroRecord } from './records.js';
export {
  KIRO_V3_CLASS,
  KIRO_V3_GATE_NEEDS,
  KIRO_V3_NOTICE,
  KIRO_V3_READS,
  KIRO_V3_TITLES,
  gateViewOf,
  isLoopGuard,
  kiroV3Gate,
  kiroV3GateChecks,
  kiroV3Policy,
  kiroV3Ran,
  legVersions,
  noPresets,
} from './v3.js';

/*
 * Kiro failure signatures (plan 4.4), applied to stderr, RPC errors, non-JSON stdout and the exit code, never to
 * the answer. The remediation text `kiro-cli login` alone is never an auth failure: it appears in docs a leg may
 * read. Exit 3 (a required MCP server did not start) and exit 4 (the agent is unavailable on the engine) are setup.
 */
export const KIRO_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  { class: 'usage_limit', pattern: /Monthly request limit reached|enable overages to continue|The limits reset on|(?:monthly|usage) limit (?:reached|exceeded)|insufficient credits/i },
  {
    class: 'auth',
    pattern: /Opening browser|Auth portal timed out|OAuth error|Not logged in\.|You are not logged in|let's get you signed in|Press enter to continue to the browser|(?:token|session) (?:has )?expired/i,
  },
  { class: 'setup', pattern: /^acp-exit-code [34]$|no agent with name|Falling back to|needs upgrading|Tool approval required|unexpected argument|invalid value for/im },
  { class: 'model', pattern: /failed to set model|model (?:\S+ )?(?:is )?(?:not found|not available|unknown)|invalid model/i },
  { class: 'capacity', pattern: /Kiro is having trouble responding|dispatch failure|Retry #\d+|throttl|too many requests|ServiceUnavailable/i },
  { class: 'transport', pattern: /ECONNRESET|ECONNREFUSED|socket hang up|exited before answering/i },
];

export function classifyKiroText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of KIRO_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}

export interface KiroAdapterOptions {
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
  platform?: NodeJS.Platform | undefined;
  /**
   * Merged into the leg's agent file (v2: the profile; v3: the constant file). Only the promotion canary uses it, to
   * plant allow rules in the leg's temp KIRO_HOME; preflight refuses any overlay.
   */
  profileOverlay?: Record<string, unknown> | undefined;
  /**
   * A permission preset written to the leg's `$KIRO_HOME/settings/permissions.yaml` (v3 promotion canary only, P11);
   * preflight refuses it, and the gate refuses the session it lands in.
   */
  presetPlant?: string | undefined;
  /** How long the v3 gate waits for each notification it needs (default 5000 ms; tests shorten it). */
  gateWaitMs?: number | undefined;
  /** Where preflight makes its scratch KIRO_HOME (default the OS temp dir). */
  scratchDir?: string | undefined;
}

const kiroMeta = (s: Record<string, unknown>): Record<string, unknown> => {
  const meta = s['_meta'];
  const kiro = isObject(meta) ? meta['kiro'] : undefined;
  return isObject(kiro) ? kiro : {};
};

/**
 * kiro's read tools (3.2.1, v2 engine): the council profile offers `fs_read`, `grep` and `glob`, reported as
 * `_meta.kiro.toolName` `read` (kind `read`), `grep` and `glob` (kind `search`) in the recorded legs. grep and glob
 * search the cwd when given no path, as kiro documents. A refused call reports
 * `_meta.kiro.toolCallFailureReason: "permission_denied"` with the text "User denied tool execution", which is a
 * notice, not output.
 */
export const KIRO_READS: ReadSet = {
  kinds: ['read', 'search'],
  names: ['read', 'grep', 'glob'],
  nameOf: (s) => {
    const name = kiroMeta(s)['toolName'];
    return typeof name === 'string' ? name : null;
  },
  cwdDefault: ['grep', 'glob'],
  denialNotice: (s) => kiroMeta(s)['toolCallFailureReason'] === 'permission_denied',
  // Argument semantics (kiro's own tool descriptions, recorded in the canary fixture): grep's `pattern` is a regex
  // to search for and glob's `pattern` is a file glob; both take an optional `path` (default the cwd). The purpose
  // note kiro adds to every call is free text. grep's file-filter glob falls back to the generic glob-word rule.
  args: {
    read: { text: ['__tool_use_purpose'] },
    grep: { text: ['pattern', '__tool_use_purpose'] },
    glob: { globs: ['pattern'], text: ['__tool_use_purpose'] },
  },
};

const RECORD_CLASS: Readonly<Record<string, FailureClass>> = {
  'session-record': 'setup',
  'record-cwd': 'contaminated',
  'record-agent': 'contaminated',
  'record-model': 'model',
  'record-effort': 'model',
  'record-permissions': 'contaminated',
};

function kiroRecords(h: LegHandle, common: AcpCommonResult): AcpRecordResult {
  const files = kiroLegFiles(h.legDir);
  if (legEngine(h) === 'v3') return kiroV3Records(h, common, files.kiroHome, files.profile);
  return kiroV2Records(h, common);
}

/** The engine a leg ran: the one its launch recorded, else its occupant's (unset = v3). */
function legEngine(h: Pick<LegHandle, 'data' | 'occupant'>): 'v2' | 'v3' {
  const recorded = h.data['engine'];
  return recorded === 'v2' || recorded === 'v3' ? recorded : kiroEngine(h.occupant.engine);
}

function kiroV2Records(h: LegHandle, common: AcpCommonResult): AcpRecordResult {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const files = kiroLegFiles(h.legDir);
  const rec = readKiroRecord(files.kiroHome, common.log.sessionId);
  const pin = h.occupant.model;
  const effort = h.occupant.effort ?? null;
  check(
    'session-record',
    rec.path !== null && !rec.malformed && rec.sessionId === common.log.sessionId && rec.count === 1 && rec.turns > 0,
    rec.path === null
      ? `no v2 session record for ${String(common.log.sessionId)} under the leg's KIRO_HOME (${rec.count} record(s))`
      : `${rec.path}: ${rec.turns} turn(s)${rec.count !== 1 ? `; ${rec.count} records in the leg's KIRO_HOME` : ''}${rec.malformed ? '; malformed' : ''}`,
  );
  // With no record at all only `session-record` fails (setup): a leg refused or stopped before its first turn is
  // not contaminated. The checks below judge a record that exists.
  const none = rec.path === null;
  const noRecord = 'no session record (session-record fails)';
  check('record-cwd', none || isRoot(rec.cwd, h.root), none ? noRecord : `record cwd ${String(rec.cwd)}`);
  check('record-agent', none || rec.agent === KIRO_AGENT, none ? noRecord : `agent ${String(rec.agent)} (want ${KIRO_AGENT})`);
  const models = [rec.modelInfo, ...rec.turnModels];
  const badModels = [...new Set(models.filter((m) => m !== pin))];
  check('record-model', none || (rec.modelInfo !== null && rec.turnModels.length > 0 && badModels.length === 0), none ? noRecord : badModels.length === 0 ? `model ${pin} in model_info and ${rec.turnModels.length} turn(s)` : `model not the pin ${pin}: ${badModels.map(String).join(', ')}`);
  check('record-effort', none || rec.effort === effort, none ? noRecord : `effort ${String(rec.effort)}, pinned ${String(effort)}`);
  // The session's own grants: no trusted tool, no write path, no allowed command, and every read path realpaths
  // inside the root (a wider read grant would let a read run outside it with no permission request).
  const aliases = rootAliases(h.root);
  const wideReads = rec.allowedReadPaths.filter((p) => !pathInsideRoot(p, h.root, aliases, { literalDollar: true }).inside);
  const granted = [
    ...(rec.trustedTools.length > 0 ? [`trusted tools ${rec.trustedTools.join(', ')}`] : []),
    ...(rec.allowedWritePaths.length > 0 ? [`write paths ${rec.allowedWritePaths.join(', ')}`] : []),
    ...(rec.allowedCommands.length > 0 ? [`allowed commands ${rec.allowedCommands.join(', ')}`] : []),
    ...(wideReads.length > 0 ? [`read paths outside the root ${wideReads.join(', ')}`] : []),
  ];
  check('record-permissions', granted.length === 0, granted.length === 0 ? 'no trusted tools, write paths or commands; read paths inside the root' : granted.join('; '));
  return {
    checks,
    classOf: RECORD_CLASS,
    fields: {
      cliVersion: typeof h.data['cliVersion'] === 'string' ? h.data['cliVersion'] : null,
      modelObserved: rec.modelInfo,
      effortObserved: rec.effort,
      credits: rec.credits,
      recordPath: rec.path,
    },
    detail: { engine: 'v2', kiroHome: files.kiroHome, home: h.data['home'] ?? null, turnModels: rec.turnModels, durationMsRecord: rec.durationMs },
  };
}

export function createKiroAdapter(options: KiroAdapterOptions = {}): SeatAdapter {
  const bin = options.bin ?? 'kiro-cli';
  const runner = options.runner ?? runCommand;
  return createAcpAdapter({
    id: 'kiro',
    testedVersions: { floor: KIRO_FLOOR, tested: KIRO_TESTED_VERSIONS },
    // Every declared engine of every declared version is `pending` (P3, P11).
    enforcement: (version) => Object.values(kiroDecl(version)?.engines ?? {})[0]?.enforcement ?? 'pending',
    listModels: async (): Promise<ModelInfo[]> => [...KIRO_MODELS],
    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> =>
      kiroPreflight(o, {
        bin,
        runner,
        env: ctx.env ?? process.env,
        root: ctx.root,
        platform: options.platform,
        profileOverlay: options.profileOverlay,
        presetPlant: options.presetPlant,
        scratchDir: options.scratchDir,
      }),
    plan(o, ctx, pre): AcpLaunchPlan {
      const files = kiroLegFiles(ctx.legDir);
      const sourceEnv = ctx.env ?? process.env;
      const home = kiroHome(o.authHome, sourceEnv);
      if (home === null) throw new Error('no HOME for kiro-cli');
      const engine = kiroEngine(o.engine);
      // The leg settings file, on the versions that declare its keys (4.6): both engines.
      const settings = kiroSettingsText(pre.cliVersion);
      if (settings !== null) writeKiroSettings(files.kiroHome, settings);
      const env = kiroEnv(sourceEnv, home, files, kiroEnvAllow(o.authHome));
      const common = { command: bin, env, killOn: KIRO_KILL_ON };
      if (engine === 'v2') {
        writeKiroProfile(files, o.model, options.profileOverlay);
        return {
          ...common,
          args: kiroArgs(o.model, o.effort, 'v2'),
          // The v2 engine takes the agent, model and effort as launch flags and reports the first two back.
          pins: [
            { via: 'launch', configId: 'mode', value: KIRO_AGENT },
            { via: 'launch', configId: 'model', value: o.model },
          ],
          expect: [
            { id: 'mode', value: KIRO_AGENT, check: 'mode' },
            { id: 'model', value: o.model, check: 'model' },
          ],
          files: { log: files.log, stderr: files.stderr, process: files.process, profile: files.profile },
          data: { home, kiroHome: files.kiroHome, engine: 'v2', settingsWritten: settings !== null },
        };
      }
      // v3: the constant agent file, written as its exact bytes and hashed back from disk.
      const overlaid = options.profileOverlay !== undefined && Object.keys(options.profileOverlay).length > 0;
      const agentHash = writeAgentFile(files.profile, kiroV3AgentText(options.profileOverlay));
      if (!overlaid && agentHash !== KIRO_V3_AGENT_SHA256) throw new Error(`the v3 agent file reads back as sha256 ${agentHash.slice(0, 16)}, not the declared bytes`);
      if (options.presetPlant !== undefined) {
        mkdirSync(join(files.kiroHome, 'settings'), { recursive: true });
        writeFileSync(join(files.kiroHome, 'settings', 'permissions.yaml'), options.presetPlant);
      }
      const effort = o.effort;
      return {
        ...common,
        args: kiroArgs(o.model, effort, 'v3'),
        // Every pin over ACP, in the plan's order (4.6 step 2), each checked in the reported configOptions.
        pins: [
          { via: 'set_config_option', configId: 'mode', value: KIRO_AGENT },
          { via: 'set_config_option', configId: 'model', value: o.model, advertised: 'wait' },
          ...(effort !== undefined ? [{ via: 'set_config_option' as const, configId: 'effortLevel', value: effort, advertised: 'require' as const }] : []),
          { via: 'set_config_option', configId: 'autopilot', value: 'off' },
          { via: 'set_config_option', configId: 'contentCollection', value: 'disabled' },
          { via: 'set_config_option', configId: 'memoryReflection', value: 'off' },
          { via: 'set_config_option', configId: 'sessionToolsMessaging', value: 'off' },
        ],
        expect: [
          { id: 'mode', value: KIRO_AGENT, check: 'mode' },
          { id: 'model', value: o.model, check: 'model' },
          ...(effort !== undefined ? [{ id: 'effortLevel', value: effort, check: 'effort' }] : []),
          { id: 'autopilot', value: 'off', check: 'autopilot' },
          { id: 'contentCollection', value: 'disabled', check: 'contentCollection' },
          { id: 'memoryReflection', value: 'off', check: 'memoryReflection' },
          { id: 'sessionToolsMessaging', value: 'off', check: 'sessionToolsMessaging' },
        ],
        gate: kiroV3Gate(files.kiroHome, options.gateWaitMs),
        onPermission: kiroV3Policy(ctx.root),
        files: { log: files.log, stderr: files.stderr, process: files.process, profile: files.profile, settings: files.settings },
        data: { home, kiroHome: files.kiroHome, engine: 'v3', agentHash, settingsWritten: settings !== null },
      };
    },
    reads: KIRO_READS,
    readsOf: (h) => (legEngine(h) === 'v3' ? KIRO_V3_READS : KIRO_READS),
    ratifyRecords: kiroRecords,
    classifyText: classifyKiroText,
  });
}
