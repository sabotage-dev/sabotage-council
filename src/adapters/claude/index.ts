import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, scrubEnv, startHeadless, type CommandRunner, type HeadlessProcess } from '../../transport/headless.js';
import { fromNonceLine, type LegHandle, type LegState, type LegText, type Occupant, type Preflight, type Ratification, type RoundCtx, type SeatAdapter } from '../types.js';
import { CLAUDE_DECLARED, CLAUDE_FLOOR, CLAUDE_MODELS, CLAUDE_READ_TOOLS, CLAUDE_TESTED_VERSIONS, claudeDecl } from './known.js';
import { CLAUDE_ENV_ALLOW, CLAUDE_ENV_SET, CLAUDE_LEG_SETTINGS, claudeArgs } from './launch.js';
import { API_KEY_ROUTE, claudePreflight } from './preflight.js';
import { claudeProjectsDir, readClaudeStream } from './records.js';
import { claudeAnswer, claudeErrorTexts, classifyClaudeText, offeredTools, ratifyClaudeLeg } from './ratify.js';

export { CLAUDE_DECLARED, CLAUDE_MODELS, CLAUDE_READ_TOOLS, claudeDecl, modelMatches } from './known.js';
export { CLAUDE_ENV_ALLOW, claudeArgs } from './launch.js';
export { API_KEY_ROUTE, claudePreflight, parseAuthStatus, parseClaudeVersion } from './preflight.js';
export { findTranscript, readClaudeStream, toolPaths, transcriptFacts } from './records.js';
export { classifyClaudeText, CLAUDE_FAILURE_PATTERNS, claudeFailureClass, offeredTools, ratifyClaudeLeg, type ClaudeRatifyInput } from './ratify.js';

export interface ClaudeAdapterOptions {
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
  maxTurns?: number | undefined;
  maxBudgetUsd?: number | undefined;
  /**
   * Merged into the leg's settings JSON. Only the promotion canary uses it, to plant a user-side allow rule in
   * a temp settings file; a real leg passes nothing here.
   */
  settingsOverlay?: Record<string, unknown> | undefined;
}

interface ClaudeLegData {
  sessionId: string;
  effort: string;
  projectsDir: string;
  cliVersion: string;
  initGate: string | null;
}

function legData(h: LegHandle): ClaudeLegData {
  return h.data as unknown as ClaudeLegData;
}

/**
 * The init gate (plan 6.4, applied to seats too): once `system/init` appears, a leg offered anything beyond the
 * read set, or not in `dontAsk`, is stopped before its first turn can run a tool. A plugin tool here means the
 * settings-source isolation did not hold, so the message names the API-key route.
 */
export function initGateProblem(init: Record<string, unknown>): string | null {
  const offer = offeredTools(init);
  if (!offer.ok) return `system/init ${offer.problem}`;
  const extra = offer.tools.filter((t) => !(CLAUDE_READ_TOOLS as readonly string[]).includes(t));
  if (extra.length > 0) {
    const plugin = extra.some((t) => t.startsWith('mcp__'));
    return `system/init offered ${extra.join(', ')}${plugin ? `; plugin tools reached the leg: ${API_KEY_ROUTE}` : ''}`;
  }
  if (init['permissionMode'] !== 'dontAsk') return `system/init permissionMode ${String(init['permissionMode'])}, not dontAsk`;
  return null;
}

function mergeSettings(overlay: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = JSON.parse(JSON.stringify(CLAUDE_LEG_SETTINGS)) as Record<string, Record<string, unknown>>;
  if (!overlay) return base;
  const out: Record<string, unknown> = { ...base, ...overlay };
  const overlayPermissions = overlay['permissions'];
  if (typeof overlayPermissions === 'object' && overlayPermissions !== null) {
    out['permissions'] = { ...(overlayPermissions as Record<string, unknown>), ...base['permissions'] };
  }
  return out;
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): SeatAdapter {
  const bin = options.bin ?? 'claude';
  const runner = options.runner ?? runCommand;

  const adapter: SeatAdapter = {
    id: 'claude',
    transport: 'headless',
    testedVersions: { floor: CLAUDE_FLOOR, tested: CLAUDE_TESTED_VERSIONS },

    enforcement: (version) => claudeDecl(version)?.enforcement ?? 'pending',

    listModels: async (): Promise<ModelInfo[]> => CLAUDE_MODELS.map((id) => ({ id, family: 'anthropic' })),

    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> =>
      claudePreflight(o, { bin, runner, env: ctx.env ?? process.env, root: ctx.root }),

    async launch(o: Occupant, ctx: RoundCtx, pre?: Preflight): Promise<LegHandle> {
      const p = pre ?? (await adapter.preflight(o, ctx));
      if (!p.ok || p.cliVersion === null) throw new Error(`claude preflight failed: ${p.reason ?? 'unknown'}`);
      const decl = claudeDecl(p.cliVersion) ?? (CLAUDE_DECLARED[CLAUDE_FLOOR] as NonNullable<ReturnType<typeof claudeDecl>>);
      const sessionId = randomUUID();
      const effort = o.effort as string;
      const files = {
        stream: join(ctx.legDir, 'stream.jsonl'),
        stderr: join(ctx.legDir, 'stderr.log'),
        settings: join(ctx.legDir, 'settings.json'),
        process: join(ctx.legDir, 'process.json'),
      };
      // The settings file lives in the leg dir, outside the root, so the residue sweep never sees it.
      writeFileSync(files.settings, `${JSON.stringify(mergeSettings(options.settingsOverlay), null, 2)}\n`);
      const sourceEnv = ctx.env ?? process.env;
      const env = scrubEnv(sourceEnv, CLAUDE_ENV_ALLOW, CLAUDE_ENV_SET);
      const data: ClaudeLegData = {
        sessionId,
        effort,
        projectsDir: typeof p.data['projectsDir'] === 'string' ? p.data['projectsDir'] : claudeProjectsDir(sourceEnv),
        cliVersion: p.cliVersion,
        initGate: null,
      };
      let proc: HeadlessProcess | null = null;
      let gateChecked = false;
      proc = startHeadless({
        command: bin,
        args: claudeArgs({
          model: o.model,
          effort,
          sessionId,
          settingsFile: files.settings,
          decl,
          bare: p.data['bare'] === true,
          maxTurns: options.maxTurns,
          maxBudgetUsd: options.maxBudgetUsd,
        }),
        cwd: ctx.root,
        env,
        stdinFile: ctx.briefFile,
        stdoutFile: files.stream,
        stderrFile: files.stderr,
        timeoutMs: ctx.timeoutMs,
        pollMs: 250,
        recordFile: files.process,
        isDone: () => {
          const stream = readClaudeStream(files.stream);
          if (!gateChecked && stream.init) {
            gateChecked = true;
            const problem = initGateProblem(stream.init);
            if (problem) {
              data.initGate = problem;
              // SIGKILL at once: a SIGTERM grace would give the first turn time to run a tool.
              void proc?.cancel({ hard: true });
            }
          }
          return stream.result !== null;
        },
      });
      return {
        backend: 'claude',
        occupant: o,
        legDir: ctx.legDir,
        root: ctx.root,
        nonce: ctx.nonce,
        startedAt: proc.startedAt,
        process: proc,
        exit: null,
        files,
        data: data as unknown as Record<string, unknown>,
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
      return fromNonceLine(claudeAnswer(readClaudeStream(h.files['stream'] ?? '')), h.nonce, 'result');
    },

    async ratify(h: LegHandle, ctx: RoundCtx): Promise<Ratification> {
      if (h.process && !h.exit) h.exit = await h.process.exited;
      const d = legData(h);
      const r = ratifyClaudeLeg({
        root: h.root,
        nonce: h.nonce,
        model: h.occupant.model,
        effort: d.effort,
        sessionId: d.sessionId,
        cliVersion: d.cliVersion,
        streamFile: h.files['stream'] ?? '',
        stderrFile: h.files['stderr'] ?? '',
        projectsDir: d.projectsDir,
        timedOut: h.exit?.timedOut ?? false,
        rootUnchanged: ctx.rootUnchanged,
        initGate: d.initGate,
      });
      // The label is the one declared for the version the leg actually ran (system/init), not the preflight one.
      return { ...r, enforcement: adapter.enforcement(r.cliVersion) };
    },

    classify(h: LegHandle): FailureClass | null {
      const stream = readClaudeStream(h.files['stream'] ?? '');
      const stderrFile = h.files['stderr'];
      const stderr = stderrFile !== undefined && existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : '';
      const signature = classifyClaudeText(claudeErrorTexts(stream, stderr));
      if (signature) return signature;
      if (legData(h).initGate) return 'setup';
      if (h.exit?.timedOut && !h.exit.recordDone) return 'timeout';
      return null;
    },

    async cancel(h: LegHandle): Promise<void> {
      if (h.process) h.exit = await h.process.cancel();
    },
  };
  return adapter;
}
