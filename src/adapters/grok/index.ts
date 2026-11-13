import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, startHeadless, type CommandRunner, type HeadlessProcess } from '../../transport/headless.js';
import { readClaudeStream } from '../claude/records.js';
import { fromNonceLine, type LegHandle, type LegState, type LegText, type Occupant, type Preflight, type Ratification, type RoundCtx, type SeatAdapter } from '../types.js';
import { GROK_FLOOR, GROK_MODELS, GROK_TESTED_VERSIONS, grokDecl, type GrokSandbox } from './known.js';
import { defaultGrokBin, grokArgs, grokEnv, grokLegFiles, legGrokHome, prepareGrokHomes, type GrokRoute } from './launch.js';
import { grokPreflight } from './preflight.js';
import { copyGrokSession, findGrokSession } from './records.js';
import { classifyGrokText, grokAnswer, grokErrorTexts, ratifyGrokLeg } from './ratify.js';

export { GROK_DECLARED, GROK_DENY_RULES, GROK_DISALLOWED_TOOLS, GROK_MODELS, GROK_READ_TOOLS, grokDecl, grokLabel, grokModelMatches } from './known.js';
export { GROK_ENV_ALLOW, GROK_ENV_SET, defaultGrokBin, grokArgs, grokEnv, grokLegFiles, legGrokHome, userGrokHome } from './launch.js';
export { dockerSocketLink, grokEffortMenu, grokPreflight, parseGrokInspect, parseGrokModels, parseGrokVersion } from './preflight.js';
export { findGrokSession, readGrokSession } from './records.js';
export { classifyGrokText, GROK_CLASS_OF_CHECK, GROK_FAILURE_PATTERNS, GROK_READS, grokErrorTexts, grokFailureClass, ratifyGrokLeg, type GrokRatifyInput } from './ratify.js';

export interface GrokAdapterOptions {
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
  maxTurns?: number | undefined;
  /**
   * Allow rules added to the command line. Only the promotion canary uses it (a planted user-side allow rule passed
   * explicitly); preflight refuses any.
   */
  allowRules?: readonly string[] | undefined;
  /** No `system/init` within this long means a stalled start (a sign-in wait): the group is killed. Default 90 s. */
  startupMs?: number | undefined;
  dockerSocket?: string | undefined;
}

interface GrokLegData {
  sessionId: string;
  effort: string;
  sandbox: GrokSandbox;
  grokHome: string;
  route: GrokRoute;
  cliVersion: string | null;
  startupHang: boolean;
  sessionCopy: string | null;
}

const legData = (h: LegHandle): GrokLegData => h.data as unknown as GrokLegData;

export function createGrokAdapter(options: GrokAdapterOptions = {}): SeatAdapter {
  const runner = options.runner ?? runCommand;
  const binFor = (env: NodeJS.ProcessEnv): string => options.bin ?? defaultGrokBin(env);

  const adapter: SeatAdapter = {
    id: 'grok',
    transport: 'headless',
    testedVersions: { floor: GROK_FLOOR, tested: GROK_TESTED_VERSIONS },

    // The best label a version can carry (sandbox running, no MCP); a leg's own label comes from its records.
    enforcement: (version) => grokDecl(version)?.sandboxed ?? 'weak',

    listModels: async (): Promise<ModelInfo[]> => [...GROK_MODELS],

    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> => {
      const env = ctx.env ?? process.env;
      return grokPreflight(o, { bin: binFor(env), runner, env, root: ctx.root, legDir: ctx.legDir, allowRules: options.allowRules, dockerSocket: options.dockerSocket });
    },

    async launch(o: Occupant, ctx: RoundCtx, pre?: Preflight): Promise<LegHandle> {
      const p = pre ?? (await adapter.preflight(o, ctx));
      if (!p.ok) throw new Error(`grok preflight failed: ${p.reason ?? 'unknown'}`);
      const sourceEnv = ctx.env ?? process.env;
      const files = grokLegFiles(ctx.legDir);
      const { grokHome, route } = legGrokHome(sourceEnv, files, o.authHome);
      if (grokHome === null) throw new Error('no grok home');
      prepareGrokHomes(files, route);
      const sessionId = randomUUID();
      const sandbox: GrokSandbox = o.sandbox ?? 'read-only';
      const data: GrokLegData = { sessionId, effort: o.effort as string, sandbox, grokHome, route, cliVersion: p.cliVersion, startupHang: false, sessionCopy: null };
      const startupMs = options.startupMs ?? 90_000;
      let proc: HeadlessProcess | null = null;
      const started = Date.now();
      proc = startHeadless({
        command: binFor(sourceEnv),
        args: grokArgs({ briefFile: ctx.briefFile, root: ctx.root, sessionId, model: o.model, effort: data.effort, sandbox, maxTurns: options.maxTurns, allowRules: options.allowRules }),
        cwd: ctx.root,
        env: grokEnv(sourceEnv, files.home, grokHome, route),
        stdoutFile: files.stream,
        stderrFile: files.stderr,
        timeoutMs: ctx.timeoutMs,
        pollMs: 250,
        recordFile: files.process,
        isDone: () => {
          const stream = readClaudeStream(files.stream);
          if (stream.init === null && !data.startupHang && Date.now() - started > startupMs) {
            data.startupHang = true;
            void proc?.cancel({ hard: true });
          }
          return stream.result !== null;
        },
      });
      return {
        backend: 'grok',
        occupant: o,
        legDir: ctx.legDir,
        root: ctx.root,
        nonce: ctx.nonce,
        startedAt: proc.startedAt,
        process: proc,
        exit: null,
        files: { stream: files.stream, stderr: files.stderr, process: files.process, session: files.session },
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
      return fromNonceLine(grokAnswer(readClaudeStream(h.files['stream'] ?? '')), h.nonce, 'result');
    },

    async ratify(h: LegHandle, ctx: RoundCtx): Promise<Ratification> {
      if (h.process && !h.exit) h.exit = await h.process.exited;
      const d = legData(h);
      const found = findGrokSession(d.grokHome, d.sessionId);
      if (found.path !== null && h.files['session'] !== undefined && !existsSync(h.files['session'])) d.sessionCopy = copyGrokSession(found.path, h.files['session']);
      const r = ratifyGrokLeg({
        root: h.root,
        nonce: h.nonce,
        model: h.occupant.model,
        effort: d.effort,
        sandbox: d.sandbox,
        sessionId: d.sessionId,
        cliVersion: d.cliVersion,
        streamFile: h.files['stream'] ?? '',
        stderrFile: h.files['stderr'] ?? '',
        grokHome: d.grokHome,
        timedOut: h.exit?.timedOut ?? false,
        rootUnchanged: ctx.rootUnchanged,
      });
      return { ...r, detail: { ...r.detail, route: d.route, startupHang: d.startupHang, sessionCopyError: d.sessionCopy } };
    },

    classify(h: LegHandle): FailureClass | null {
      const stderrFile = h.files['stderr'];
      const stderr = stderrFile !== undefined && existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : '';
      const signature = classifyGrokText(grokErrorTexts(h.files['stream'] ?? '', stderr));
      if (signature) return signature;
      if (legData(h).startupHang) return 'auth';
      if (h.exit?.timedOut && !h.exit.recordDone) return 'timeout';
      return null;
    },

    async cancel(h: LegHandle): Promise<void> {
      if (h.process) h.exit = await h.process.cancel();
    },
  };
  return adapter;
}
