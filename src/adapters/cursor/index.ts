import { existsSync, readFileSync } from 'node:fs';
import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, startHeadless, type CommandRunner } from '../../transport/headless.js';
import { fromNonceLine, type LegHandle, type LegState, type LegText, type Occupant, type Preflight, type Ratification, type RoundCtx, type SeatAdapter } from '../types.js';
import { CURSOR_FLOOR, CURSOR_LABEL, CURSOR_TESTED_VERSIONS } from './known.js';
import { cursorArgs, cursorEnv, cursorLegFiles, defaultCursorBin, prepareCursorConfig, readBrief } from './launch.js';
import { cursorPreflight } from './preflight.js';
import { classifyCursorText, ratifyCursorLeg, readCursorStream } from './ratify.js';

export { CURSOR_FLOOR, CURSOR_FORBIDDEN_FLAGS, CURSOR_LABEL, CURSOR_PERMISSIONS, CURSOR_READ_CALLS, CURSOR_READ_TOOLS, parseCursorVersion } from './known.js';
export { CURSOR_GATE_EVENTS, CURSOR_LOG_EVENTS, councilHookScript } from './hook.js';
export { CURSOR_ENV_ALLOW, cursorArgs, cursorCliConfig, cursorEnv, cursorHooks, cursorLegFiles, cursorVersionsDir, defaultCursorBin, prepareCursorConfig } from './launch.js';
export { cursorPreflight } from './preflight.js';
export { classifyCursorText, CURSOR_CLASS_OF_CHECK, CURSOR_FAILURE_PATTERNS, cursorFailureClass, ratifyCursorLeg, readCursorStream, readHookLog, type CursorRatifyInput } from './ratify.js';

/*
 * The cursor seat (plan 4.2): headless print mode on the versioned binary, the council-owned config dir and hook,
 * built from the documentation (D14: no live run in v1). Print mode is known to hang after its result, so the
 * done signal is the stream's `result` line, and the wall clock and process-group kill always apply.
 */

export interface CursorAdapterOptions {
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
  /** The node binary the council hook runs on. Default: this process's. */
  node?: string | undefined;
}

interface CursorLegData {
  effort: string | null;
  cliVersion: string | null;
}

export function createCursorAdapter(options: CursorAdapterOptions = {}): SeatAdapter {
  const runner = options.runner ?? runCommand;
  const binFor = (env: NodeJS.ProcessEnv): string | null => options.bin ?? defaultCursorBin(env);

  const adapter: SeatAdapter = {
    id: 'cursor',
    transport: 'headless',
    testedVersions: { floor: CURSOR_FLOOR, tested: CURSOR_TESTED_VERSIONS },
    enforcement: () => CURSOR_LABEL,

    async listModels(): Promise<ModelInfo[]> {
      const bin = binFor(process.env);
      if (bin === null) return [];
      const r = await runner(bin, ['models'], { cwd: process.cwd(), env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' }, timeoutMs: 30_000 });
      const slugs = [...new Set((r.stdout.match(/\b[a-z][a-z0-9.-]*[a-z0-9]\b/g) ?? []).filter((s) => /\d|-/.test(s)))];
      return slugs.map((id) => ({ id, family: /claude/.test(id) ? 'anthropic' : /gpt|^o\d/.test(id) ? 'openai' : /gemini/.test(id) ? 'google' : /grok/.test(id) ? 'xai' : 'cursor' }));
    },

    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> => {
      const env = ctx.env ?? process.env;
      return cursorPreflight(o, { bin: binFor(env), runner, env, root: ctx.root, legDir: ctx.legDir });
    },

    async launch(o: Occupant, ctx: RoundCtx, pre?: Preflight): Promise<LegHandle> {
      const p = pre ?? (await adapter.preflight(o, ctx));
      if (!p.ok) throw new Error(`cursor preflight failed: ${p.reason ?? 'unknown'}`);
      const env = ctx.env ?? process.env;
      const bin = binFor(env);
      if (bin === null) throw new Error('cursor-agent not installed');
      const files = cursorLegFiles(ctx.legDir);
      prepareCursorConfig(files, ctx.root, options.node);
      const data: CursorLegData = { effort: o.effort ?? null, cliVersion: p.cliVersion };
      const proc = startHeadless({
        command: bin,
        args: cursorArgs({ root: ctx.root, model: o.model, prompt: readBrief(ctx.briefFile) }),
        cwd: ctx.root,
        env: cursorEnv(env, files),
        stdoutFile: files.stream,
        stderrFile: files.stderr,
        timeoutMs: ctx.timeoutMs,
        pollMs: 250,
        // Print mode can hang after it has printed its result; the result line ends the leg, then the exit grace.
        exitGraceMs: 10_000,
        recordFile: files.process,
        isDone: () => readCursorStream(files.stream).result !== null,
      });
      return {
        backend: 'cursor',
        occupant: o,
        legDir: ctx.legDir,
        root: ctx.root,
        nonce: ctx.nonce,
        startedAt: proc.startedAt,
        process: proc,
        exit: null,
        files: { stream: files.stream, stderr: files.stderr, process: files.process, hookLog: files.hookLog },
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
      const r = readCursorStream(h.files['stream'] ?? '').result;
      const text = r && r['is_error'] === false && typeof r['result'] === 'string' ? r['result'] : null;
      return fromNonceLine(text, h.nonce, 'result');
    },

    async ratify(h: LegHandle, ctx: RoundCtx): Promise<Ratification> {
      if (h.process && !h.exit) h.exit = await h.process.exited;
      const d = h.data as unknown as CursorLegData;
      return ratifyCursorLeg({
        root: h.root,
        nonce: h.nonce,
        model: h.occupant.model,
        effort: d.effort,
        cliVersion: d.cliVersion,
        streamFile: h.files['stream'] ?? '',
        stderrFile: h.files['stderr'] ?? '',
        hookLog: h.files['hookLog'] ?? '',
        timedOut: h.exit?.timedOut ?? false,
        rootUnchanged: ctx.rootUnchanged,
      });
    },

    classify(h: LegHandle): FailureClass | null {
      const stderrFile = h.files['stderr'];
      const stderr = stderrFile !== undefined && existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : '';
      const signature = classifyCursorText([stderr, ...readCursorStream(h.files['stream'] ?? '').errors]);
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
