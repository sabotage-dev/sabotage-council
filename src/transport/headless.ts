import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';

/*
 * The headless transport (plan 4.1): a small Node supervisor that replaces `setsid` and `timeout`, which stock
 * macOS lacks. Each CLI runs in its own process group (`detached: true` makes the child a session and group
 * leader), with cwd = the root, an explicit environment, stdin from a file or /dev/null, and stdout/stderr in
 * files in the leg dir. A wall-clock cap kills the whole group (SIGTERM, then SIGKILL). The done signal is the
 * adapter's record check; process exit is the secondary signal.
 */

export interface HeadlessSpec {
  command: string;
  args: readonly string[];
  cwd: string;
  /** The complete child environment. Nothing is inherited. Build it with `scrubEnv`. */
  env: Readonly<Record<string, string>>;
  /** The child's stdin. Absent: /dev/null. */
  stdinFile?: string | undefined;
  stdoutFile: string;
  stderrFile: string;
  /** Wall-clock cap. On expiry the process group gets SIGTERM, then SIGKILL after `killGraceMs`. */
  timeoutMs: number;
  /** Default 5000. */
  killGraceMs?: number | undefined;
  /** How often `isDone` is checked. Default 500. */
  pollMs?: number | undefined;
  /** The record-based done signal (adapter-defined). */
  isDone?: (() => boolean) | undefined;
  /** After `isDone` turns true, how long the CLI may take to exit before its group is killed. Default 30000. */
  exitGraceMs?: number | undefined;
  /** Where to write the process record (argv, env names, pid, timing, exit). */
  recordFile?: string | undefined;
}

export type DoneBy = 'record' | 'exit' | 'timeout' | 'cancel' | 'spawn-error';

export interface HeadlessExit {
  pid: number | null;
  pgid: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  /** What ended the leg: the record, the process exiting without a record, the cap, a cancel, or a failed spawn. */
  doneBy: DoneBy;
  /** The adapter's record said done. */
  recordDone: boolean;
  timedOut: boolean;
  cancelled: boolean;
  /** The record said done but the CLI did not exit within `exitGraceMs`, so its group was killed. */
  killedAfterDone: boolean;
  /** Processes of the group outlived the leader and were killed. */
  leftoverKilled: boolean;
  /** SIGKILL was needed (SIGTERM did not end the group within the grace). */
  sigkilled: boolean;
  spawnError: string | null;
}

export interface HeadlessProcess {
  readonly pid: number | null;
  readonly startedAt: Date;
  readonly exited: Promise<HeadlessExit>;
  running(): boolean;
  recordDone(): boolean;
  /**
   * Kills the process group (SIGTERM, then SIGKILL after the grace) and resolves with the exit record. With
   * `hard`, SIGKILL goes to the group at once, with no SIGTERM and no grace.
   */
  cancel(options?: { hard?: boolean }): Promise<HeadlessExit>;
}

/** Signals every process in the group. Returns false when the group no longer exists. */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`refusing to signal process group ${pgid}`);
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM: the group exists but holds a process we may not signal. It is still alive.
    if (code === 'EPERM') return true;
    throw error;
  }
}

export function groupAlive(pgid: number): boolean {
  return signalGroup(pgid, 0);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * SIGTERM to the group, a grace period, then SIGKILL. Resolves once the group is gone (or after a last bounded
 * wait). Returns whether SIGKILL was needed.
 */
export async function terminateGroup(pgid: number, graceMs: number): Promise<boolean> {
  if (!groupAlive(pgid)) return false;
  signalGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(25);
    if (!groupAlive(pgid)) return false;
  }
  signalGroup(pgid, 'SIGKILL');
  const hard = Date.now() + 2000;
  while (Date.now() < hard && groupAlive(pgid)) await sleep(25);
  return true;
}

/** SIGKILL to the group at once, no SIGTERM. Resolves once the group is gone (bounded). Returns whether it was alive. */
export async function killGroupNow(pgid: number): Promise<boolean> {
  if (!signalGroup(pgid, 'SIGKILL')) return false;
  const hard = Date.now() + 2000;
  while (Date.now() < hard && groupAlive(pgid)) await sleep(25);
  return true;
}

/**
 * Builds a child environment from an allowlist of variable names. Values are copied, never logged; the process
 * record keeps only the names. `set` adds or overrides variables the adapter owns.
 */
export function scrubEnv(
  source: NodeJS.ProcessEnv,
  allow: readonly string[],
  set: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of allow) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return { ...env, ...set };
}

/** Starts a CLI under the supervisor. Never throws for a spawn failure: the exit record says `spawn-error`. */
export function startHeadless(spec: HeadlessSpec): HeadlessProcess {
  const killGraceMs = spec.killGraceMs ?? 5000;
  const pollMs = spec.pollMs ?? 500;
  const exitGraceMs = spec.exitGraceMs ?? 30_000;
  const startedAt = new Date();

  const fds: number[] = [];
  const open = (path: string, flags: string): number => {
    const fd = openSync(path, flags);
    fds.push(fd);
    return fd;
  };

  let child: ChildProcess | null = null;
  let spawnError: string | null = null;
  try {
    const stdin = spec.stdinFile === undefined ? 'ignore' : open(spec.stdinFile, 'r');
    const stdout = open(spec.stdoutFile, 'w');
    const stderr = open(spec.stderrFile, 'w');
    child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env: { ...spec.env },
      stdio: [stdin, stdout, stderr],
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  } finally {
    // The child holds its own copies of the descriptors.
    for (const fd of fds) closeSync(fd);
  }

  const pid = child?.pid ?? null;
  let alive = pid !== null;
  let recordDoneFlag = false;
  let timedOut = false;
  let cancelled = false;
  let killedAfterDone = false;
  let sigkilled = false;
  let killing: Promise<void> | null = null;

  const writeRecord = (exit: HeadlessExit | null): void => {
    if (spec.recordFile === undefined) return;
    const record = {
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env_names: Object.keys(spec.env).sort(),
      stdin: spec.stdinFile ?? '/dev/null',
      stdout: spec.stdoutFile,
      stderr: spec.stderrFile,
      timeout_ms: spec.timeoutMs,
      pid,
      pgid: pid,
      started_at: startedAt.toISOString(),
      exit,
    };
    writeFileSync(spec.recordFile, `${JSON.stringify(record, null, 2)}\n`);
  };
  writeRecord(null);

  const kill = (hard = false): Promise<void> => {
    if (pid === null) return Promise.resolve();
    if (hard) {
      // No SIGTERM and no grace, even over a soft kill already under way.
      const now = killGroupNow(pid).then((alive) => {
        if (alive) sigkilled = true;
      });
      killing = killing ? Promise.all([killing, now]).then(() => undefined) : now;
      return killing;
    }
    if (!killing) {
      killing = terminateGroup(pid, killGraceMs).then((hard) => {
        if (hard) sigkilled = true;
      });
    }
    return killing;
  };

  const checkDone = (): void => {
    if (recordDoneFlag || !spec.isDone) return;
    let done = false;
    try {
      done = spec.isDone();
    } catch {
      done = false;
    }
    if (!done) return;
    recordDoneFlag = true;
    const grace = setTimeout(() => {
      if (alive) {
        killedAfterDone = true;
        void kill();
      }
    }, exitGraceMs);
    grace.unref();
  };

  const exited = new Promise<HeadlessExit>((resolve) => {
    const finish = async (exitCode: number | null, signal: string | null, error: string | null): Promise<void> => {
      alive = false;
      clearInterval(poller);
      clearTimeout(cap);
      checkDone();
      let leftoverKilled = false;
      if (pid !== null) {
        if (killing) await killing;
        // Commands the CLI started may outlive it in the same group.
        if (groupAlive(pid)) {
          leftoverKilled = true;
          if (await terminateGroup(pid, killGraceMs)) sigkilled = true;
        }
      }
      const endedAt = new Date();
      const doneBy: DoneBy =
        error !== null && pid === null
          ? 'spawn-error'
          : cancelled
            ? 'cancel'
            : recordDoneFlag
              ? 'record'
              : timedOut
                ? 'timeout'
                : 'exit';
      const record: HeadlessExit = {
        pid,
        pgid: pid,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        durationMs: endedAt.getTime() - startedAt.getTime(),
        exitCode,
        signal,
        doneBy,
        recordDone: recordDoneFlag,
        timedOut,
        cancelled,
        killedAfterDone,
        leftoverKilled,
        sigkilled,
        spawnError: error,
      };
      writeRecord(record);
      resolve(record);
    };

    const poller = setInterval(checkDone, pollMs);
    poller.unref();
    const cap = setTimeout(() => {
      if (!alive) return;
      timedOut = true;
      void kill();
    }, spec.timeoutMs);
    cap.unref();

    if (child === null || pid === null) {
      const reason = spawnError ?? 'spawn failed';
      if (child) {
        // An async spawn failure (ENOENT, EACCES) arrives as an 'error' event with no pid.
        child.once('error', (error) => void finish(null, null, error.message));
      } else {
        void finish(null, null, reason);
      }
      return;
    }
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('exit', (code, signal) => void finish(code, signal, spawnError));
  });

  return {
    pid,
    startedAt,
    exited,
    running: () => alive,
    recordDone: () => recordDoneFlag,
    cancel: async (options = {}) => {
      if (alive) {
        cancelled = true;
        await kill(options.hard === true);
      }
      return exited;
    },
  };
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
  /** Set when the command could not start (for example, the binary is not on PATH). */
  error: string | null;
}

export interface CommandOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs?: number | undefined;
  /** Output beyond this many bytes per stream is dropped. Default 32 MiB. */
  maxBytes?: number | undefined;
}

/** A short command with its output captured (preflight checks). Same process-group kill as a leg. */
export type CommandRunner = (command: string, args: readonly string[], options: CommandOptions) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options) => {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
  const started = Date.now();
  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: { ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: 0,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes < maxBytes) out.push(chunk);
      outBytes += chunk.length;
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errBytes < maxBytes) err.push(chunk);
      errBytes += chunk.length;
    });
    let timedOut = false;
    let spawnError: string | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void terminateGroup(child.pid, 2000);
    }, timeoutMs);
    child.once('error', (error) => {
      spawnError = error.message;
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
        durationMs: Date.now() - started,
        error: spawnError,
      });
    });
  });
};
