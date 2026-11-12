import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { groupAlive, runCommand, scrubEnv, startHeadless, type HeadlessSpec } from '../src/transport/headless.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';

cleanScratchAfterAll();

const NODE = process.execPath;
const ENV = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };

function spec(dir: string, script: string, extra: Partial<HeadlessSpec> = {}): HeadlessSpec {
  return {
    command: NODE,
    args: ['-e', script],
    cwd: dir,
    env: ENV,
    stdoutFile: join(dir, 'out.txt'),
    stderrFile: join(dir, 'err.txt'),
    recordFile: join(dir, 'process.json'),
    timeoutMs: 10_000,
    killGraceMs: 300,
    pollMs: 20,
    ...extra,
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

/** A script that starts a grandchild in its own process group and writes the grandchild's pid. */
const GRANDCHILD = (pidFile: string): string =>
  `const c = require('child_process').spawn('sleep', ['60'], { stdio: 'ignore' }); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref();`;

describe('headless supervisor', () => {
  it('runs in cwd with exactly the given env, stdin from a file, output to files, and records the exit', async () => {
    const dir = scratch('sc-hl-');
    writeFileSync(join(dir, 'in.txt'), 'from stdin');
    const p = startHeadless(
      spec(
        dir,
        `const fs = require('fs'); process.stdout.write(process.cwd() + '|' + fs.readFileSync(0, 'utf8') + '|' + Object.keys(process.env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort().join(',')); process.stderr.write('err'); process.exit(3);`,
        { stdinFile: join(dir, 'in.txt'), env: { ...ENV, ONLY_THIS: 'yes' } },
      ),
    );
    const exit = await p.exited;
    expect(exit).toMatchObject({ exitCode: 3, signal: null, doneBy: 'exit', timedOut: false, recordDone: false, spawnError: null });
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe(`${dir}|from stdin|ONLY_THIS,PATH`);
    expect(readFileSync(join(dir, 'err.txt'), 'utf8')).toBe('err');
    expect(exit.pgid).toBe(exit.pid);
    const record = JSON.parse(readFileSync(join(dir, 'process.json'), 'utf8')) as Record<string, unknown>;
    expect(record['env_names']).toEqual(['ONLY_THIS', 'PATH']);
    expect(JSON.stringify(record)).not.toContain('"yes"');
    expect((record['exit'] as Record<string, unknown>)['exitCode']).toBe(3);
  });

  it('reads /dev/null when no stdin file is given', async () => {
    const dir = scratch('sc-hl-');
    const exit = await startHeadless(spec(dir, `process.stdout.write(String(require('fs').readFileSync(0).length));`)).exited;
    expect(exit.exitCode).toBe(0);
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('0');
  });

  it('kills the whole process group at the wall-clock cap, grandchildren included', async () => {
    const dir = scratch('sc-hl-');
    const pidFile = join(dir, 'gc.pid');
    const p = startHeadless(spec(dir, `${GRANDCHILD(pidFile)} setInterval(() => {}, 1000);`, { timeoutMs: 600 }));
    await until(() => existsSync(pidFile));
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(grandchild)).toBe(true);
    const exit = await p.exited;
    expect(exit).toMatchObject({ doneBy: 'timeout', timedOut: true, signal: 'SIGTERM' });
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(groupAlive(exit.pgid as number)).toBe(false);
  });

  it('sends SIGKILL when SIGTERM is ignored', async () => {
    const dir = scratch('sc-hl-');
    const p = startHeadless(spec(dir, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`, { timeoutMs: 300, killGraceMs: 200 }));
    const exit = await p.exited;
    expect(exit).toMatchObject({ doneBy: 'timeout', timedOut: true, sigkilled: true, signal: 'SIGKILL' });
  });

  it('takes the record as the done signal and kills a CLI that lingers after it', async () => {
    const dir = scratch('sc-hl-');
    const marker = join(dir, 'done.marker');
    const p = startHeadless(
      spec(dir, `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 100); setInterval(() => {}, 1000);`, {
        isDone: () => existsSync(marker),
        exitGraceMs: 200,
      }),
    );
    const exit = await p.exited;
    expect(exit).toMatchObject({ doneBy: 'record', recordDone: true, killedAfterDone: true, timedOut: false });
    expect(p.recordDone()).toBe(true);
  });

  it('records a clean exit after the record as done by the record', async () => {
    const dir = scratch('sc-hl-');
    const marker = join(dir, 'done.marker');
    const exit = await startHeadless(
      spec(dir, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`, { isDone: () => existsSync(marker), exitGraceMs: 5000 }),
    ).exited;
    expect(exit).toMatchObject({ doneBy: 'record', recordDone: true, killedAfterDone: false, exitCode: 0 });
  });

  it('kills processes that outlive the leader in its group', async () => {
    const dir = scratch('sc-hl-');
    const pidFile = join(dir, 'gc.pid');
    const exit = await startHeadless(spec(dir, GRANDCHILD(pidFile))).exited;
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    expect(exit).toMatchObject({ doneBy: 'exit', exitCode: 0, leftoverKilled: true });
    expect(await until(() => !alive(grandchild))).toBe(true);
  });

  it('cancels a running leg', async () => {
    const dir = scratch('sc-hl-');
    const p = startHeadless(spec(dir, `setInterval(() => {}, 1000);`));
    await until(() => p.running());
    const exit = await p.cancel();
    expect(exit).toMatchObject({ doneBy: 'cancel', cancelled: true });
    expect(p.running()).toBe(false);
  });

  it('cancels with SIGKILL at once, no SIGTERM and no grace, when asked to (round 1)', async () => {
    const dir = scratch('sc-hl-');
    const marker = join(dir, 'got-sigterm');
    const trap = `process.on('SIGTERM', () => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')); setInterval(() => {}, 1000);`;
    const soft = startHeadless(spec(dir, trap, { killGraceMs: 2000 }));
    await until(() => soft.running());
    await new Promise((r) => setTimeout(r, 200)); // the trap is installed
    const softExit = await soft.cancel();
    expect(existsSync(marker)).toBe(true);
    expect(softExit.durationMs).toBeGreaterThanOrEqual(2000);

    const dir2 = scratch('sc-hl-');
    const marker2 = join(dir2, 'got-sigterm');
    const hard = startHeadless(spec(dir2, trap.replace(JSON.stringify(marker), JSON.stringify(marker2)), { killGraceMs: 2000 }));
    await until(() => hard.running());
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    const exit = await hard.cancel({ hard: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(exit).toMatchObject({ doneBy: 'cancel', cancelled: true, sigkilled: true, signal: 'SIGKILL' });
    expect(existsSync(marker2)).toBe(false);
  });

  it('reports a binary that cannot start as a spawn error, without throwing', async () => {
    const dir = scratch('sc-hl-');
    const exit = await startHeadless({ ...spec(dir, ''), command: join(dir, 'no-such-binary') }).exited;
    expect(exit.doneBy).toBe('spawn-error');
    expect(exit.spawnError).toMatch(/ENOENT/);
    expect(exit.pid).toBeNull();
  });
});

describe('scrubEnv', () => {
  it('copies only allowlisted names and adds the adapter set', () => {
    expect(scrubEnv({ PATH: '/bin', HOME: '/h', SECRET: 's', EMPTY: '' }, ['PATH', 'EMPTY', 'MISSING'], { NO_COLOR: '1' })).toEqual({
      PATH: '/bin',
      EMPTY: '',
      NO_COLOR: '1',
    });
  });
});

describe('runCommand', () => {
  it('captures output and the exit code', async () => {
    const dir = scratch('sc-run-');
    const r = await runCommand(NODE, ['-e', `process.stdout.write('o'); process.stderr.write('e'); process.exit(2)`], { cwd: dir, env: ENV });
    expect(r).toMatchObject({ exitCode: 2, stdout: 'o', stderr: 'e', timedOut: false, error: null });
  });

  it('kills a command at its cap', async () => {
    const dir = scratch('sc-run-');
    const r = await runCommand(NODE, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, env: ENV, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  it('reports a missing binary', async () => {
    const dir = scratch('sc-run-');
    const r = await runCommand(join(dir, 'missing'), [], { cwd: dir, env: ENV });
    expect(r.error).toMatch(/ENOENT/);
  });
});
