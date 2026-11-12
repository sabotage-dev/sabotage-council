import { existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_KEY_ROUTE,
  claudeArgs,
  claudeDecl,
  claudePreflight,
  CLAUDE_DECLARED,
  classifyClaudeText,
  createClaudeAdapter,
  modelMatches,
  parseAuthStatus,
  ratifyClaudeLeg,
  toolPaths,
  type ClaudeRatifyInput,
} from '../src/adapters/claude/index.js';
import { initGateProblem } from '../src/adapters/claude/index.js';
import { CLAUDE_ENV_ALLOW } from '../src/adapters/claude/launch.js';
import type { Occupant, RoundCtx } from '../src/adapters/types.js';
import { runCommand } from '../src/transport/headless.js';
import { cleanScratchAfterAll, fixtureDir, materialize, readJsonl, scratch, writeJsonl } from './helpers/fixtures.js';

cleanScratchAfterAll();

interface CaseFile {
  nonce: string;
  model: string;
  effort: string;
  sessionId: string;
  rootMutated: boolean;
  expect: { status: string; failureClass: string | null; failed: string[] };
}

const CASES = readdirSync(fixtureDir('claude', '')).filter((n) => existsSync(join(fixtureDir('claude', n), 'case.json')));
const caseOf = (name: string): CaseFile => JSON.parse(readFileSync(join(fixtureDir('claude', name), 'case.json'), 'utf8')) as CaseFile;

function inputFor(name: string, edit?: (dir: string) => void): { input: ClaudeRatifyInput; dir: string } {
  const c = caseOf(name);
  const { dir, root } = materialize('claude', name);
  edit?.(dir);
  return {
    dir,
    input: {
      root,
      nonce: c.nonce,
      model: c.model,
      effort: c.effort,
      sessionId: c.sessionId,
      streamFile: join(dir, 'stream.jsonl'),
      stderrFile: join(dir, 'stderr.log'),
      projectsDir: join(dir, 'projects'),
      timedOut: false,
      rootUnchanged: () => ({ unchanged: !c.rootMutated, changes: c.rootMutated ? ['modified planted/calc/rangesum.py'] : [] }),
    },
  };
}

const transcriptOf = (dir: string): string => join(dir, 'projects', '-sc-root', '00000000-0000-4000-8000-0000000000c1.jsonl');
const failedNames = (r: ReturnType<typeof ratifyClaudeLeg>): string[] => r.checks.filter((c) => !c.ok).map((c) => c.name).sort();

describe('claude replay: every recorded and synthetic case', () => {
  it('has the cases the brief names', () => {
    expect(CASES.sort()).toEqual(
      ['auth', 'canary-outside-reads', 'contaminated-offered', 'contaminated-used', 'empty', 'max-turns', 'model-not-found', 'overloaded', 'root-mutated', 'success', 'usage-limit', 'wrong-model'].sort(),
    );
  });

  it.each(CASES)('%s', (name) => {
    const c = caseOf(name);
    const r = ratifyClaudeLeg(inputFor(name).input);
    expect({ status: r.status, failureClass: r.failureClass, failed: failedNames(r) }).toEqual({
      status: c.expect.status,
      failureClass: c.expect.failureClass,
      failed: [...c.expect.failed].sort(),
    });
  });
});

describe('claude ratification details', () => {
  it('records the fields 4.5 lists from the recorded smoke leg', () => {
    const r = ratifyClaudeLeg(inputFor('success').input);
    expect(r).toMatchObject({
      status: 'PASS',
      sessionId: '00000000-0000-4000-8000-0000000000c1',
      cliVersion: '2.1.322',
      modelObserved: 'claude-haiku-5-5',
      effortObserved: 'low',
      cwdOk: true,
      nonceSeen: true,
      toolsOffered: ['Glob', 'Grep', 'Read'],
      rootMutated: false,
    });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.toolsUsed.every((t) => ['Read', 'Glob', 'Grep'].includes(t))).toBe(true);
    expect(r.detail['instructionFiles']).toEqual([]);
  });

  it('records the canary denials as evidence, and judges the planted symlink by its target', () => {
    // The canary root held link-out.txt -> <outside>/secret.txt; the replay plants the same (dangling) link.
    const r = ratifyClaudeLeg(inputFor('canary-outside-reads', (dir) => {
      const root = join(dir, '..', 'root');
      symlinkSync('/sc-outside/secret.txt', join(root, 'link-out.txt'));
    }).input);
    const denials = r.detail['permissionDenials'] as Array<{ tool_name: string }>;
    expect(denials.map((d) => d.tool_name).sort()).toEqual(['Glob', 'Grep', 'Read', 'Read']);
    expect(r.checks.find((c) => c.name === 'tool-paths')?.detail).toContain('its realpath leaves the root');
  });

  it('fails a read through a symlink that leaves the root (realpath)', () => {
    const { input } = inputFor('success');
    const outside = scratch('sc-outside-');
    writeFileSync(join(outside, 'x.txt'), 'x');
    symlinkSync(join(outside, 'x.txt'), join(input.root, 'link.txt'));
    const r = ratifyClaudeLeg({
      ...input,
      streamFile: (() => {
        const rows = readJsonl(input.streamFile);
        rows.splice(2, 0, { type: 'assistant', message: { model: 'claude-haiku-5-5', role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(input.root, 'link.txt') } }] } });
        writeJsonl(input.streamFile, rows);
        return input.streamFile;
      })(),
    });
    expect(failedNames(r)).toEqual(['tool-paths']);
  });

  it.each([
    ['an api-request at another effort', (dir: string) => edit(transcriptOf(dir), (row) => row['type'] === 'api-request', (row) => ((row['params'] as Record<string, Record<string, unknown>>)['output_config'] = { effort: 'high' })), 'effort'],
    ['a transcript cwd outside the root', (dir: string) => edit(transcriptOf(dir), (row) => row['type'] === 'user', (row) => (row['cwd'] = '/elsewhere')), 'cwd'],
    ['a subagent sidechain', (dir: string) => edit(transcriptOf(dir), (row) => row['type'] === 'user', (row) => (row['isSidechain'] = true)), 'sidechains'],
    ['permissionMode auto', (dir: string) => edit(join(dir, 'stream.jsonl'), (row) => row['subtype'] === 'init', (row) => (row['permissionMode'] = 'auto')), 'permission-mode'],
    ['another session id', (dir: string) => edit(join(dir, 'stream.jsonl'), (row) => row['subtype'] === 'init', (row) => (row['session_id'] = '11111111-1111-4111-8111-111111111111')), 'session'],
    ['a missing transcript', (dir: string) => writeFileSync(transcriptOf(dir), ''), 'effort'],
    ['a transcript entry from another session', (dir: string) => edit(transcriptOf(dir), (row) => row['type'] === 'user', (row) => (row['sessionId'] = '11111111-1111-4111-8111-111111111111')), 'transcript'],
    ['a malformed stream line', (dir: string) => writeFileSync(join(dir, 'stream.jsonl'), readFileSync(join(dir, 'stream.jsonl'), 'utf8').replace('\n', '\n{not json\n')), 'stream'],
    ['a second init in the stream', (dir: string) => writeFileSync(join(dir, 'stream.jsonl'), readFileSync(join(dir, 'stream.jsonl'), 'utf8').split('\n')[0] + '\n' + readFileSync(join(dir, 'stream.jsonl'), 'utf8')), 'stream'],
    ['a Glob pattern outside the root', (dir: string) => edit(join(dir, 'stream.jsonl'), (row) => row['type'] === 'assistant', (row) => ((row['message'] as { content: unknown[] }).content.push({ type: 'tool_use', name: 'Glob', input: { pattern: '../**' } }))), 'tool-paths'],
  ])('fails on %s', (_what, change, check) => {
    const r = ratifyClaudeLeg(inputFor('success', change).input);
    expect(failedNames(r)).toContain(check);
  });

  // Round 1 (2/3): torn or partial records used to pass.
  it.each([
    ['a torn last stream line', (dir: string) => writeFileSync(join(dir, 'stream.jsonl'), `${readFileSync(join(dir, 'stream.jsonl'), 'utf8')}{"type":"assist`), 'stream'],
    ['a torn last transcript line', (dir: string) => writeFileSync(transcriptOf(dir), `${readFileSync(transcriptOf(dir), 'utf8')}{"type":"assist`), 'transcript'],
  ])('fails on %s (round 1)', (_what, change, check) => {
    const r = ratifyClaudeLeg(inputFor('success', change).input);
    expect(failedNames(r)).toEqual([check]);
    expect(r.checks.find((c) => c.name === check)?.detail).toContain('torn');
  });

  it('fails a transcript cut after its first request, which still holds the model and effort evidence (round 1)', () => {
    const r = ratifyClaudeLeg(
      inputFor('success', (dir) => {
        const rows = readJsonl(transcriptOf(dir));
        const second = rows.findIndex((row, i) => row['type'] === 'api-request' && rows.slice(0, i).some((x) => x['type'] === 'api-request'));
        writeJsonl(transcriptOf(dir), rows.slice(0, second));
      }).input,
    );
    expect(failedNames(r)).toEqual(['transcript']);
    expect(r.checks.find((c) => c.name === 'transcript')?.detail).toContain('ends before the final answer');
  });

  it('accepts a transcript that reaches the final request even when its text block was not written', () => {
    const r = ratifyClaudeLeg(
      inputFor('success', (dir) => {
        const rows = readJsonl(transcriptOf(dir));
        const lastText = rows.map((row) => JSON.stringify(row)).findLastIndex((t) => t.includes('"type":"text"'));
        writeJsonl(transcriptOf(dir), rows.filter((_row, i) => i !== lastText));
      }).input,
    );
    expect(r.status).toBe('PASS');
  });

  // Round 1 (2/3), plan 4.5 item 8: only a verbatim first NONCE line counts.
  it.each([
    ['the nonce mid-sentence', 'My review for 3617dff745c0 follows.\n\nVERDICT: SHIP'],
    ['the nonce on line 2', 'Review below.\nNONCE: 3617dff745c0\n\nVERDICT: SHIP'],
    ['the nonce quoted from the brief', 'The brief said:\n> NONCE: 3617dff745c0\n\nVERDICT: SHIP'],
  ])('fails an answer with %s (round 1)', (_what, text) => {
    const r = ratifyClaudeLeg(
      inputFor('success', (dir) => {
        edit(join(dir, 'stream.jsonl'), (row) => row['type'] === 'result', (row) => (row['result'] = text));
        // Keep the transcript covering the final request (its id), so only the nonce differs.
      }).input,
    );
    expect(failedNames(r)).toEqual(['nonce']);
    expect(r.nonceSeen).toBe(false);
  });

  it.each([
    ['no tools list', (row: Record<string, unknown>) => delete row['tools']],
    ['tools: [1]', (row: Record<string, unknown>) => (row['tools'] = [1])],
  ])('fails the offer check on an init with %s (round 1)', (_what, change) => {
    const r = ratifyClaudeLeg(inputFor('success', (dir) => edit(join(dir, 'stream.jsonl'), (row) => row['subtype'] === 'init', change)).input);
    expect(failedNames(r)).toEqual(['offered']);
  });

  it('fails the init gate check when the gate stopped the leg', () => {
    const { input } = inputFor('success');
    const r = ratifyClaudeLeg({ ...input, initGate: 'system/init offered Bash' });
    expect(failedNames(r)).toEqual(['init-gate']);
    expect(r.failureClass).toBe('setup');
  });

  it('fails closed with no residue sweep', () => {
    const { input } = inputFor('success');
    expect(failedNames(ratifyClaudeLeg({ ...input, rootUnchanged: undefined }))).toEqual(['root-unchanged']);
  });
});

function edit(path: string, match: (row: Record<string, unknown>) => boolean, change: (row: Record<string, unknown>) => void): void {
  writeJsonl(
    path,
    readJsonl(path).map((row) => {
      if (match(row)) change(row);
      return row;
    }),
  );
}

describe('claude helpers', () => {
  it.each([
    ['claude-haiku-5-5', 'claude-haiku-5-5', true],
    ['claude-haiku-5-5-20261001', 'claude-haiku-5-5', true],
    ['claude-sonnet-5-5[1m]', 'claude-sonnet-5-5', true],
    ['claude-haiku-5-5-x', 'claude-haiku-5-5', false],
    ['claude-sonnet-5-5', 'claude-haiku-5-5', false],
  ])('modelMatches(%s, %s) = %s', (observed, pin, ok) => {
    expect(modelMatches(observed, pin)).toBe(ok);
  });

  it('names the paths of each read tool', () => {
    expect(toolPaths({ name: 'Read', input: { file_path: '/r/a' }, source: 'stream' })).toEqual(['/r/a']);
    expect(toolPaths({ name: 'Glob', input: { pattern: '**/*.ts', path: 'src' }, source: 'stream' })).toEqual(['src', '**/*.ts']);
    expect(toolPaths({ name: 'Grep', input: { pattern: 'x', path: '/etc', glob: '*.conf' }, source: 'stream' })).toEqual(['/etc', '*.conf']);
  });

  it('reads only login-state fields from auth status', () => {
    const s = parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'x', orgName: 'y', projectsDirectory: '/p' }));
    expect(s).toEqual({ loggedIn: true, authMethod: 'claude.ai', apiProvider: null, loginExpiresAt: null, projectsDirectory: '/p' });
  });

  it('stops a leg at init when anything but Read, Glob and Grep is offered, naming the API-key route for plugin tools', () => {
    expect(initGateProblem({ tools: ['Glob', 'Grep', 'Read'], permissionMode: 'dontAsk' })).toBeNull();
    expect(initGateProblem({ tools: ['Read', 'Bash'], permissionMode: 'dontAsk' })).toBe('system/init offered Bash');
    expect(initGateProblem({ tools: ['Read', 'mcp__plugin__x'], permissionMode: 'dontAsk' })).toContain(API_KEY_ROUTE);
    expect(initGateProblem({ tools: ['Read'], permissionMode: 'auto' })).toContain('not dontAsk');
  });

  it.each([
    ['a missing tools list', { permissionMode: 'dontAsk' }, 'has no tools list'],
    ['a tools value that is not a list', { tools: 'Read', permissionMode: 'dontAsk' }, 'tools is not a list'],
    ['a non-string entry', { tools: [1], permissionMode: 'dontAsk' }, 'non-string entry'],
    ['a non-string entry beside the reads', { tools: ['Read', { name: 'Bash' }], permissionMode: 'dontAsk' }, 'non-string entry'],
  ])('stops a leg at init on %s, never reading it as an empty offer (round 1)', (_what, init, problem) => {
    expect(initGateProblem(init)).toContain(problem);
  });
});

describe('claude failure classifier (4.4)', () => {
  it.each([
    ['status 401', 'auth'],
    ['status 403', 'auth'],
    ['Invalid API key · Please run /login', 'auth'],
    ["You've hit your usage limit. Your limit resets at 3pm.", 'usage_limit'],
    ['error_max_budget_usd', 'usage_limit'],
    ['status 429', 'capacity'],
    ['API Error: 529 overloaded_error', 'capacity'],
    ["There's an issue with the selected model (x). It may not exist", 'model'],
    ['[claude-code:unrecognized_model] {"model":"x"}', 'model'],
    ['error_max_turns', 'timeout'],
    ['Error: Input must be provided either through stdin or as a prompt argument when using --print', 'setup'],
  ])('%s -> %s', (text, cls) => {
    expect(classifyClaudeText([text])).toBe(cls);
  });
});

describe('claude launch', () => {
  const decl = claudeDecl('2.1.322')!;

  it('builds the command line: read tools only, restricted, dontAsk, the measured setting sources, prompt on stdin', () => {
    const args = claudeArgs({ model: 'claude-haiku-5-5', effort: 'low', sessionId: 's', settingsFile: '/l/settings.json', decl, bare: false });
    expect(args.slice(0, 22)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-haiku-5-5', '--effort', 'low', '--restricted',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Glob,Grep', '--strict-mcp-config',
      '--setting-sources', '', '--settings', '/l/settings.json', '--session-id', 's',
    ]);
    expect(args).not.toContain('--bare');
    const allowed = args.indexOf('--allowedTools');
    const disallowed = args.indexOf('--disallowedTools');
    expect(args.slice(allowed + 1, disallowed)).toEqual(['Read', 'Glob', 'Grep']);
    // The variadic deny list is last: nothing positional follows it.
    expect(args.slice(disallowed + 1)).toEqual([...decl.nonReadBuiltins]);
    for (const t of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'CronCreate', 'SendMessage', 'Workflow', 'PushNotification', 'RemoteTrigger']) {
      expect(decl.nonReadBuiltins).toContain(t);
    }
  });

  it('adds --bare on the API-key route', () => {
    expect(claudeArgs({ model: 'm', effort: 'low', sessionId: 's', settingsFile: 'f', decl, bare: true })).toContain('--bare');
  });

  it('declares 2.1.322 as measured: empty setting sources drop plugin tools, and the canary promoted it to strong', () => {
    expect(CLAUDE_DECLARED['2.1.322']).toMatchObject({ settingSources: '', dropsPluginTools: true, enforcement: 'strong' });
    expect(createClaudeAdapter().enforcement('2.1.322')).toBe('strong');
    expect(createClaudeAdapter().enforcement('2.2.0')).toBe('pending');
  });
});

const FAKE_CLAUDE = new URL('./fixtures/bin/fake-claude.mjs', import.meta.url).pathname;
const OCC: Occupant = { backend: 'claude', model: 'claude-haiku-5-5', effort: 'low' };

function fakeHome(config: Record<string, unknown>, extraEnv: Record<string, string> = {}): { home: string; env: NodeJS.ProcessEnv } {
  const home = scratch('sc-fake-claude-');
  writeFileSync(join(home, 'fake-claude.json'), JSON.stringify({ fixture: fixtureDir('claude', 'success'), ...config }));
  return { home, env: { PATH: process.env['PATH'], HOME: home, SECRET_TOKEN: 'never-forwarded', ...extraEnv } };
}

describe('claude preflight (4.3), through a fake CLI', () => {
  const pre = (config: Record<string, unknown>, extraEnv: Record<string, string> = {}, o: Occupant = OCC) => {
    const { env } = fakeHome(config, extraEnv);
    return claudePreflight(o, { bin: FAKE_CLAUDE, runner: runCommand, env, root: scratch('sc-pre-root-') });
  };

  it('passes on the tested version with the measured isolation, and labels it strong', async () => {
    const p = await pre({});
    expect(p.ok).toBe(true);
    expect(p.enforcement).toBe('strong');
    expect(p.checks.map((c) => `${c.status} ${c.name}`)).toEqual(['ok version', 'ok auth', 'ok model', 'ok isolation', 'note user-owned']);
    expect(p.data['bare']).toBe(false);
  });

  it('takes the --bare route when ANTHROPIC_API_KEY is set', async () => {
    const p = await pre({ loggedIn: false }, { ANTHROPIC_API_KEY: 'present' });
    expect(p.ok).toBe(true);
    expect(p.data['bare']).toBe(true);
  });

  it('refuses a subscription user with plugins on an untested version, naming the API-key route', async () => {
    const p = await pre({ version: '2.2.0', plugins: [{ id: 'some-plugin@market', enabled: true }] });
    expect(p).toMatchObject({ ok: false, failureClass: 'setup', enforcement: 'pending' });
    expect(p.reason).toContain(API_KEY_ROUTE);
  });

  it('lets an untested version with no enabled plugin through, as pending', async () => {
    const p = await pre({ version: '2.2.0', plugins: [{ id: 'off@market', enabled: false }] });
    expect(p).toMatchObject({ ok: true, enforcement: 'pending' });
    expect(p.checks.find((c) => c.name === 'version')?.status).toBe('warn');
  });

  it.each([
    [{ version: '2.0.1' }, {}, OCC, 'setup', 'version'],
    [{ loggedIn: false }, {}, OCC, 'auth', 'auth'],
    [{}, {}, { backend: 'claude', model: 'claude-unknown-9', effort: 'low' } as Occupant, 'model', 'model'],
    [{}, {}, { backend: 'claude', model: 'claude-haiku-5-5' } as Occupant, 'setup', 'occupant'],
  ])('refuses %j', async (config, extraEnv, o, cls, check) => {
    const p = await pre(config, extraEnv, o);
    expect(p.ok).toBe(false);
    expect(p.failureClass).toBe(cls);
    expect(p.checks.find((c) => c.status === 'fail')?.name).toBe(check);
  });
});

async function runToDone(adapter: ReturnType<typeof createClaudeAdapter>, ctx: RoundCtx) {
  const handle = await adapter.launch(OCC, ctx);
  let state = await adapter.poll(handle);
  while (state.status === 'running') {
    await new Promise((r) => setTimeout(r, 50));
    state = await adapter.poll(handle);
  }
  return { handle, state };
}

function legCtx(env: NodeJS.ProcessEnv, nonce: string): RoundCtx {
  const legDir = scratch('sc-claude-leg-');
  const briefFile = join(legDir, 'BRIEF.md');
  writeFileSync(briefFile, `NONCE: ${nonce}\nreview\n`);
  return { root: scratch('sc-claude-root-'), legDir, nonce, briefFile, timeoutMs: 30_000, env, rootUnchanged: () => ({ unchanged: true, changes: [] }) };
}

describe('claude end to end, through a fake CLI', () => {
  it('runs a leg: preflight, launch, record-based done, collect from the nonce, ratify, with a scrubbed env', async () => {
    const { home, env } = fakeHome({});
    const ctx = legCtx(env, caseOf('success').nonce);
    const adapter = createClaudeAdapter({ bin: FAKE_CLAUDE });
    const { handle, state } = await runToDone(adapter, ctx);
    expect(state).toMatchObject({ status: 'done', doneBy: 'record' });
    const text = await adapter.collect(handle);
    expect(text.fromNonce).toBe(true);
    const r = await adapter.ratify(handle, ctx);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.enforcement).toBe('strong');
    const argv = JSON.parse(readFileSync(join(home, 'claude-argv.json'), 'utf8')) as { args: string[]; cwd: string; env: string[] };
    expect(argv.cwd).toBe(ctx.root);
    expect(readFileSync(join(home, 'claude-stdin.txt'), 'utf8')).toContain(`NONCE: ${ctx.nonce}`);
    for (const name of argv.env) expect([...CLAUDE_ENV_ALLOW, 'DISABLE_AUTOUPDATER', 'NO_COLOR', '__CF_USER_TEXT_ENCODING']).toContain(name);
    expect(argv.env).not.toContain('SECRET_TOKEN');
    expect(JSON.parse(readFileSync(handle.files['settings'] ?? '', 'utf8'))).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
  });

  it('stops a leg at init when a plugin tool is offered, before any turn, and classifies it as setup', async () => {
    const { env } = fakeHome({ initTools: ['Glob', 'Grep', 'Read', 'mcp__plugin__set_state'], hangAfterInit: true });
    const ctx = legCtx(env, caseOf('success').nonce);
    const adapter = createClaudeAdapter({ bin: FAKE_CLAUDE });
    const { handle, state } = await runToDone(adapter, ctx);
    expect(state).toMatchObject({ status: 'done', doneBy: 'cancel' });
    expect(adapter.classify(handle)).toBe('setup');
    const r = await adapter.ratify(handle, ctx);
    expect(r.status).not.toBe('PASS');
    expect(r.checks.find((c) => c.name === 'init-gate')?.detail).toContain(API_KEY_ROUTE);
  });

  it('kills a leg with a bad init by SIGKILL at once: no SIGTERM reaches it and no grace runs (round 1)', async () => {
    const { home, env } = fakeHome({ initTools: ['Glob', 'Grep', 'Read', 'Bash'], hangAfterInit: true, trapTerm: true });
    const ctx = legCtx(env, caseOf('success').nonce);
    const adapter = createClaudeAdapter({ bin: FAKE_CLAUDE });
    const { handle, state } = await runToDone(adapter, ctx);
    expect(state).toMatchObject({ status: 'done', doneBy: 'cancel' });
    expect(handle.exit).toMatchObject({ signal: 'SIGKILL', sigkilled: true });
    // The default grace is 5000 ms; the leg ended well inside it, and never saw SIGTERM.
    expect(handle.exit?.durationMs).toBeLessThan(4000);
    expect(existsSync(join(home, 'got-sigterm'))).toBe(false);
  });

  it('merges a canary overlay into the leg settings without dropping the read block', async () => {
    const { env } = fakeHome({});
    const ctx = legCtx(env, caseOf('success').nonce);
    const adapter = createClaudeAdapter({ bin: FAKE_CLAUDE, settingsOverlay: { permissions: { allow: ['Read(//**)'], blockReadsOutsideWorkingDirectories: false } } });
    const { handle } = await runToDone(adapter, ctx);
    expect(JSON.parse(readFileSync(handle.files['settings'] ?? '', 'utf8'))).toEqual({
      permissions: { allow: ['Read(//**)'], blockReadsOutsideWorkingDirectories: true },
    });
  });
});
