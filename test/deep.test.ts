import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGrokAdapter } from '../src/adapters/grok/index.js';
import { createOpencodeAdapter, opencodeConfig } from '../src/adapters/opencode/index.js';
import type { SeatAdapters } from '../src/adapters/index.js';
import type { Occupant, Preflight, RoundCtx, SeatAdapter } from '../src/adapters/types.js';
import { judgeDeep, plantCanaryRoot } from '../src/cli/deep.js';
import { runDoctor } from '../src/cli/doctor.js';
import type { CommandResult, CommandRunner } from '../src/transport/headless.js';

let dir: string;
let configPath: string;
let dbPath: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'sc-deep-')));
  configPath = join(dir, 'config.toml');
  dbPath = join(dir, 'council.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(seats: Array<[string, string, string, string?]>, extra = ''): void {
  writeFileSync(configPath, `${seats.map(([id, backend, model, effort]) => `[[seats]]\nid = "${id}"\nbackend = "${backend}"\nmodel = "${model}"\n${effort !== undefined ? `effort = "${effort}"\n` : ''}`).join('\n')}${extra}`);
}

async function doctor(adapters: SeatAdapters, deep = true): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runDoctor({ configPath, dbPath, nodeVersion: 'v22.13.0', adapters, deep, env: { PATH: process.env['PATH'] ?? '', HOME: dir }, write: (l) => lines.push(l) });
  return { code, lines };
}

const okPre = (backend: Occupant['backend'], over: Partial<Preflight> = {}): Preflight => ({
  ok: true,
  backend,
  cliVersion: '1.0.0',
  enforcement: 'pending',
  checks: [],
  userOwned: [],
  failureClass: null,
  reason: null,
  data: {},
  ...over,
});

/** A stub adapter whose preflight does what `act` says with the root it is given. */
function stub(backend: Occupant['backend'], act: (ctx: RoundCtx) => Preflight): SeatAdapter {
  return {
    id: backend,
    transport: 'headless',
    testedVersions: { floor: '1.0.0', tested: ['1.0.0'] },
    enforcement: () => 'pending',
    listModels: async () => [],
    preflight: async (_o, ctx) => act(ctx),
    launch: async () => {
      throw new Error('no launch in doctor');
    },
    poll: async () => ({ status: 'running' }),
    collect: async () => ({ text: null, fromNonce: false, source: 'none' }),
    ratify: async () => {
      throw new Error('no ratify in doctor');
    },
    classify: () => null,
    cancel: async () => undefined,
  };
}

/** Runs the root's planted Claude Code SessionStart hook, as a CLI that loads project hooks would. */
function runsPlantedHook(ctx: RoundCtx): Preflight {
  const settingsPath = join(ctx.root, '.claude', 'settings.json');
  if (existsSync(settingsPath)) {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
    const command = settings.hooks.SessionStart[0]?.hooks[0]?.command ?? 'true';
    execFileSync('/bin/sh', ['-c', command]);
  }
  return okPre('claude');
}

describe('the canary root', () => {
  it('plants hook, rules and MCP files for every backend, at the top level and nested', () => {
    const root = join(dir, 'root');
    const markers = join(dir, 'markers');
    const planted = plantCanaryRoot(root, markers);
    for (const rel of [
      '.claude/settings.json',
      'AGENTS.md',
      'CLAUDE.md',
      'GEMINI.md',
      '.mcp.json',
      '.codex/config.toml',
      '.grok/config.toml',
      '.gemini/settings.json',
      '.agents/hooks.json',
      '.kiro/steering/planted.md',
      '.kiro/hooks/planted.kiro.hook',
      '.kiro/settings/mcp.json',
      'opencode.json',
      '.opencode/plugins/planted.js',
      '.cursor/hooks.json',
      '.cursor/rules/planted.mdc',
      '.cursor/mcp.json',
      '.cursor/cli.json',
      '.muse/hooks.json',
      '.agents/memory/MEMORY.md',
    ]) {
      expect(planted, rel).toContain(rel);
      expect(planted, `sub/${rel}`).toContain(`sub/${rel}`);
    }
    // Every planted hook writes its own marker outside the root when something runs it.
    const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')) as { hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> } };
    execFileSync('/bin/sh', ['-c', settings.hooks.SessionStart[0]?.hooks[0]?.command ?? '']);
    expect(readdirSync(markers)).toEqual(['claude-hook-top']);
  });

  it.each([
    ['a marker that appeared', okPre('claude'), ['claude-hook-top'], 'loads'],
    ['a planted file in its own dump', okPre('grok', { ok: false, failureClass: 'setup', reason: 'grok would load x', data: { loaded: ['MCP server planted'] } }), [], 'loads'],
    ['a refusal of the unsanitized root', okPre('kiro', { ok: false, failureClass: 'setup', reason: 'root not sanitized' }), [], 'refused'],
    ['a pass with no dump', okPre('claude'), [], 'unproven'],
    ['a sign-in failure', okPre('kiro', { ok: false, failureClass: 'auth', reason: 'kiro is not signed in' }), [], 'unchecked'],
  ])('judges %s', (_what, pre, markers, verdict) => {
    expect(judgeDeep(pre, markers, null).verdict).toBe(verdict);
  });

  it('does not count a refusal as a refusal of the planted root when the clean root fails too', () => {
    const userPlugins = okPre('claude', { ok: false, failureClass: 'setup', reason: 'installed plugins can add tools' });
    expect(judgeDeep(userPlugins, [], null, false).verdict).toBe('unchecked');
    expect(judgeDeep(userPlugins, [], null, true).verdict).toBe('refused');
    expect(judgeDeep(okPre('grok', { ok: false, failureClass: 'setup', data: { loaded: ['x'] } }), [], null, false).verdict).toBe('loads');
  });
});

describe('doctor --deep: fails any backend that loads a planted hook', () => {
  it('fails a backend whose preflight runs a planted hook, and one whose dump lists a planted file; a refusal passes', async () => {
    config([
      ['a', 'claude', 'claude-sonnet-5-5'],
      ['b', 'codex', 'gpt-6.1-sol'],
      ['c', 'kiro', 'claude-sonnet-4.5'],
    ]);
    const adapters: SeatAdapters = (backend) =>
      backend === 'claude'
        ? stub('claude', runsPlantedHook)
        : backend === 'codex'
          ? stub('codex', () => okPre('codex', { ok: false, failureClass: 'setup', reason: 'does not isolate', data: { loaded: ['repository AGENTS.md instructions'] } }))
          : stub('kiro', (ctx) => (existsSync(join(ctx.root, 'AGENTS.md')) ? okPre('kiro', { ok: false, failureClass: 'setup', reason: 'root not sanitized' }) : okPre('kiro')));
    const { code, lines } = await doctor(adapters);
    expect(code).toBe(1);
    const deep = lines.slice(lines.findIndex((l) => l.startsWith('deep (')));
    expect(deep.find((l) => l.includes('a  claude'))).toMatch(/^fail .*loads: executed planted code during preflight: claude-hook-top/);
    expect(deep.find((l) => l.includes('b  codex'))).toMatch(/^fail .*loads: its own isolation dump lists planted files: repository AGENTS.md instructions/);
    expect(deep.find((l) => l.includes('c  kiro'))).toMatch(/^ok .*refused: refused the planted root at preflight: root not sanitized/);
  });

  it('passes when every backend refuses or isolates, warning on the unproven ones', async () => {
    config([
      ['a', 'claude', 'claude-sonnet-5-5'],
      ['b', 'kiro', 'claude-sonnet-4.5'],
      ['c', 'muse', 'muse-spark-1.3'],
    ]);
    const adapters: SeatAdapters = (backend) => (backend === 'kiro' ? stub('kiro', () => okPre('kiro', { ok: false, failureClass: 'setup', reason: 'root not sanitized' })) : stub(backend, () => okPre(backend)));
    const plain = await doctor(adapters, false);
    expect(plain.lines.some((l) => l.startsWith('deep ('))).toBe(false);
    const { code, lines } = await doctor(adapters);
    expect(code).toBe(0);
    expect(lines.filter((l) => / (?:loads):/.test(l))).toEqual([]);
    expect(lines.find((l) => l.includes('a  claude: unproven'))).toMatch(/^warn /);
  });

  it('runs the real grok preflight on the canary root: grok inspect lists the planted MCP config, so grok fails', async () => {
    config([
      ['a', 'grok', 'grok-4.7', 'low'],
      ['b', 'claude', 'claude-sonnet-5-5'],
      ['c', 'kiro', 'claude-sonnet-4.5'],
    ]);
    const out = (stdout: string): CommandResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false, durationMs: 1, error: null });
    // A grok that discovers what its cwd holds, as `grok inspect` does (recorded shape, 1.0.70).
    const runner: CommandRunner = async (_b, args, o) => {
      if (args[0] === '--version') return out('grok 1.0.70 (f50904eaee6c) [stable]\n');
      if (args[0] === 'models') return out('You are logged in with grok.com.\n  * grok-4.7 (default)\n');
      const mcp = existsSync(join(o.cwd, '.mcp.json')) ? [{ name: 'planted', transport: 'stdio', source: { type: 'mcpJson', path: join(o.cwd, '.mcp.json') } }] : [];
      const layers = existsSync(join(o.cwd, '.grok', 'config.toml')) ? [{ role: 'project', path: join(o.cwd, '.grok', 'config.toml') }] : [];
      return out(JSON.stringify({ projectInstructions: [], hooks: [], plugins: [], permissions: { sources: [], loaded: 0 }, mcpServers: mcp, configSources: { layers } }));
    };
    const grok = createGrokAdapter({ runner, dockerSocket: join(dir, 'no-socket') });
    const adapters: SeatAdapters = (backend) => (backend === 'grok' ? grok : stub(backend, () => okPre(backend)));
    const { lines } = await doctor(adapters);
    const line = lines.find((l) => l.includes('a  grok: loads'));
    expect(line).toBeDefined();
    expect(line).toContain('MCP server planted');
    expect(line).toContain('project config');
  });

  it('runs the real opencode preflight on the canary root: it refuses the unsanitized root before starting a server', async () => {
    config([
      ['a', 'opencode', 'opencode/big-pickle'],
      ['b', 'claude', 'claude-sonnet-5-5'],
      ['c', 'kiro', 'claude-sonnet-4.5'],
    ]);
    const calls: Array<{ cwd: string; args: string[] }> = [];
    const council = (opencodeConfig()['agents'] as Record<string, { permissions: unknown[] }>)['council']?.permissions ?? [];
    const outputs: Record<string, (env: Readonly<Record<string, string>>) => string> = {
      '--version': () => 'opencode v2.2.7\n',
      'debug config --standalone': (env) => JSON.stringify([{ type: 'directory', path: `${env['XDG_CONFIG_HOME'] ?? ''}/opencode` }, { type: 'document', info: opencodeConfig() }]),
      'debug agents --standalone': () => JSON.stringify([{ id: 'council', permissions: [{ action: '*', resource: '*', effect: 'allow' }, ...council] }]),
      'mcp list --standalone': () => 'No MCP servers configured\n',
      'plugin list --standalone': () => 'No plugins found\n',
      'models --standalone': () => 'opencode/big-pickle\n',
      'auth list --format json': () => '[]',
    };
    const runner: CommandRunner = async (_b, args, o) => {
      calls.push({ cwd: o.cwd, args: [...args] });
      return { exitCode: 0, signal: null, stdout: outputs[args.join(' ')]?.(o.env) ?? '', stderr: '', timedOut: false, durationMs: 1, error: null };
    };
    const adapters: SeatAdapters = (backend) => (backend === 'opencode' ? createOpencodeAdapter({ runner, bin: 'opencode' }) : stub(backend, () => okPre(backend)));
    const { lines } = await doctor(adapters);
    expect(lines.find((l) => l.includes('a  opencode: refused'))).toMatch(/^ok .*root not sanitized/);
    // On the canary root only --version ran: no opencode server ever saw the planted plugin or config.
    expect(calls.filter((c) => c.cwd.endsWith('canary-root')).map((c) => c.args.join(' '))).toEqual(['--version']);
    expect(calls.some((c) => c.args.includes('--standalone'))).toBe(true);
  });
});

describe('doctor refuses Cursor seats for auto (D14)', () => {
  it('fails a cursor seat or fallback when the config has an auto section', async () => {
    config(
      [
        ['a', 'cursor', 'gpt-5.5-high'],
        ['b', 'claude', 'claude-sonnet-5-5'],
        ['c', 'kiro', 'claude-sonnet-4.5'],
      ],
      '\n[auto]\nrepos_allow = ["org/*"]\n',
    );
    const { code, lines } = await doctor(() => undefined, false);
    expect(code).toBe(1);
    expect(lines).toContain('fail  a: cursor seats are refused for auto until a Cursor promotion canary passes (none runs in v1, D14)');
    config([
      ['a', 'cursor', 'gpt-5.5-high'],
      ['b', 'claude', 'claude-sonnet-5-5'],
      ['c', 'kiro', 'claude-sonnet-4.5'],
    ]);
    expect((await doctor(() => undefined, false)).lines.some((l) => l.includes('refused for auto'))).toBe(false);
  });
});
