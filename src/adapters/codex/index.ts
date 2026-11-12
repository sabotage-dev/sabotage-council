import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, scrubEnv, startHeadless, type CommandRunner } from '../../transport/headless.js';
import type { LegHandle, LegState, LegText, Occupant, Preflight, Ratification, RoundCtx, SeatAdapter } from '../types.js';
import { CODEX_ENV_ALLOW, CODEX_ENV_SET, CODEX_READ_PREFACE, codexExecArgs, codexHomeOf } from './launch.js';
import { CODEX_TESTED_VERSIONS, codexDecl } from './native.js';
import { codexPreflight } from './preflight.js';
import { codexCollect, codexSignature, ratifyCodexLeg } from './ratify.js';
import { eventsDone, readEvents } from './records.js';

export { classifyCodexText, CODEX_FAILURE_PATTERNS } from './classify.js';
export {
  checkCommandPaths,
  READ_COMMAND_NAMES,
  READ_COMMANDS,
  readCommandUsage,
  sedScriptProblem,
  tokenizeShell,
  WRITE_DENIAL,
  type PathProblem,
  type ReadCommandRule,
  type ValueKind,
} from './cmd-paths.js';
export { scanExecInput, type ExecCall, type ExecScan } from './exec-input.js';
export { CODEX_ENV_ALLOW, CODEX_READ_PREFACE, codexConfigFlags, codexExecArgs, codexHomeOf } from './launch.js';
export { callRule, CODEX_DECLARED, codexDecl, type CallClass, type CodexVersionDecl } from './native.js';
export { codexPreflight, judgePromptInput, parseCodexVersion, promptInputTools } from './preflight.js';
export { codexFailureClass, ratifyCodexLeg, type CodexRatifyInput } from './ratify.js';

export interface CodexAdapterOptions {
  /** The codex binary. Default `codex` on the scrubbed PATH. */
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
}

interface CodexLegData {
  cliVersion: string;
  codexHome: string;
  effort: string;
}

function legData(h: LegHandle): CodexLegData {
  return h.data as unknown as CodexLegData;
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): SeatAdapter {
  const bin = options.bin ?? 'codex';
  const runner = options.runner ?? runCommand;

  const adapter: SeatAdapter = {
    id: 'codex',
    transport: 'headless',
    testedVersions: { floor: '0.167.0', tested: CODEX_TESTED_VERSIONS },

    enforcement: (version) => (codexDecl(version) ? 'sandboxed-exec' : 'pending'),

    async listModels(): Promise<ModelInfo[]> {
      const env = scrubEnv(process.env, CODEX_ENV_ALLOW, CODEX_ENV_SET);
      const out = await runner(bin, ['debug', 'models'], { cwd: tmpdir(), env, timeoutMs: 60_000 });
      const parsed = JSON.parse(out.stdout) as { models?: Array<{ slug?: unknown }> };
      return (parsed.models ?? [])
        .map((m) => m.slug)
        .filter((s): s is string => typeof s === 'string')
        .map((id) => ({ id, family: 'openai' }));
    },

    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> =>
      codexPreflight(o, { bin, runner, env: ctx.env ?? process.env, root: ctx.root }),

    async launch(o: Occupant, ctx: RoundCtx, pre?: Preflight): Promise<LegHandle> {
      const p = pre ?? (await adapter.preflight(o, ctx));
      if (!p.ok || p.cliVersion === null) throw new Error(`codex preflight failed: ${p.reason ?? 'unknown'}`);
      const mcpNames = (p.data['mcpNames'] as string[] | undefined) ?? [];
      const effort = o.effort as string;
      const files = {
        events: join(ctx.legDir, 'events.jsonl'),
        stderr: join(ctx.legDir, 'stderr.log'),
        last: join(ctx.legDir, 'last.txt'),
        process: join(ctx.legDir, 'process.json'),
        prompt: join(ctx.legDir, 'prompt.md'),
      };
      // The codex seat's stdin: the read preface, then the brief unchanged.
      writeFileSync(files.prompt, CODEX_READ_PREFACE + readFileSync(ctx.briefFile, 'utf8'));
      const sourceEnv = ctx.env ?? process.env;
      const env = scrubEnv(sourceEnv, CODEX_ENV_ALLOW, CODEX_ENV_SET);
      const proc = startHeadless({
        command: bin,
        args: codexExecArgs({ root: ctx.root, model: o.model, effort, mcpNames, lastFile: files.last }),
        cwd: ctx.root,
        env,
        stdinFile: files.prompt,
        stdoutFile: files.events,
        stderrFile: files.stderr,
        timeoutMs: ctx.timeoutMs,
        recordFile: files.process,
        isDone: () => eventsDone(files.events),
      });
      const data: CodexLegData = { cliVersion: p.cliVersion, codexHome: codexHomeOf(sourceEnv), effort };
      return {
        backend: 'codex',
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
      const d = legData(h);
      return codexCollect({
        codexHome: d.codexHome,
        eventsFile: h.files['events'] ?? '',
        lastFile: h.files['last'] ?? '',
        nonce: h.nonce,
        startedAt: h.startedAt,
      });
    },

    async ratify(h: LegHandle, ctx: RoundCtx): Promise<Ratification> {
      if (h.process && !h.exit) h.exit = await h.process.exited;
      const d = legData(h);
      return ratifyCodexLeg({
        root: h.root,
        nonce: h.nonce,
        model: h.occupant.model,
        effort: d.effort,
        cliVersion: d.cliVersion,
        codexHome: d.codexHome,
        eventsFile: h.files['events'] ?? '',
        stderrFile: h.files['stderr'] ?? '',
        lastFile: h.files['last'] ?? '',
        startedAt: h.startedAt,
        timedOut: h.exit?.timedOut ?? false,
        rootUnchanged: ctx.rootUnchanged,
      });
    },

    classify(h: LegHandle): FailureClass | null {
      const signature = codexSignature(readEvents(h.files['events'] ?? ''), h.files['stderr'] ?? '');
      if (signature) return signature;
      if (h.exit?.timedOut && !h.exit.recordDone) return 'timeout';
      return null;
    },

    async cancel(h: LegHandle): Promise<void> {
      if (h.process) h.exit = await h.process.cancel();
    },
  };
  return adapter;
}
