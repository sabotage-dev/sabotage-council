import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, type CommandRunner } from '../../transport/headless.js';
import { createAcpAdapter, type AcpRecordResult } from '../acp/adapter.js';
import { isObject, type ReadSet } from '../acp/policy.js';
import { isRoot, type AcpCommonResult } from '../acp/ratify.js';
import { pathInsideRoot, rootAliases } from '../paths.js';
import type { LegHandle, Occupant, Preflight, RatificationCheck, RoundCtx, SeatAdapter } from '../types.js';
import { KIRO_AGENT, KIRO_FLOOR, KIRO_MODELS, KIRO_TESTED_VERSIONS, kiroDecl } from './known.js';
import { KIRO_KILL_ON, kiroArgs, kiroEnv, kiroEnvAllow, kiroHome, kiroLegFiles, writeKiroProfile } from './launch.js';
import { kiroPreflight } from './preflight.js';
import { readKiroRecord } from './records.js';

export { KIRO_AGENT, KIRO_DECLARED, KIRO_MODELS, kiroDecl, kiroProfile, profileHash } from './known.js';
export { KIRO_ENV_ALLOW, KIRO_KILL_ON, kiroArgs, kiroCredential, kiroEnv, kiroEnvAllow, kiroHome, kiroLegFiles, kiroTokenStore } from './launch.js';
export { kiroPreflight, parseKiroModels, readTokenState } from './preflight.js';
export { readKiroRecord } from './records.js';

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
   * Merged into the leg's agent profile. Only the promotion canary uses it, to plant allow rules in the leg's temp
   * KIRO_HOME; preflight refuses any overlay.
   */
  profileOverlay?: Record<string, unknown> | undefined;
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
    enforcement: (version) => kiroDecl(version)?.enforcement ?? 'pending',
    listModels: async (): Promise<ModelInfo[]> => [...KIRO_MODELS],
    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> =>
      kiroPreflight(o, { bin, runner, env: ctx.env ?? process.env, root: ctx.root, platform: options.platform, profileOverlay: options.profileOverlay }),
    plan(o, ctx) {
      const files = kiroLegFiles(ctx.legDir);
      const sourceEnv = ctx.env ?? process.env;
      const home = kiroHome(o.authHome, sourceEnv);
      if (home === null) throw new Error('no HOME for kiro-cli');
      writeKiroProfile(files, o.model, options.profileOverlay);
      return {
        command: bin,
        args: kiroArgs(o.model, o.effort),
        env: kiroEnv(sourceEnv, home, files, kiroEnvAllow(o.authHome)),
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
        data: { home, kiroHome: files.kiroHome, engine: 'v2' },
        killOn: KIRO_KILL_ON,
      };
    },
    reads: KIRO_READS,
    ratifyRecords: kiroRecords,
    classifyText: classifyKiroText,
  });
}
