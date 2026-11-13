import { existsSync, readFileSync } from 'node:fs';
import type { ModelInfo } from '../../config/registry.js';
import type { BackendId, FailureClass } from '../../config/vocab.js';
import { startAcp, type AcpPin, type AcpProcess } from '../../transport/acp.js';
import {
  fromNonceLine,
  verdictOf,
  type EnforcementLabel,
  type LegHandle,
  type LegState,
  type LegText,
  type Occupant,
  type Preflight,
  type Ratification,
  type RatificationCheck,
  type RoundCtx,
  type SeatAdapter,
  type SemverRange,
} from '../types.js';
import { acpAnswer, promptUsage, readAcpLog } from './log.js';
import { readOnlyPolicy, type ReadSet } from './policy.js';
import { ACP_CLASS_OF_CHECK, acpFailureClass, ratifyAcpCommon, type AcpCommonResult, type AcpPinExpect } from './ratify.js';

/*
 * The shared shape of an ACP seat adapter (plan 4.1): the backend declares how to launch the agent, which pins
 * to apply, which tool kinds are reads, and how to check its own records; the transport, the permission policy and
 * the common ratification are the same for every ACP backend.
 */

export interface AcpLaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  pins: AcpPin[];
  expect: AcpPinExpect[];
  files: Record<string, string>;
  data: Record<string, unknown>;
  killOn?: RegExp | undefined;
}

export interface AcpRecordResult {
  checks: RatificationCheck[];
  classOf: Readonly<Record<string, FailureClass>>;
  fields: Partial<Ratification>;
  detail: Record<string, unknown>;
}

export interface AcpAdapterDef {
  id: BackendId;
  testedVersions: SemverRange;
  enforcement: (version: string | null) => EnforcementLabel;
  listModels: () => Promise<ModelInfo[]>;
  preflight: (o: Occupant, ctx: RoundCtx) => Promise<Preflight>;
  /** Builds the launch and writes the leg's own files (settings, agent profile) into the leg dir. */
  plan: (o: Occupant, ctx: RoundCtx, pre: Preflight) => AcpLaunchPlan;
  /** What this backend counts as a read: kinds and declared tool names (plan 4.1, 4.5). */
  reads: ReadSet;
  /** Checks from the backend's own records (model label, session record, credits). */
  ratifyRecords: (h: LegHandle, common: AcpCommonResult) => AcpRecordResult;
  /** Failure signature from stderr, error responses and non-JSON stdout, never the answer (plan 4.4). */
  classifyText: (texts: readonly string[]) => FailureClass | null;
}

function readText(path: string | undefined): string {
  return path !== undefined && existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/** The texts a failure signature is read from: stderr, RPC errors, non-JSON stdout and a kill-pattern line. */
export function acpErrorTexts(h: LegHandle): string[] {
  const log = readAcpLog(h.files['log'] ?? '');
  const texts = [readText(h.files['stderr']), ...log.errorTexts, ...log.rawLines];
  if (log.tornLine !== null) texts.push(log.tornLine);
  const killedOn = (h.exit as { killedOn?: string | null } | null)?.killedOn;
  if (typeof killedOn === 'string') texts.push(killedOn);
  // The exit code as a line of its own, for backends whose codes carry a class (kiro: 3 and 4 are setup).
  if (typeof h.exit?.exitCode === 'number' && h.exit.exitCode !== 0) texts.push(`acp-exit-code ${String(h.exit.exitCode)}`);
  return texts;
}

export function createAcpAdapter(def: AcpAdapterDef): SeatAdapter {
  const adapter: SeatAdapter = {
    id: def.id,
    transport: 'acp',
    testedVersions: def.testedVersions,
    enforcement: def.enforcement,
    listModels: def.listModels,
    preflight: def.preflight,

    async launch(o: Occupant, ctx: RoundCtx, pre?: Preflight): Promise<LegHandle> {
      const p = pre ?? (await def.preflight(o, ctx));
      if (!p.ok) throw new Error(`${def.id} preflight failed: ${p.reason ?? 'unknown'}`);
      const plan = def.plan(o, ctx, p);
      const brief = readFileSync(ctx.briefFile, 'utf8');
      const proc: AcpProcess = startAcp({
        command: plan.command,
        args: plan.args,
        cwd: ctx.root,
        env: plan.env,
        logFile: plan.files['log'] as string,
        stderrFile: plan.files['stderr'] as string,
        recordFile: plan.files['process'],
        sessionCwd: ctx.root,
        promptText: brief,
        pins: plan.pins,
        onPermission: readOnlyPolicy(ctx.root, def.reads),
        timeoutMs: ctx.timeoutMs,
        killOn: plan.killOn,
        clientName: 'sabotage-council',
      });
      return {
        backend: def.id,
        occupant: o,
        legDir: ctx.legDir,
        root: ctx.root,
        nonce: ctx.nonce,
        startedAt: proc.startedAt,
        process: proc,
        exit: null,
        files: plan.files,
        data: { ...plan.data, expect: plan.expect, cliVersion: p.cliVersion },
      };
    },

    async poll(h: LegHandle): Promise<LegState> {
      if (h.exit) return { status: 'done', doneBy: h.exit.doneBy, exit: h.exit };
      if (!h.process) return { status: 'done', doneBy: 'exit', exit: null };
      if (h.process.running()) return { status: 'running' };
      h.exit = await h.process.exited;
      return { status: 'done', doneBy: h.exit.doneBy, exit: h.exit };
    },

    async collect(h: LegHandle): Promise<LegText> {
      return fromNonceLine(acpAnswer(readAcpLog(h.files['log'] ?? '')), h.nonce, 'acp');
    },

    async ratify(h: LegHandle, ctx: RoundCtx): Promise<Ratification> {
      if (h.process && !h.exit) h.exit = await h.process.exited;
      const common = ratifyAcpCommon({
        logFile: h.files['log'] ?? '',
        root: h.root,
        nonce: h.nonce,
        pins: (h.data['expect'] as AcpPinExpect[] | undefined) ?? [],
        reads: def.reads,
        transportError: h.exit?.recordError ?? null,
        closeTimedOut: (h.exit as { closeTimedOut?: boolean } | null)?.closeTimedOut === true,
        timedOut: h.exit?.timedOut ?? false,
        rootUnchanged: ctx.rootUnchanged,
      });
      const own = def.ratifyRecords(h, common);
      const checks = [...common.checks, ...own.checks];
      const classOf = { ...ACP_CLASS_OF_CHECK, ...own.classOf };
      const signature = def.classifyText(acpErrorTexts(h));
      const failed = checks.filter((c) => !c.ok).map((c) => c.name);
      const failureClass = acpFailureClass(failed, classOf, signature, h.exit?.timedOut ?? false);
      const { ok, status } = verdictOf(checks, failureClass);
      const usage = promptUsage(common.log);
      const base: Ratification = {
        status,
        ok,
        failureClass,
        checks,
        enforcement: def.enforcement(own.fields.cliVersion ?? null),
        recordPath: h.files['log'] ?? null,
        sessionId: common.log.sessionId,
        cliVersion: null,
        modelObserved: common.log.configBefore['model'] ?? null,
        effortObserved: null,
        cwdObserved: common.log.sessionNew ? (common.log.sessionNew.params['cwd'] as string | undefined) ?? null : null,
        cwdOk: checks.find((c) => c.name === 'cwd')?.ok ?? false,
        toolsOffered: [],
        toolsUsed: common.toolsUsed,
        tokensIn: usage.input,
        tokensOut: usage.output,
        costUsd: null,
        credits: null,
        quotaUsedPct: null,
        quotaNote: null,
        durationMs: h.exit?.durationMs ?? null,
        nonceSeen: common.nonceSeen,
        rootMutated: common.rootMutated,
        detail: {},
      };
      return {
        ...base,
        ...own.fields,
        enforcement: def.enforcement(own.fields.cliVersion ?? null),
        detail: {
          signature,
          unasked: common.unasked,
          permissions: common.log.permissions.map((p) => ({ toolCallId: p.toolCallId, decision: p.decision, option: p.option, why: p.why })),
          refusedClientMethods: common.log.refusedClientMethods,
          refused: common.log.refused,
          stopReason: common.log.prompt?.result ?? null,
          updateKinds: common.log.updateKinds,
          toolCalls: [...common.log.toolCalls.values()].map((c) => ({ id: c.id, titles: c.titles, kinds: c.kinds, statuses: c.statuses, decision: c.decision, asked: c.asked !== null })),
          ...own.detail,
        },
      };
    },

    classify(h: LegHandle): FailureClass | null {
      const signature = def.classifyText(acpErrorTexts(h));
      if (signature) return signature;
      const exit = h.exit as { refused?: string | null; timedOut?: boolean; recordDone?: boolean } | null;
      if (exit?.refused) return 'setup';
      if (exit?.timedOut && !exit.recordDone) return 'timeout';
      return null;
    },

    async cancel(h: LegHandle): Promise<void> {
      if (h.process) h.exit = await h.process.cancel();
    },
  };
  return adapter;
}
