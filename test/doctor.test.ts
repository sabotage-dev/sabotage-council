import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkNodeVersion, runDoctor } from '../src/cli/doctor.js';
import { buildProgram } from '../src/cli/program.js';
import { CONFIG_ENV, DB_ENV, resolveConfigPath, resolveDbPath } from '../src/paths.js';
import { packageInfo } from '../src/version.js';
import { fakeRegistry } from './fake-registry.js';

const PLAN_EXAMPLE = readFileSync(new URL('./fixtures/config/plan-example.toml', import.meta.url), 'utf8');

let dir: string;
let configPath: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-doctor-'));
  configPath = join(dir, 'config.toml');
  dbPath = join(dir, 'data', 'council.db');
  writeFileSync(configPath, PLAN_EXAMPLE);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function doctor(overrides: Partial<Parameters<typeof runDoctor>[0]> = {}): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runDoctor({ configPath, dbPath, nodeVersion: 'v22.13.0', write: (l) => lines.push(l), ...overrides });
  return { code, lines };
}

describe('doctor', () => {
  it('passes on a valid config and a fresh store, and lists the seats', async () => {
    const { code, lines } = await doctor();
    expect(code).toBe(0);
    expect(lines).toEqual([
      'ok    node v22.13.0 satisfies >=22.13',
      `ok    config ${configPath} loaded`,
      'note  model ids and model families not checked: this build has no seat adapters yet',
      `ok    store ${dbPath} at schema version 1, applied migration(s) 1`,
      'seats:',
      '  a  codex / gpt-6.1-sol / high  (fallback kiro / gpt-5.6-sol / high on usage_limit, auth)',
      '  b  claude / claude-sonnet-5-5 / high',
      '  c  grok / grok-4.7 / high',
    ]);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('finds the store already current on a second run', async () => {
    await doctor();
    const { code, lines } = await doctor();
    expect(code).toBe(0);
    expect(lines).toContain(`ok    store ${dbPath} at schema version 1`);
  });

  it('fails on config errors, prints them with key paths, and still checks the store', async () => {
    writeFileSync(configPath, PLAN_EXAMPLE.replace('[council]', '[council]\nquorum = 3'));
    const { code, lines } = await doctor();
    expect(code).toBe(1);
    expect(lines).toContain(`fail  config ${configPath} has 1 error(s)`);
    expect(lines).toContain('        council.quorum: quorum is fixed at 2 and is not configurable (D10)');
    expect(lines).toContain(`ok    store ${dbPath} at schema version 1, applied migration(s) 1`);
    expect(lines).not.toContain('seats:');
  });

  it('fails on a missing config file', async () => {
    rmSync(configPath);
    const { code, lines } = await doctor();
    expect(code).toBe(1);
    expect(lines).toContain(`        no config file at ${configPath}`);
  });

  it('fails when Node is older than engines', async () => {
    const { code, lines } = await doctor({ nodeVersion: 'v22.12.0' });
    expect(code).toBe(1);
    expect(lines[0]).toBe('fail  node v22.12.0 does not satisfy >=22.13');
  });

  it('fails when the store cannot be opened', async () => {
    writeFileSync(join(dir, 'blocker'), 'a file where a directory should be');
    const { code, lines } = await doctor({ dbPath: join(dir, 'blocker', 'council.db') });
    expect(code).toBe(1);
    expect(lines.some((l) => l.startsWith(`fail  store ${join(dir, 'blocker', 'council.db')}: `))).toBe(true);
  });

  it('checks model ids and prints family warnings when a registry is given', async () => {
    const { code, lines } = await doctor({ registry: fakeRegistry() });
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith('note'))).toBe(false);
    expect(lines.some((l) => l.startsWith('warn  seats[1].model: seat "b" shares the adjudicator\'s model family'))).toBe(true);
  });
});

describe('node version check', () => {
  it.each([
    ['v22.12.9', false],
    ['v22.13.0', true],
    ['v22.22.2', true],
    ['v23.11.0', true],
    ['v24.0.0', true],
    ['v21.99.99', false],
  ])('%s against >=22.13 -> %s', (version, ok) => {
    expect(checkNodeVersion(version, '>=22.13').ok).toBe(ok);
  });

  it('reads the floor from package.json engines', () => {
    expect(packageInfo().nodeRange).toBe('>=22.13');
  });

  it('fails closed on a range it cannot read', () => {
    expect(checkNodeVersion('v24.0.0', '^22 || ^24').ok).toBe(false);
  });
});

describe('cli', () => {
  function io(env: NodeJS.ProcessEnv = {}) {
    const lines: string[] = [];
    const codes: number[] = [];
    return { lines, codes, io: { write: (l: string) => lines.push(l), env, setExitCode: (c: number) => codes.push(c) } };
  }

  it('prints the package version for --version', async () => {
    const { io: programIo } = io();
    let out = '';
    const program = buildProgram(programIo).exitOverride().configureOutput({ writeOut: (s) => (out += s) });
    await expect(program.parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.version' });
    expect(out.trim()).toBe(packageInfo().version);
  });

  it('runs doctor with --config and --db', async () => {
    const t = io();
    await buildProgram(t.io).parseAsync(['doctor', '--config', configPath, '--db', dbPath], { from: 'user' });
    expect(t.codes).toEqual([0]);
    expect(t.lines).toContain(`ok    config ${configPath} loaded`);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('takes the paths from the environment when no flag is given', async () => {
    const t = io({ [CONFIG_ENV]: configPath, [DB_ENV]: dbPath });
    await buildProgram(t.io).parseAsync(['doctor'], { from: 'user' });
    expect(t.codes).toEqual([0]);
    expect(t.lines).toContain(`ok    config ${configPath} loaded`);
  });
});

describe('paths', () => {
  it('prefers the flag, then the environment, then the default', () => {
    expect(resolveConfigPath('/x/flag.toml', { [CONFIG_ENV]: '/x/env.toml' })).toBe('/x/flag.toml');
    expect(resolveConfigPath(undefined, { [CONFIG_ENV]: '/x/env.toml' })).toBe('/x/env.toml');
    expect(resolveConfigPath(undefined, {})).toMatch(/[/\\]\.config[/\\]sabotage-council[/\\]config\.toml$/);
    expect(resolveDbPath('/x/flag.db', { [DB_ENV]: '/x/env.db' })).toBe('/x/flag.db');
    expect(resolveDbPath(undefined, { [DB_ENV]: '/x/env.db' })).toBe('/x/env.db');
    expect(resolveDbPath(undefined, {})).toMatch(/[/\\]\.local[/\\]share[/\\]sabotage-council[/\\]council\.db$/);
  });
});
