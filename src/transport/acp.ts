import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { groupAlive, killGroupNow, terminateGroup, type DoneBy, type HeadlessExit, type HeadlessProcess } from './headless.js';

/*
 * The ACP transport (plan 4.1): the engine is an Agent Client Protocol client over the agent's stdio
 * (newline-delimited JSON-RPC 2.0). The agent runs under the same supervision as a headless leg: its own process
 * group (`detached`), cwd = the root, an explicit (scrubbed) environment, a wall-clock cap that kills the whole
 * group, and a process record in the leg dir.
 *
 * The client:
 *   - declares no filesystem and no terminal capability;
 *   - opens one session with cwd = the root and `mcpServers: []`;
 *   - applies the adapter's pins (model, effort, mode) through `session/set_config_option` or `session/set_mode`,
 *     records which one it used, and refuses the session (no prompt is sent) when the agent reports any other
 *     value;
 *   - sends the brief with `session/prompt`;
 *   - answers every `session/request_permission` through the adapter's policy (reject unless an in-root read);
 *   - refuses every other agent-to-client request (`fs/*`, `terminal/*`, anything else) with "method not found";
 *   - writes every message in both directions, verbatim, plus its own decisions, to the update log (JSONL).
 *
 * The update log is the record the ratifier reads, so every decision the client takes is in it.
 */

/** One pin the client applies before the prompt. */
export type AcpPin =
  | { via: 'set_config_option'; configId: string; value: string }
  | { via: 'set_mode'; modeId: string }
  /** Pinned by launch flags (kiro on the v2 engine); the client only checks what the agent reports, if anything. */
  | { via: 'launch'; configId: string; value: string };

/** What the `tool_call` and `tool_call_update` notifications said about one tool call so far. */
export interface KnownToolCall {
  /** Merged fields (later values win): for display only. */
  fields: Record<string, unknown>;
  kinds: string[];
  /** Every update as reported, in order. The policy judges all of them: an earlier path is never erased. */
  snapshots: Array<Record<string, unknown>>;
  /** The params of every permission request for the call, this one included, in order (round 2). */
  requests: Array<Record<string, unknown>>;
}

export interface PermissionDecision {
  allow: boolean;
  why: string;
}

export interface AcpSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The complete child environment. Nothing is inherited. Build it with `scrubEnv`. */
  env: Readonly<Record<string, string>>;
  /** The update log (JSONL): every message both ways, verbatim, and every client decision. */
  logFile: string;
  stderrFile: string;
  recordFile?: string | undefined;
  /** Sent as `session/new` cwd (the root, a realpath). */
  sessionCwd: string;
  /** The brief, sent as one text block. */
  promptText: string;
  /** Pins applied in order before the prompt. */
  pins: readonly AcpPin[];
  /**
   * Answers one `session/request_permission`. `known` returns what earlier `tool_call` updates said about a tool
   * call (merged fields, and every kind it was reported with). Never throws (a throw is a reject).
   */
  onPermission: (params: Record<string, unknown>, known: (toolCallId: string) => KnownToolCall | undefined) => PermissionDecision;
  timeoutMs: number;
  /** Default 5000. */
  killGraceMs?: number | undefined;
  /** After the agent exits, how long the client waits for its stdio to close (late output). Default 3000. */
  closeGraceMs?: number | undefined;
  /** On the wall-clock cap, how long after `session/cancel` the group is killed. Default 2000. */
  cancelGraceMs?: number | undefined;
  /** After the prompt response, how long the agent may take to exit once stdin closes. Default 10000. */
  exitGraceMs?: number | undefined;
  /**
   * A line on stderr or a non-JSON stdout line matching this kills the group at once (for example a browser sign-in
   * prompt that would otherwise hang for minutes).
   */
  killOn?: RegExp | undefined;
  clientName?: string | undefined;
  clientVersion?: string | undefined;
}

export interface AcpExit extends HeadlessExit {
  /** Where the client stopped: the last phase it reached. */
  phase: AcpPhase;
  /** The session id from `session/new`, once known. */
  sessionId: string | null;
  /** Set when the client refused the session before the prompt (a pin did not hold, or a pin failed). */
  refused: string | null;
  /** The line that matched `killOn`, if one did. */
  killedOn: string | null;
  /**
   * The agent exited but its stdout did not close within `closeGraceMs` (a process of its group held it open), so
   * output may be missing from the log. The ratifier fails `log` on it: an incomplete log is never a PASS.
   */
  closeTimedOut: boolean;
}

export type AcpPhase = 'spawn' | 'initialize' | 'session' | 'pins' | 'prompt' | 'done';

export interface AcpProcess extends HeadlessProcess {
  readonly exited: Promise<AcpExit>;
  cancel(options?: { hard?: boolean }): Promise<AcpExit>;
}

interface Pending {
  method: string;
  resolve: (msg: Record<string, unknown>) => void;
}

/** Config option ids and their current values, from a `configOptions` list. */
export function configValues(options: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(options)) return out;
  for (const o of options) {
    if (typeof o !== 'object' || o === null) continue;
    const id = (o as Record<string, unknown>)['id'] ?? (o as Record<string, unknown>)['configId'];
    const value = (o as Record<string, unknown>)['currentValue'];
    if (typeof id === 'string' && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) out[id] = String(value);
  }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Starts an ACP agent and drives one session through to the prompt's end. Never throws. */
export function startAcp(spec: AcpSpec): AcpProcess {
  const killGraceMs = spec.killGraceMs ?? 5000;
  const exitGraceMs = spec.exitGraceMs ?? 10_000;
  const cancelGraceMs = spec.cancelGraceMs ?? 2000;
  const closeGraceMs = spec.closeGraceMs ?? 3000;
  const startedAt = new Date();
  const t0 = startedAt.getTime();

  let logError: string | null = null;
  const log = (entry: Record<string, unknown>): void => {
    try {
      appendFileSync(spec.logFile, `${JSON.stringify({ t: Date.now() - t0, ...entry })}\n`);
    } catch (error) {
      logError = error instanceof Error ? error.message : String(error);
    }
  };
  try {
    writeFileSync(spec.logFile, '');
  } catch (error) {
    logError = error instanceof Error ? error.message : String(error);
  }

  let stderrFd: number | null = null;
  try {
    stderrFd = openSync(spec.stderrFile, 'w');
  } catch {
    stderrFd = null;
  }

  let child: ChildProcess | null = null;
  let spawnError: string | null = null;
  try {
    child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }
  const pid = child?.pid ?? null;

  let recordError: string | null = null;
  const writeRecord = (exit: AcpExit | null): void => {
    if (spec.recordFile === undefined) return;
    const record = {
      transport: 'acp',
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env_names: Object.keys(spec.env).sort(),
      log: spec.logFile,
      stderr: spec.stderrFile,
      timeout_ms: spec.timeoutMs,
      pid,
      pgid: pid,
      started_at: startedAt.toISOString(),
      exit,
    };
    try {
      writeFileSync(spec.recordFile, `${JSON.stringify(record, null, 2)}\n`);
    } catch (error) {
      const message = `${exit === null ? 'start' : 'exit'}: ${error instanceof Error ? error.message : String(error)}`;
      recordError = recordError === null ? message : `${recordError}; ${message}`;
    }
  };
  writeRecord(null);

  let alive = pid !== null;
  let phase: AcpPhase = 'spawn';
  let sessionId: string | null = null;
  let refused: string | null = null;
  let killedOn: string | null = null;
  let closeTimedOut = false;
  let promptDone = false;
  let timedOut = false;
  let cancelled = false;
  let killedAfterDone = false;
  let sigkilled = false;
  let killing: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const kill = (hard = false): Promise<void> => {
    if (pid === null) return Promise.resolve();
    if (hard) {
      const now = killGroupNow(pid).then((wasAlive) => {
        if (wasAlive) sigkilled = true;
      });
      killing = killing ? Promise.all([killing, now]).then(() => undefined) : now;
      return killing;
    }
    if (!killing) {
      killing = terminateGroup(pid, killGraceMs).then((hardKill) => {
        if (hardKill) sigkilled = true;
      });
    }
    return killing;
  };

  const write = (msg: Record<string, unknown>): void => {
    log({ dir: 'send', msg });
    if (!alive || !child?.stdin || child.stdin.destroyed) return;
    try {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // The agent closed its stdin; the exit handler ends the leg.
    }
  };

  /** Sends a request; resolves with the response message, or a synthetic error when the agent exits first. */
  const request = (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { method, resolve });
      write({ jsonrpc: '2.0', id, method, params });
    });
  };
  const notify = (method: string, params: Record<string, unknown>): void => write({ jsonrpc: '2.0', method, params });
  const reply = (id: unknown, body: { result: unknown } | { error: { code: number; message: string } }): void =>
    write({ jsonrpc: '2.0', id, ...body });

  const watchKill = (line: string, source: string): void => {
    if (spec.killOn === undefined || killedOn !== null) return;
    if (spec.killOn.test(line)) {
      killedOn = line.slice(0, 500);
      log({ dir: 'client', event: 'kill-pattern', source, line: killedOn });
      void kill(true);
    }
  };

  const toolCalls = new Map<string, KnownToolCall>();
  let current: Record<string, string> = {};
  let currentModeId: string | null = null;
  const absorb = (result: unknown): void => {
    if (!isObject(result)) return;
    current = { ...current, ...configValues(result['configOptions']) };
    // The older `modes` and `models` fields (kiro's v2 engine reports only these).
    const modes = result['modes'];
    if (isObject(modes) && typeof modes['currentModeId'] === 'string') {
      currentModeId = modes['currentModeId'];
      if (current['mode'] === undefined) current = { ...current, mode: modes['currentModeId'] };
    }
    const models = result['models'];
    if (isObject(models) && typeof models['currentModelId'] === 'string' && current['model'] === undefined) current = { ...current, model: models['currentModelId'] };
  };

  const onAgentRequest = (msg: Record<string, unknown>): void => {
    const method = String(msg['method']);
    const params = isObject(msg['params']) ? msg['params'] : {};
    if (method === 'session/request_permission') {
      // The request joins its call's live state before the decision, so a later request is judged with every
      // earlier one (its toolCall and its extra paths), not only with the notifications.
      const requested = isObject(params['toolCall']) ? params['toolCall'] : {};
      const requestedId = requested['toolCallId'];
      if (typeof requestedId === 'string') {
        const prior = toolCalls.get(requestedId) ?? { fields: {}, kinds: [], snapshots: [], requests: [] };
        prior.requests.push(params);
        toolCalls.set(requestedId, prior);
      }
      let decision: PermissionDecision;
      try {
        decision = spec.onPermission(params, (id) => toolCalls.get(id));
      } catch (error) {
        decision = { allow: false, why: `policy threw: ${error instanceof Error ? error.message : String(error)}` };
      }
      const options = Array.isArray(params['options']) ? params['options'].filter(isObject) : [];
      const byKind = (kind: string): Record<string, unknown> | undefined => options.find((o) => o['kind'] === kind);
      // Never an "always" option, grant or reject: either would persist a rule in the agent's settings (for a kiro
      // seat on the user's HOME, the user's own). With no `_once` option on offer the answer is `cancelled`.
      const allowOnce = decision.allow ? byKind('allow_once') : undefined;
      const pick = allowOnce ?? byKind('reject_once');
      const allow = allowOnce !== undefined;
      const outcome = pick ? { outcome: 'selected', optionId: pick['optionId'] } : { outcome: 'cancelled' };
      const toolCall = isObject(params['toolCall']) ? params['toolCall'] : {};
      log({
        dir: 'client',
        event: 'permission',
        toolCallId: toolCall['toolCallId'] ?? null,
        decision: allow ? 'allow' : 'reject',
        option: pick?.['kind'] ?? 'cancelled',
        why: decision.allow && !allow ? `${decision.why}; but no allow_once option was offered` : decision.why,
      });
      reply(msg['id'], { result: { outcome } });
      return;
    }
    // No filesystem, terminal or other client capability was declared: refuse.
    log({ dir: 'client', event: 'refused-client-method', method });
    reply(msg['id'], { error: { code: -32601, message: `the council client refuses ${method} (no client capabilities)` } });
  };

  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      log({ dir: 'recv-raw', line });
      watchKill(line, 'stdout');
      return;
    }
    if (!isObject(msg)) {
      log({ dir: 'recv-raw', line });
      return;
    }
    log({ dir: 'recv', msg });
    const id = msg['id'];
    if (id === undefined && msg['method'] === 'session/update' && isObject(msg['params']) && isObject(msg['params']['update'])) {
      const update = msg['params']['update'];
      if (update['sessionUpdate'] === 'config_option_update') absorb(update);
      if ((update['sessionUpdate'] === 'tool_call' || update['sessionUpdate'] === 'tool_call_update') && typeof update['toolCallId'] === 'string') {
        const prior = toolCalls.get(update['toolCallId']) ?? { fields: {}, kinds: [], snapshots: [], requests: [] };
        prior.snapshots.push(update);
        for (const [k, v] of Object.entries(update)) if (v !== undefined && v !== null) prior.fields[k] = v;
        if (typeof update['kind'] === 'string' && !prior.kinds.includes(update['kind'])) prior.kinds.push(update['kind']);
        toolCalls.set(update['toolCallId'], prior);
      }
      if (update['sessionUpdate'] === 'current_mode_update' && typeof update['currentModeId'] === 'string') {
        currentModeId = update['currentModeId'];
        current = { ...current, mode: update['currentModeId'] };
      }
    }
    if (id !== undefined && typeof msg['method'] === 'string') {
      onAgentRequest(msg);
    } else if (id !== undefined) {
      const p = typeof id === 'number' ? pending.get(id) : undefined;
      if (p) {
        pending.delete(id as number);
        p.resolve(msg);
      }
    }
  };

  // A multibyte character split across two chunks must not be decoded per chunk (it would corrupt a path).
  const stdoutText = new StringDecoder('utf8');
  const stderrText = new StringDecoder('utf8');
  let buffer = '';
  child?.stdout?.on('data', (chunk: Buffer) => {
    buffer += stdoutText.write(chunk);
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onLine(line);
    }
  });
  let stderrTail = '';
  child?.stderr?.on('data', (chunk: Buffer) => {
    if (stderrFd !== null) {
      try {
        appendFileSync(stderrFd, chunk);
      } catch {
        // Supervision goes on without the stderr copy.
      }
    }
    stderrTail = (stderrTail + stderrText.write(chunk)).slice(-4096);
    for (const line of stderrTail.split('\n')) watchKill(line, 'stderr');
  });
  child?.stdin?.on('error', () => {
    // EPIPE after the agent exits; the exit handler ends the leg.
  });

  const closeStdin = (): void => {
    try {
      child?.stdin?.end();
    } catch {
      // Already closed.
    }
  };

  const refuse = (reason: string): void => {
    refused = reason;
    log({ dir: 'client', event: 'refused', phase, reason });
  };

  const rpcError = (res: Record<string, unknown>): string | null => {
    const e = res['error'];
    if (e === undefined) return null;
    if (isObject(e)) return `${String(e['message'] ?? 'error')}${e['data'] !== undefined ? ` ${JSON.stringify(e['data'])}` : ''}`;
    return String(e);
  };

  const drive = async (): Promise<void> => {
    if (!alive) return;
    phase = 'initialize';
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: spec.clientName ?? 'sabotage-council', version: spec.clientVersion ?? '0.0.0' },
    });
    if (rpcError(init) !== null || !isObject(init['result'])) return;

    phase = 'session';
    const created = await request('session/new', { cwd: spec.sessionCwd, mcpServers: [] });
    if (rpcError(created) !== null || !isObject(created['result'])) return;
    const result = created['result'];
    sessionId = typeof result['sessionId'] === 'string' ? result['sessionId'] : null;
    if (sessionId === null) {
      refuse('session/new returned no sessionId');
      return;
    }
    absorb(result);

    phase = 'pins';
    for (const pin of spec.pins) {
      if (pin.via === 'launch') continue;
      const res =
        pin.via === 'set_config_option'
          ? await request('session/set_config_option', { sessionId, configId: pin.configId, value: pin.value })
          : await request('session/set_mode', { sessionId, modeId: pin.modeId });
      const error = rpcError(res);
      const name = pin.via === 'set_config_option' ? `${pin.configId}=${pin.value}` : `mode ${pin.modeId}`;
      if (error !== null) {
        refuse(`the agent did not accept ${name} via ${pin.via}: ${error}`);
        return;
      }
      absorb(res['result']);
      if (pin.via === 'set_mode') currentModeId = pin.modeId;
    }
    // Every pin must hold as the agent reports it, before the prompt.
    for (const pin of spec.pins) {
      const id = pin.via === 'set_mode' ? 'mode' : pin.configId;
      const want = pin.via === 'set_mode' ? pin.modeId : pin.value;
      const reported = current[id] ?? (id === 'mode' ? currentModeId : null) ?? null;
      if (reported === null && pin.via === 'launch') continue;
      if (reported !== want) {
        refuse(`the agent reports ${id} = ${String(reported)}, not ${want}`);
        return;
      }
    }
    log({ dir: 'client', event: 'pins-held', pins: spec.pins, reported: current, currentModeId });

    phase = 'prompt';
    const prompt = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: spec.promptText }] });
    if (rpcError(prompt) === null) {
      promptDone = true;
      phase = 'done';
    }
  };

  const exited = new Promise<AcpExit>((resolve) => {
    let finished = false;
    const finish = async (exitCode: number | null, signal: string | null, error: string | null): Promise<void> => {
      if (finished) return;
      finished = true;
      alive = false;
      clearTimeout(cap);
      buffer += stdoutText.end();
      if (buffer.trim() !== '') log({ dir: 'recv-torn', line: buffer });
      for (const [id, p] of pending) {
        pending.delete(id);
        p.resolve({ jsonrpc: '2.0', id, error: { code: -32099, message: `the agent exited before answering ${p.method}` }, synthetic: true });
      }
      let leftoverKilled = false;
      if (pid !== null) {
        if (killing) await killing;
        if (groupAlive(pid)) {
          leftoverKilled = true;
          if (await terminateGroup(pid, killGraceMs)) sigkilled = true;
        }
      }
      if (stderrFd !== null) {
        try {
          closeSync(stderrFd);
        } catch {
          // Already closed.
        }
      }
      const endedAt = new Date();
      const doneBy: DoneBy =
        error !== null && pid === null ? 'spawn-error' : cancelled ? 'cancel' : promptDone ? 'record' : timedOut ? 'timeout' : 'exit';
      const record: AcpExit = {
        pid,
        pgid: pid,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - t0,
        exitCode,
        signal,
        doneBy,
        recordDone: promptDone,
        timedOut,
        cancelled,
        killedAfterDone,
        leftoverKilled,
        sigkilled,
        spawnError: error,
        recordError: [recordError, logError].filter((e) => e !== null).join('; ') || null,
        phase,
        sessionId,
        refused,
        killedOn,
        closeTimedOut,
      };
      log({ dir: 'client', event: 'exit', exit: record });
      writeRecord(record);
      record.recordError = [recordError, logError].filter((e) => e !== null).join('; ') || null;
      resolve(record);
    };

    const cap = setTimeout(() => {
      if (!alive) return;
      timedOut = true;
      log({ dir: 'client', event: 'timeout', phase });
      if (sessionId !== null) {
        // Give the agent a moment to end its turn on session/cancel, then the group goes.
        notify('session/cancel', { sessionId });
        const after = setTimeout(() => void kill(), cancelGraceMs);
        after.unref();
      } else {
        void kill();
      }
    }, spec.timeoutMs);
    cap.unref();

    if (child === null || pid === null) {
      const reason = spawnError ?? 'spawn failed';
      if (child) child.once('error', (e) => void finish(null, null, e.message));
      else void finish(null, null, reason);
      return;
    }
    child.once('error', (e) => {
      spawnError = e.message;
    });
    // The leg ends on `close` (the agent exited and every holder of its stdio closed), so trailing stdout is kept.
    // A process of the group that holds stdout open is given `closeGraceMs`, then the leg ends and the group goes.
    child.once('exit', (code, signal) => {
      const grace = setTimeout(() => {
        closeTimedOut = true;
        log({ dir: 'client', event: 'close-timeout', closeGraceMs });
        void finish(code, signal, spawnError);
      }, closeGraceMs);
      grace.unref();
      child.once('close', () => {
        clearTimeout(grace);
        void finish(code, signal, spawnError);
      });
    });

    void drive()
      .catch((e: unknown) => {
        log({ dir: 'client', event: 'client-error', message: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (!alive) return;
        // The session is over (answered, refused or failed): close stdin, give the agent a grace, then the group.
        if (refused !== null && sessionId !== null) notify('session/cancel', { sessionId });
        closeStdin();
        const grace = setTimeout(() => {
          if (alive) {
            if (promptDone) killedAfterDone = true;
            void kill();
          }
        }, refused !== null ? Math.min(exitGraceMs, 2000) : exitGraceMs);
        grace.unref();
      });
  });

  return {
    pid,
    startedAt,
    exited,
    running: () => alive,
    recordDone: () => promptDone,
    cancel: async (options = {}) => {
      if (alive) {
        cancelled = true;
        log({ dir: 'client', event: 'cancel', hard: options.hard === true });
        if (sessionId !== null) notify('session/cancel', { sessionId });
        closeStdin();
        await kill(options.hard === true);
      }
      return exited;
    },
  };
}
