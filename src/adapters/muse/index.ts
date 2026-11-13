import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { ModelInfo } from '../../config/registry.js';
import type { FailureClass } from '../../config/vocab.js';
import { runCommand, startHeadless, type CommandRunner } from '../../transport/headless.js';
import { str } from '../codex/records.js';
import { fromNonceLine, type LegHandle, type LegState, type LegText, type Occupant, type Preflight, type Ratification, type RoundCtx, type SeatAdapter } from '../types.js';
import { MUSE_FLOOR, MUSE_MODELS, MUSE_TESTED_VERSIONS, museDecl } from './known.js';
import { defaultMuseBin, museArgs, museEnv, museLegFiles, prepareMuseDirs } from './launch.js';
import { musePreflight } from './preflight.js';
import { classifyMuseText, museAnswer, ratifyMuseLeg, readMuseStream } from './ratify.js';

export { MUSE_DECLARED, MUSE_EFFORTS, MUSE_FORBIDDEN_FLAGS, MUSE_MODELS, MUSE_SAFETY_FLAGS, museDecl } from './known.js';
export { MUSE_ENV_ALLOW, MUSE_ENV_SET, defaultMuseBin, museArgs, museEnv, museLegFiles, userMuseAuthPath } from './launch.js';
export { musePreflight, parseMuseVersion } from './preflight.js';
export { classifyMuseText, findMuseSessionLog, MUSE_CLASS_OF_CHECK, MUSE_FAILURE_PATTERNS, museAnswer, museFailureClass, ratifyMuseLeg, type MuseRatifyInput } from './ratify.js';

export interface MuseAdapterOptions {
  bin?: string | undefined;
  runner?: CommandRunner | undefined;
  maxSteps?: number | undefined;
}

interface MuseLegData {
  sessionId: string;
  effort: string;
  cliVersion: string | null;
  exportError: string | null;
}

const legData = (h: LegHandle): MuseLegData => h.data as unknown as MuseLegData;

export function createMuseAdapter(options: MuseAdapterOptions = {}): SeatAdapter {
  const runner = options.runner ?? runCommand;
  const binFor = (env: NodeJS.ProcessEnv): string => options.bin ?? defaultMuseBin(env);

  const adapter: SeatAdapter = {
    id: 'muse',
    transport: 'headless',
    testedVersions: { floor: MUSE_FLOOR, tested: MUSE_TESTED_VERSIONS },
    enforcement: (version) => museDecl(version)?.enforcement ?? 'weak',
    listModels: async (): Promise<ModelInfo[]> => [...MUSE_MODELS],

    preflight: (o: Occupant, ctx: RoundCtx): Promise<Preflight> => {
      const env = ctx.env ?? process.env;
      return musePreflight(o, { bin: binFor(env), runner, env, root: ctx.root, legDir: ctx.legDir });
    },

    async launch(o: Occupant, ctx: RoundCtx, pre?: Preflight): Promise<LegHandle> {
      const p = pre ?? (await adapter.preflight(o, ctx));
      if (!p.ok) throw new Error(`muse preflight failed: ${p.reason ?? 'unknown'}`);
      const env = ctx.env ?? process.env;
      const files = museLegFiles(ctx.legDir);
      prepareMuseDirs(files);
      const data: MuseLegData = { sessionId: randomUUID(), effort: o.effort as string, cliVersion: p.cliVersion, exportError: null };
      const proc = startHeadless({
        command: binFor(env),
        args: museArgs({ sessionId: data.sessionId, root: ctx.root, model: o.model, effort: data.effort, briefFile: ctx.briefFile, maxSteps: options.maxSteps }),
        cwd: ctx.root,
        env: museEnv(env, files),
        stdoutFile: files.stream,
        stderrFile: files.stderr,
        timeoutMs: ctx.timeoutMs,
        pollMs: 250,
        recordFile: files.process,
        isDone: () => readMuseStream(files.stream).rows.some((r) => /^run\.terminal\./.test(str(r['payload_type']) ?? '')),
      });
      return {
        backend: 'muse',
        occupant: o,
        legDir: ctx.legDir,
        root: ctx.root,
        nonce: ctx.nonce,
        startedAt: proc.startedAt,
        process: proc,
        exit: null,
        files: { stream: files.stream, stderr: files.stderr, process: files.process, export: files.export, data: files.data },
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
      return fromNonceLine(museAnswer(readMuseStream(h.files['stream'] ?? '').rows), h.nonce, 'run.terminal.completed');
    },

    async ratify(h: LegHandle, ctx: RoundCtx): Promise<Ratification> {
      if (h.process && !h.exit) h.exit = await h.process.exited;
      const d = legData(h);
      const files = museLegFiles(h.legDir);
      const env = ctx.env ?? process.env;
      if (!existsSync(files.export)) {
        // Offline and deterministic (no model call): the export is the ratification record (plan 4.2).
        const r = await runner(binFor(env), ['export', '--session', d.sessionId, '--out', files.export], { cwd: h.root, env: museEnv(env, files), timeoutMs: 60_000 });
        if (r.error !== null || r.exitCode !== 0) d.exportError = r.error ?? `exit ${String(r.exitCode)}: ${r.stderr.trim().slice(0, 200)}`;
      }
      const r = ratifyMuseLeg({
        root: h.root,
        nonce: h.nonce,
        model: h.occupant.model,
        effort: d.effort,
        sessionId: d.sessionId,
        cliVersion: d.cliVersion,
        streamFile: files.stream,
        stderrFile: files.stderr,
        processFile: files.process,
        dataDir: files.data,
        exportFile: files.export,
        timedOut: h.exit?.timedOut ?? false,
        exitCode: h.exit?.exitCode ?? null,
        rootUnchanged: ctx.rootUnchanged,
      });
      return { ...r, durationMs: h.exit?.durationMs ?? null, detail: { ...r.detail, exportError: d.exportError } };
    },

    classify(h: LegHandle): FailureClass | null {
      const stderrFile = h.files['stderr'];
      const stderr = stderrFile !== undefined && existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : '';
      const signature = classifyMuseText([stderr, ...(h.exit?.exitCode === 2 ? ['exit-code 2'] : [])]);
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
