import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  adjudicate,
  adjudicateHeadless,
  adjudicatorArgs,
  adjudicatorInitProblem,
  adjudicatorSettings,
  assignStableIds,
  EDIT_RULE,
  findingIdOf,
  globReduce,
  HeadlessError,
  HOOK_SOURCE,
  OUTPUT_PLACEHOLDER,
  ratifyAdjudicatorRun,
  takeAdjudicatorLock,
  type HeadlessResult,
  type HeadlessSettings,
} from '../src/adjudicate/index.js';
import { claudeDecl } from '../src/adapters/claude/known.js';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import { renderSummary } from '../src/cli/round.js';
import type { StorePaths } from '../src/cli/round.js';
import { getEvents, getRound, resolveDiffTarget, roundSummary, rootPathOf, type RoundSummary } from '../src/engine/index.js';
import { groupAlive, signalGroup } from '../src/transport/headless.js';
import { fakeRegistry } from './fake-registry.js';
import { adjudicationFromSummary, type AdjOptions } from './helpers/adjudication.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { codexCase, fixtureRepo, harness, OCC, ROSTER_TOML, rosterConfig, runRound, type Harness } from './helpers/round.js';
import { buildRoot } from '../src/root/index.js';

/*
 * The headless adjudicator (P7, plan 6.4, 7.2) through a fake `claude` that writes the stream-json and transcript a
 * real run writes, runs the PreToolUse hook from the --settings file on every tool call, and applies Edit calls to
 * the working copy. Every launch is awaited by the engine, and afterEach kills any process group a test left.
 */

cleanScratchAfterAll();

const FAKE = new URL('./fixtures/bin/fake-claude-adjudicator.mjs', import.meta.url).pathname;
const SETTINGS: HeadlessSettings = { model: 'claude-opus-5-5', effort: 'high', maxTurns: 40, timeoutMs: 20_000 };
type Json = Record<string, unknown>;

const launched: HeadlessResult[] = [];
afterEach(() => {
  for (const r of launched.splice(0)) {
    for (const l of r.launches) {
      const pid = l.exit.pid;
      if (pid !== null && pid > 1 && groupAlive(pid)) signalGroup(pid, 'SIGKILL');
    }
  }
});

interface Settled {
  h: Harness;
  roundId: number;
  summary: RoundSummary;
}

/** A council round of three fake legs, settled and awaiting adjudication. */
async function settledRound(toml = ROSTER_TOML): Promise<Settled> {
  const h = harness();
  const { repo } = fixtureRepo();
  const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), {}, { config: await rosterConfig(toml) });
  expect(result.status).toBe('awaiting-adjudication');
  const roundId = prepared.inputs.roundId;
  return { h, roundId, summary: roundSummary(h.store, h.layout, roundId) };
}

/** A fake HOME for the adjudicator: its scenarios, one per launch. */
function adjHome(launches: Json[], top: Json = {}): { home: string; env: NodeJS.ProcessEnv } {
  const home = scratch('sc-adj-home-');
  writeFileSync(join(home, 'fake-adjudicator.json'), JSON.stringify({ version: '2.1.325', launches, ...top }));
  return { home, env: { PATH: process.env['PATH'], HOME: home } };
}

async function headless(s: Settled, env: NodeJS.ProcessEnv, over: Partial<Parameters<typeof adjudicateHeadless>[3]> = {}): Promise<HeadlessResult> {
  const r = await adjudicateHeadless(s.h.store, s.h.layout, s.roundId, { settings: SETTINGS, bin: FAKE, env, pollMs: 10, ...over });
  launched.push(r);
  return r;
}

/** The valid adjudication of a settled round, with placeholder ids as the headless adjudicator writes them. */
function placeholderDoc(summary: RoundSummary, o: AdjOptions = { outcome: 'owed', verdict: 'NEEDS-WORK', approve: false }, edit: (a: Json) => void = () => undefined): Json {
  const a = adjudicationFromSummary(summary, o) as Json & { findings: Json[]; followups: string[] };
  const map = new Map<string, string>();
  a.findings.forEach((f, i) => {
    const placeholder = `f_${String(i + 1).padStart(12, '0')}`;
    map.set(String(f['id']), placeholder);
    f['id'] = placeholder;
  });
  for (const key of ['earlier_items', 'human_asks']) for (const row of a[key] as Json[]) if (typeof row['fix_row'] === 'string') row['fix_row'] = map.get(row['fix_row']) ?? row['fix_row'];
  a.followups = a.followups.map((id) => map.get(id) ?? id);
  edit(a);
  return a;
}

const counts = (s: Settled): number => (s.h.store.db.prepare('SELECT count(*) AS n FROM findings WHERE round_id = ?').get(s.roundId) as { n: number }).n;
const kinds = (s: Settled): string[] => getEvents(s.h.store.db, s.roundId).map((e) => e.kind);

describe('headless adjudicator: the launch (plan 6.4)', () => {
  const decl = claudeDecl('2.1.325')!;

  it('builds the command line: restricted, dontAsk, four tools, one Edit rule, no MCP, the settings, the prompt on stdin', () => {
    const args = adjudicatorArgs({ model: 'claude-opus-5-5', effort: 'high', sessionId: 's', settingsFile: '/r/settings.json', decl, bare: false, maxTurns: 40 });
    expect(args.slice(0, 24)).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-opus-5-5', '--effort', 'high', '--restricted',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--tools', 'Read,Glob,Grep,Edit', '--strict-mcp-config',
      '--setting-sources', '', '--settings', '/r/settings.json', '--session-id', 's', '--max-turns', '40',
    ]);
    expect(args).not.toContain('--bare');
    expect(args).not.toContain('--mcp-config');
    const allowed = args.indexOf('--allowedTools');
    const disallowed = args.indexOf('--disallowedTools');
    expect(args.slice(allowed + 1, disallowed)).toEqual(['Read', 'Glob', 'Grep', 'Edit(./_mainloop/**)']);
    expect(EDIT_RULE).toBe('Edit(./_mainloop/**)');
    expect(args.slice(disallowed + 1)).toEqual(decl.nonReadBuiltins.filter((t) => t !== 'Edit'));
    expect(args.slice(disallowed + 1)).toContain('Write');
    expect(args.slice(disallowed + 1)).toContain('Bash');
  });

  it('runs --bare with an API key, and then writes no hook (the CLI would skip it)', () => {
    expect(adjudicatorArgs({ model: 'm', effort: 'low', sessionId: 's', settingsFile: '/r/s.json', decl, bare: true })).toContain('--bare');
    expect(adjudicatorSettings(null)).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
    expect(adjudicatorSettings({ command: 'node hook' })).toEqual({
      permissions: { blockReadsOutsideWorkingDirectories: true },
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node hook' }] }] },
    });
  });

  it.each([
    ['the four tools', { tools: ['Edit', 'Glob', 'Grep', 'Read'], permissionMode: 'dontAsk' }, null],
    ['fewer tools', { tools: ['Read'], permissionMode: 'dontAsk' }, null],
    ['a plugin tool', { tools: ['Read', 'Edit', 'mcp__canary__touch'], permissionMode: 'dontAsk' }, 'a plugin or MCP tool reached the adjudicator'],
    ['a built-in write tool', { tools: ['Read', 'Write'], permissionMode: 'dontAsk' }, 'offered Write'],
    ['Bash', { tools: ['Read', 'Bash'], permissionMode: 'dontAsk' }, 'offered Bash'],
    ['another permission mode', { tools: ['Read'], permissionMode: 'auto' }, 'permissionMode auto, not dontAsk'],
    ['no tools list', { permissionMode: 'dontAsk' }, 'has no tools list'],
    ['a non-string entry', { tools: ['Read', { name: 'Bash' }], permissionMode: 'dontAsk' }, 'non-string entry'],
    // Round 1 row 3: an MCP server or an extra root stops the run, even with no tool offered.
    ['empty MCP and extra-root lists', { tools: ['Read'], permissionMode: 'dontAsk', mcp_servers: [], additional_directories: [] }, null],
    ['an MCP server that lists no tool', { tools: ['Read'], permissionMode: 'dontAsk', mcp_servers: [{ name: 'canary', status: 'connected' }] }, 'mcp_servers is not empty'],
    ['an MCP server list that is not a list', { tools: ['Read'], permissionMode: 'dontAsk', mcp_servers: 'canary' }, 'mcp_servers is not a list'],
    ['an extra root', { tools: ['Read'], permissionMode: 'dontAsk', additional_directories: ['/'] }, 'additional_directories is not empty'],
    ['an extra-root list that is not a list', { tools: ['Read'], permissionMode: 'dontAsk', additional_directories: {} }, 'additional_directories is not a list'],
  ])('the init gate judges %s', (_what, init, problem) => {
    const got = adjudicatorInitProblem(init);
    if (problem === null) expect(got).toBeNull();
    else expect(got).toContain(problem);
  });
});

describe('headless adjudicator: placeholder ids (plan 7.3)', () => {
  const T = 'diff:github.com/o/widget:feature';
  it('replaces each placeholder with the stable id of its path and title, and follows every reference', () => {
    const doc = {
      findings: [
        { id: 'f_000000000001', title: 'Loop drops the end.', path: 'w/x.py', other: 1 },
        { id: 'f_000000000002', title: 'mean of nothing', path: null },
      ],
      earlier_items: [{ source: 'f_aaaaaaaaaaaa', fix_row: 'f_000000000001' }, { source: 'R9', fix_row: null }],
      human_asks: [{ id: 'H1', fix_row: 'f_000000000002' }],
      followups: ['f_000000000002'],
      same_as_holder: 'f_000000000001',
    };
    const r = assignStableIds(JSON.stringify(doc), T);
    const out = JSON.parse(r.text) as typeof doc;
    const a = findingIdOf(T, 'w/x.py', 'Loop drops the end.');
    const b = findingIdOf(T, null, 'mean of nothing');
    expect(out.findings.map((f) => f.id)).toEqual([a, b]);
    expect(out.earlier_items.map((e) => e.fix_row)).toEqual([a, null]);
    expect(out.human_asks[0]!.fix_row).toBe(b);
    expect(out.followups).toEqual([b]);
    // Keys the map does not own are left alone.
    expect(out.same_as_holder).toBe('f_000000000001');
    expect(r.changed).toEqual({ f_000000000001: a, f_000000000002: b });
  });

  it('names the stable id in prose that named a placeholder (the live run\'s blocker_call did)', () => {
    const doc = {
      findings: [{ id: 'f_000000000001', title: 't', path: 'p', proof: 'see f_000000000001', same_as: null }],
      earlier_items: [{ source: 'R1', status: 'closed', evidence: 'fixed by f_000000000001', fix_row: null }],
      reason: 'f_000000000001 owed',
      summary: 'One owed row (f_000000000001); f_0000000000012 is not an id; f_aaaaaaaaaaaa is an earlier one.',
      blocker_call: 'f_000000000001 blocks',
      not_verified: ['f_000000000001 at runtime'],
    };
    const id = findingIdOf(T, 'p', 't');
    const out = JSON.parse(assignStableIds(JSON.stringify(doc), T).text) as typeof doc;
    expect(out.blocker_call).toBe(`${id} blocks`);
    expect(out.reason).toBe(`${id} owed`);
    expect(out.summary).toBe(`One owed row (${id}); f_0000000000012 is not an id; f_aaaaaaaaaaaa is an earlier one.`);
    expect(out.not_verified).toEqual([`${id} at runtime`]);
    expect(out.findings[0]!.proof).toBe(`see ${id}`);
    expect(out.earlier_items[0]!.evidence).toBe(`fixed by ${id}`);
  });

  it('never remaps same_as or closes_item, leaves a placeholder used twice for the validator, and passes non-JSON through', () => {
    const doc = {
      findings: [
        { id: 'f_000000000001', title: 'a', path: 'p', same_as: 'f_000000000002', closes_item: 'f_000000000002' },
        { id: 'f_000000000002', title: 'b', path: 'p' },
        { id: 'f_000000000003', title: 'c', path: 'p' },
        { id: 'f_000000000003', title: 'd', path: 'p' },
      ],
      followups: ['f_000000000003'],
    };
    const out = JSON.parse(assignStableIds(JSON.stringify(doc), T).text) as { findings: Json[]; followups: string[] };
    expect(out.findings[0]).toMatchObject({ same_as: 'f_000000000002', closes_item: 'f_000000000002' });
    expect(out.findings.slice(2).map((f) => f['id'])).toEqual(['f_000000000003', 'f_000000000003']);
    expect(out.followups).toEqual(['f_000000000003']);
    expect(assignStableIds('not json', T)).toEqual({ text: 'not json', changed: {} });
    expect(assignStableIds('[1]', T)).toEqual({ text: '[1]', changed: {} });
  });
});

describe('headless adjudicator: what a Glob or Grep pattern can search (round 1 row 1)', () => {
  it.each([
    ['**/*.ts', ['']],
    ['src/**/x*.md', ['src']],
    ['**/*', ['']],
    ['*.{ts,tsx}', ['']],
    ['{src,test}/**/*.ts', ['src', 'test']],
    ['/abs/copy/*.py', ['/abs/copy']],
    ['/*', ['/']],
    ['src/a.ts', ['src/a.ts']],
    ['repo/*.[jt]s', ['repo']],
    ['repo/[a-z0-9_]x', ['repo']],
    ['.eslintrc*', ['']],
    ['**/.github/*.yml', ['']],
  ])('%s reduces to %j', (pattern, dirs) => {
    expect(globReduce(pattern)).toEqual({ dirs, problem: null });
  });

  it.each([
    ['{/etc/passwd,**}', 'brace alternative holding "/"'],
    ['src/{a,/etc/passwd}', 'brace alternative holding "/"'],
    ['.[.]/[.]/etc/passwd', 'character class [.]'],
    ['*/../../*', 'climbs (..)'],
    ['{.,x}./*', 'climbs (..)'],
    ['.?/x', 'could match ".."'],
    ['src/.*/x', 'could match ".."'],
    ['~/x', 'home directory'],
    ['{~,x}/y', 'home directory'],
    ['@(a)/x', 'extglob'],
    ['a|b', 'extglob'],
    ['\\*', 'escape'],
    ['{a,{b,c}}', 'nests braces'],
    ['a}b{', 'unbalanced brace'],
    ['a{b', 'unbalanced brace'],
    ['[!a]x', 'character class [!a]'],
    ['[^a]x', 'character class [^a]'],
    ['[/]etc', 'unclosed character class'],
    ['[--0]x', 'range that is not between two letters or digits'],
    ['a[bc', 'unclosed character class'],
    ['[z-a]x', 'cannot judge'],
    [`${'{a,b}'.repeat(9)}`, 'more than 256 alternatives'],
  ])('%s is a problem: %s', (pattern, problem) => {
    const got = globReduce(pattern);
    expect(got.dirs).toEqual([]);
    expect(got.problem).toContain(problem);
  });
});

describe('headless adjudicator: the PreToolUse hook (plan 6.4, second line)', () => {
  /** A working copy with a file, `_mainloop/`, a link out and a dangling link, and a canary outside it. */
  function copyDir(): { root: string; outside: string; log: string; script: string } {
    const base = realpathSync(scratch('sc-hook-'));
    const root = join(base, 'work');
    mkdirSync(join(root, '_mainloop'), { recursive: true });
    mkdirSync(join(root, 'repo'));
    writeFileSync(join(root, 'repo', 'a.py'), 'x = 1\n');
    writeFileSync(join(root, '_mainloop', 'ADJUDICATION.json'), OUTPUT_PLACEHOLDER);
    const outside = join(base, 'OUTSIDE-CANARY.txt');
    writeFileSync(outside, 'canary\n');
    symlinkSync(outside, join(root, 'repo', 'link-out'));
    symlinkSync(join(base, 'missing'), join(root, 'repo', 'dangling'));
    const script = join(base, 'hook.mjs');
    writeFileSync(script, HOOK_SOURCE);
    return { root, outside, log: join(base, 'hook.log'), script };
  }

  function decide(c: ReturnType<typeof copyDir>, tool: string, input: Json, cwd: string = c.root): { decision: string; reason: string | null } {
    const r = spawnSync(process.execPath, [c.script, c.root, c.log], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd, tool_use_id: 't1' }), encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = r.stdout.trim();
    if (out === '') return { decision: 'allow', reason: null };
    const parsed = JSON.parse(out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    return { decision: parsed.hookSpecificOutput.permissionDecision, reason: parsed.hookSpecificOutput.permissionDecisionReason };
  }

  it.each([
    ['Read inside', 'Read', { file_path: 'repo/a.py' }, 'allow', null],
    ['Read inside by absolute path', 'Read', { file_path: '@ROOT@/repo/a.py' }, 'allow', null],
    ['Read outside by absolute path', 'Read', { file_path: '@OUTSIDE@' }, 'deny', 'resolves outside the working copy'],
    ['Read outside by climbing', 'Read', { file_path: '../OUTSIDE-CANARY.txt' }, 'deny', 'resolves outside the working copy'],
    ['Read through a link out of the copy', 'Read', { file_path: 'repo/link-out' }, 'deny', 'resolves outside the working copy'],
    ['Read through a link that does not resolve', 'Read', { file_path: 'repo/dangling' }, 'deny', 'a link that does not resolve'],
    ['Read of the home directory', 'Read', { file_path: '~/.ssh/id_rsa' }, 'deny', 'names the home directory'],
    ['Read with no path', 'Read', {}, 'deny', 'names no file_path'],
    ['Glob inside', 'Glob', { pattern: '**/*.py' }, 'allow', null],
    ['Glob with an outside base', 'Glob', { pattern: '*', path: '/etc' }, 'deny', 'resolves outside the working copy'],
    ['Glob with an absolute pattern', 'Glob', { pattern: '/etc/*' }, 'deny', 'resolves outside the working copy'],
    ['Glob that climbs after a wildcard', 'Glob', { pattern: '*/../../*' }, 'deny', 'climbs'],
    ['Grep inside', 'Grep', { pattern: 'x', path: 'repo', glob: '*.py' }, 'allow', null],
    ['Grep outside', 'Grep', { pattern: 'x', path: '..' }, 'deny', 'resolves outside the working copy'],
    ['Grep with a climbing glob', 'Grep', { pattern: 'x', glob: '{..,x}/*' }, 'deny', 'climbs'],
    // Round 1 row 1: a pattern is judged by the directories it reduces to, never by the text before its first wildcard.
    ['Glob of every TypeScript file', 'Glob', { pattern: '**/*.ts' }, 'allow', null],
    ['Glob below a literal directory', 'Glob', { pattern: 'src/**/x*.md' }, 'allow', null],
    ['Glob with a brace group in one segment', 'Glob', { pattern: '**/*.{ts,tsx}' }, 'allow', null],
    ['Grep with a brace group in one segment', 'Grep', { pattern: 'x', glob: '*.{ts,tsx}' }, 'allow', null],
    ['Glob with a plain character class', 'Glob', { pattern: 'repo/*.[a-z]y' }, 'allow', null],
    ['Glob with an absolute pattern inside the copy', 'Glob', { pattern: '@ROOT@/repo/*.py' }, 'allow', null],
    ['Glob with an absolute brace alternative', 'Glob', { pattern: '{/etc/passwd,**}' }, 'deny', 'brace alternative holding "/"'],
    ['Glob with an absolute alternative after a literal', 'Glob', { pattern: 'src/{a,/etc/passwd}' }, 'deny', 'brace alternative holding "/"'],
    ['Grep glob with an absolute brace alternative', 'Grep', { pattern: 'x', glob: '{/etc/passwd,**}' }, 'deny', 'brace alternative holding "/"'],
    ['Glob that climbs through character classes', 'Glob', { pattern: '.[.]/[.]/etc/passwd' }, 'deny', 'character class [.]'],
    ['Glob that climbs through a dot segment', 'Glob', { pattern: 'repo/.?/OUTSIDE-CANARY.txt' }, 'deny', 'could match ".."'],
    ['Glob with an extglob', 'Glob', { pattern: '+(a|b)/*' }, 'deny', 'extglob'],
    ['Glob with a negated class', 'Glob', { pattern: 'repo/[!a]*' }, 'deny', 'character class [!a]'],
    ['Glob with nested braces', 'Glob', { pattern: '{a,{b,c}}/*' }, 'deny', 'nests braces'],
    ['Glob with an outside absolute prefix', 'Glob', { pattern: '/etc*' }, 'deny', 'resolves outside the working copy'],
    ['Edit of the output', 'Edit', { file_path: '_mainloop/ADJUDICATION.json', old_string: '{}', new_string: '{"a":1}' }, 'allow', null],
    ['Edit of a reviewed file', 'Edit', { file_path: 'repo/a.py', old_string: 'x', new_string: 'y' }, 'deny', 'Edit is allowed only under _mainloop/'],
    ['Edit outside the copy', 'Edit', { file_path: '@OUTSIDE@', old_string: 'c', new_string: 'd' }, 'deny', 'resolves outside the working copy'],
    ['a plugin tool', 'mcp__canary__touch', {}, 'deny', 'is not Read, Glob, Grep or Edit'],
    ['Bash', 'Bash', { command: 'true' }, 'deny', 'is not Read, Glob, Grep or Edit'],
    ['Write', 'Write', { file_path: '_mainloop/x', content: '' }, 'deny', 'is not Read, Glob, Grep or Edit'],
  ])('%s: %s -> %s', (_what, tool, input, decision, reason) => {
    const c = copyDir();
    const fill = (v: unknown): unknown => (typeof v === 'string' ? v.replace('@ROOT@', c.root).replace('@OUTSIDE@', c.outside) : v);
    const got = decide(c, tool, Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fill(v)])));
    expect(got.decision).toBe(decision);
    if (reason !== null) expect(got.reason).toContain(reason);
    const log = readFileSync(c.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Json);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ tool, decision, tool_use_id: 't1' });
  });

  it('denies every call when the session cwd is not the working copy, and when its input is not JSON', () => {
    const c = copyDir();
    expect(decide(c, 'Read', { file_path: 'repo/a.py' }, join(c.root, 'repo'))).toMatchObject({ decision: 'deny' });
    const r = spawnSync(process.execPath, [c.script, c.root, c.log], { input: 'not json', encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout) as Json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});

describe('headless adjudicator: the recorded live run, replayed through the ratifier', () => {
  const REC = new URL('./fixtures/claude-adjudicator/success/', import.meta.url).pathname;
  const kase = JSON.parse(readFileSync(join(REC, 'case.json'), 'utf8')) as { session: string; model: string; effort: string; cli_version: string };

  /** The recorded run with its placeholders filled: a real working copy, the transcript under a projects dir, the hook log. */
  function recorded(edit: { stream?: (t: string) => string; transcript?: (t: string) => string; hook?: (t: string) => string } = {}) {
    const base = realpathSync(scratch('sc-adj-rec-'));
    const root = join(base, 'work');
    mkdirSync(join(root, '_mainloop'), { recursive: true });
    const fill = (name: string): string => readFileSync(join(REC, name), 'utf8').split('__SC_ROOT__').join(root);
    writeFileSync(join(root, '_mainloop', 'ADJUDICATION.json'), fill('ADJUDICATION.json'));
    writeFileSync(join(base, 'stream.jsonl'), (edit.stream ?? ((t) => t))(fill('stream.jsonl')));
    writeFileSync(join(base, 'stderr.log'), '');
    mkdirSync(join(base, 'projects', 'slug'), { recursive: true });
    writeFileSync(join(base, 'projects', 'slug', `${kase.session}.jsonl`), (edit.transcript ?? ((t) => t))(fill('transcript.jsonl')));
    writeFileSync(join(base, 'hook.log'), (edit.hook ?? ((t) => t))(fill('hook.log')));
    return ratifyAdjudicatorRun({
      root,
      model: kase.model,
      effort: kase.effort,
      sessionId: kase.session,
      cliVersion: kase.cli_version,
      streamFile: join(base, 'stream.jsonl'),
      stderrFile: join(base, 'stderr.log'),
      projectsDir: join(base, 'projects'),
      hookLog: join(base, 'hook.log'),
      timedOut: false,
      initGate: null,
      copyUnchanged: () => ({ unchanged: true, changes: [] }),
      output: join(root, '_mainloop', 'ADJUDICATION.json'),
    });
  }

  it('ratifies the recorded run (claude 2.1.325, claude-opus-5-5 at high): every check passes', () => {
    const r = recorded();
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r).toMatchObject({ status: 'PASS', modelObserved: 'claude-opus-5-5', effortObserved: 'high', toolsOffered: ['Edit', 'Glob', 'Grep', 'Read'], toolsUsed: ['Edit', 'Glob', 'Read'], permissionDenials: [] });
    expect(r.costUsd).toBeGreaterThan(0);
    expect(r.checks.map((c) => c.name)).toContain('hook');
  });

  it.each([
    ['a read outside the copy in the transcript', { transcript: (t: string) => t.replace(/"file_path": "[^"]*BRIEF\.md"/, '"file_path": "/etc/hosts"') }, 'CONTAMINATED', 'tool-paths'],
    ['a plugin tool in system/init', { stream: (t: string) => t.replace('"tools": ["Edit", "Glob", "Grep", "Read"]', '"tools": ["Edit", "Glob", "Grep", "Read", "mcp__p__x"]') }, 'CONTAMINATED', 'offered'],
    ['another effort on a request', { transcript: (t: string) => t.replace('"effort": "high"', '"effort": "low"') }, 'FAIL', 'effort'],
    // A mode the gate missed (it lost a race, or the run was replayed): the ratifier is the second line.
    ['another permission mode in system/init', { stream: (t: string) => t.replace('"permissionMode": "dontAsk"', '"permissionMode": "auto"') }, 'CONTAMINATED', 'permission-mode'],
    ['a hook log short of the calls', { hook: (t: string) => t.split('\n').slice(2).join('\n') }, 'FAIL', 'hook'],
  ])('fails the recorded run with %s', (_what, edit, status, check) => {
    const r = recorded(edit);
    expect(r.status).toBe(status);
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toContain(check);
  });

  // Round 1 row 5: hook coverage is proven per tool use, by tool_use_id, never by a count.
  const lines = (t: string): string[] => t.split('\n').filter((l) => l.trim() !== '');
  const swapOne = (t: string, edit: (row: Json) => Json | null, at = 1): string =>
    `${lines(t)
      .flatMap((l, i) => (i === at ? [edit(JSON.parse(l) as Json)].filter((x): x is Json => x !== null).map((x) => JSON.stringify(x)) : [l]))
      .join('\n')}\n`;
  it.each([
    ['one call\'s entry missing, with a surplus entry in its place (the count still matches)', { hook: (t: string) => swapOne(t, (row) => ({ ...row, tool_use_id: 'toolu_9999' })) }, ['toolu_0002 has no hook entry', 'hook entry toolu_9999 matches no tool use']],
    ['a duplicate entry', { hook: (t: string) => `${t}${lines(t)[0]!}\n` }, ['toolu_0001 has 2 hook entries']],
    ['a surplus entry', { hook: (t: string) => `${t}${JSON.stringify({ tool: 'Read', tool_use_id: 'toolu_9999', paths: [], decision: 'allow', reason: null })}\n` }, ['hook entry toolu_9999 matches no tool use']],
    ['an entry with no tool_use_id', { hook: (t: string) => `${t}${JSON.stringify({ tool: 'Read', tool_use_id: null, paths: [], decision: 'allow', reason: null })}\n` }, ['has no tool_use_id']],
    ['an entry for another tool', { hook: (t: string) => swapOne(t, (row) => ({ ...row, tool: 'Glob' })) }, ['Read toolu_0002 has a hook entry for Glob']],
    ['a tool use with no id in the stream', { stream: (t: string) => t.replace('"id": "toolu_0003", ', '') }, ['a Read tool use (stream) has no id']],
  ])('fails the hook check on %s', (_what, edit, problems) => {
    const r = recorded(edit);
    expect(r.status).toBe('FAIL');
    expect(r.failureClass).toBe('setup');
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['hook']);
    for (const p of problems) expect(r.checks.find((c) => c.name === 'hook')!.detail).toContain(p);
  });

  it('fails the hook check, and is CONTAMINATED, when the hook denied a call', () => {
    const r = recorded({ hook: (t: string) => swapOne(t, (row) => ({ ...row, decision: 'deny', reason: 'denied' })) });
    expect(r.status).toBe('CONTAMINATED');
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['hook', 'hook-denials']);
    expect(r.checks.find((c) => c.name === 'hook')!.detail).toContain('toolu_0002 was not allowed by the hook (deny)');
  });

  // Round 1 row 1: the recorded Glob ("**/*") replaced in both records, and the tools' own results replaced.
  const sub = (from: RegExp, to: string) => (t: string): string => t.replace(from, to);
  const both = (from: RegExp, to: string) => ({ stream: sub(from, to), transcript: sub(from, to) });
  const GLOB = /"pattern": "\*\*\/\*"/g;
  it.each([
    ['a Glob pattern with an absolute brace alternative', both(GLOB, '"pattern": "{/etc/passwd,**}"'), 'brace alternative holding "/"'],
    ['a Glob pattern with an absolute alternative after a literal', both(GLOB, '"pattern": "src/{a,/etc/passwd}"'), 'brace alternative holding "/"'],
    ['a Glob pattern that climbs through character classes', both(GLOB, '"pattern": ".[.]/[.]/etc/passwd"'), 'character class [.]'],
    ['a Glob pattern whose literal directory is outside', both(GLOB, '"pattern": "/etc/*"'), 'resolves outside the root'],
    ['a Glob result naming an absolute path outside', both(/"filenames": \["BRIEF\.md"/g, '"filenames": ["/etc/passwd"'), 'names /etc/passwd'],
    ['a Glob result that climbs, in the transcript only', { transcript: sub(/"filenames": \["BRIEF\.md"/g, '"filenames": ["../../OUTSIDE-CANARY.txt"') }, 'names ../../OUTSIDE-CANARY.txt'],
    ['a Read result naming a file outside, in the stream only', { stream: sub(/"filePath": "[^"]*\/PR\.md"/g, '"filePath": "/etc/hosts"') }, 'names /etc/hosts'],
    ['an Edit result naming a file outside, in the transcript only', { transcript: sub(/"filePath": "[^"]*\/_mainloop\/ADJUDICATION\.json", "oldString"/g, '"filePath": "/tmp/elsewhere.json", "oldString"') }, 'names /tmp/elsewhere.json'],
  ])('is CONTAMINATED on tool-paths with %s', (_what, edit, detail) => {
    const r = recorded(edit);
    expect(r.status).toBe('CONTAMINATED');
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['tool-paths']);
    expect(r.checks.find((c) => c.name === 'tool-paths')!.detail).toContain(detail);
  });

  // Round 1 rows 3 and 4: what reached the session beyond the copy and the prompt.
  const att = (attachment: Json): ((t: string) => string) => (t: string) => `${t}${JSON.stringify({ type: 'attachment', sessionId: kase.session, attachment })}\n`;
  it.each([
    ['an MCP server in system/init', { stream: sub(/"mcp_servers": \[\]/, '"mcp_servers": [{"name": "canary", "status": "connected"}]') }, 'mcp-servers', 'mcp_servers is not empty'],
    ['an extra root in system/init', { stream: sub(/"additional_directories": \[\]/, '"additional_directories": ["/"]') }, 'extra-roots', 'additional_directories is not empty'],
    ['an extra root in the transcript\'s environment', { transcript: sub(/"additionalWorkingDirectories": \[\]/, '"additionalWorkingDirectories": ["/opt/elsewhere"]') }, 'extra-roots', 'additional working directories: /opt/elsewhere'],
    ['a second environment attachment with an extra root', { transcript: att({ type: 'environment', snapshot: { additionalWorkingDirectories: ['/opt'] } }) }, 'extra-roots', '/opt'],
    ['an environment whose extra roots are not a list', { transcript: sub(/"additionalWorkingDirectories": \[\]/, '"additionalWorkingDirectories": "/opt"') }, 'extra-roots', 'not a list'],
    ['a loaded instruction file', { transcript: att({ type: 'instructions', files: [{ path: 'CLAUDE.md' }] }) }, 'instruction-files', 'CLAUDE.md'],
    ['a loaded nested-memory file', { transcript: att({ type: 'nested_memory', detail: [{ path: 'sub/CLAUDE.md' }] }) }, 'instruction-files', 'sub/CLAUDE.md'],
  ])('is CONTAMINATED with %s', (_what, edit, check, detail) => {
    const r = recorded(edit);
    expect(r.status).toBe('CONTAMINATED');
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual([check]);
    expect(r.checks.find((c) => c.name === check)!.detail).toContain(detail);
  });

  // Round 1 row 6: a row with a parent_tool_use_id is a sub-agent's, in either record.
  it.each([
    ['a stream row with a parent_tool_use_id', { stream: sub(/"parent_tool_use_id": null/, '"parent_tool_use_id": "toolu_0001"') }, 'stream 1, transcript 0'],
    ['a transcript entry with a parent_tool_use_id', { transcript: (t: string) => t.replace(/}\n$/, ', "parent_tool_use_id": "toolu_0001"}\n') }, 'stream 0, transcript 1'],
  ])('is CONTAMINATED on sidechains with %s', (_what, edit, detail) => {
    const r = recorded(edit);
    expect(r.status).toBe('CONTAMINATED');
    expect(r.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['sidechains']);
    expect(r.checks.find((c) => c.name === 'sidechains')!.detail).toContain(detail);
  });

  // Round 1 row 11: none of the four tools runs a shell, so a "$" in a path is a character, as the hook treats it.
  it('ratifies the recorded run with a "$" in a Read, an Edit and a Glob path', () => {
    const dollar = (t: string): string =>
      t
        .replace(/"file_path": "([^"]*)\/PR\.md"/g, '"file_path": "$1/app/routes/$$id.tsx"')
        .replace(/"filePath": "([^"]*)\/PR\.md"/g, '"filePath": "$1/app/routes/$$id.tsx"')
        .replace(/"pattern": "\*\*\/\*"/g, '"pattern": "app/$$slug/**/*", "path": "routes/$$id"');
    const r = recorded({ stream: dollar, transcript: dollar });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    const paths = (r.detail['toolUses'] as Array<{ paths: string[] }>).flatMap((u) => u.paths);
    expect(paths.some((p) => p.endsWith('/app/routes/$id.tsx'))).toBe(true);
    expect(paths).toContain('routes/$id');
  });

  it.each(['**/*.{js,md}', '**/*.ts', 'src/**/x*.md', '*.[jt]s', '_council/legs/*/answer.md'])('ratifies the recorded run with the ordinary pattern %s', (pattern) => {
    const r = recorded(both(GLOB, `"pattern": "${pattern}"`));
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
  });

  it.each([
    ['a Glob base outside the copy', '"pattern": "*", "path": "/etc"', '/etc (resolves outside the root)'],
    ['a pattern directory that leaves through its base', '"pattern": "x/*", "path": "/etc"', 'directory x'],
    ['a Grep glob with an absolute brace alternative', '"pattern": "x", "glob": "{/etc/passwd,**}"', 'brace alternative holding "/"'],
  ])('is CONTAMINATED on tool-paths with %s', (_what, input, detail) => {
    // The recorded call is a Glob; the Grep case renames it in both records and the hook log.
    const r2 = input.includes('"glob"')
      ? recorded({ ...both(/"name": "Glob", "input": \{"pattern": "\*\*\/\*"\}/g, `"name": "Grep", "input": {${input}}`), hook: (t: string) => t.replace('"tool":"Glob"', '"tool":"Grep"') })
      : recorded(both(GLOB, input));
    expect(r2.status).toBe('CONTAMINATED');
    expect(r2.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['tool-paths']);
    expect(r2.checks.find((c) => c.name === 'tool-paths')!.detail).toContain(detail);
  });
});

describe('headless adjudicator: end to end through a fake claude (P7 acceptance 1)', () => {
  it('adjudicates a settled round: the copy, the inputs, the placeholder, the stored result and the record on the round', async () => {
    const s = await settledRound();
    const doc = placeholderDoc(s.summary);
    const { home, env } = adjHome([{ toolUses: [{ name: 'Read', input: { file_path: '_council/ADJUDICATE.md' } }, { name: 'Glob', input: { pattern: '**/*.py' } }], output: doc }]);
    const r = await headless(s, env);
    expect(r.outcome, r.reason).toBe('adjudicated');
    expect(r.launches).toHaveLength(1);
    const l = r.launches[0]!;
    expect(l.ratification.status).toBe('PASS');
    expect(l.ratification.toolsOffered).toEqual(['Edit', 'Glob', 'Grep', 'Read']);
    expect(l.ratification.toolsUsed).toEqual(['Edit', 'Glob', 'Read']);
    // Stored through the P5 store: the round is adjudicated, with the stable ids.
    const round = getRound(s.h.store.db, s.roundId)!;
    expect(round).toMatchObject({ status: 'adjudicated', verdict: 'NEEDS-WORK', owed_count: 1, needs_ruling: 0 });
    const ids = (s.h.store.db.prepare('SELECT id FROM findings WHERE round_id = ?').all(s.roundId) as Array<{ id: string }>).map((x) => x.id);
    expect(ids).toEqual([findingIdOf(s.summary.target_key, 'sabotage-council/src/config/rules.ts', 'the replayed finding')]);
    // The record on the round (plan 6.4).
    expect(round.adjudicator_model_observed).toBe('claude-opus-5-5');
    expect(round.adjudicator_effort_observed).toBe('high');
    expect(JSON.parse(round.adjudicator_tools_json!)).toEqual({ offered: ['Edit', 'Glob', 'Grep', 'Read'], used: ['Edit', 'Glob', 'Read'] });
    expect(JSON.parse(round.adjudicator_denials_json!)).toEqual([]);
    expect(round.adjudicator_cost_usd).toBeCloseTo(0.0123);
    expect(round.adjudicator_turns).toBeGreaterThan(0);
    expect(round.adjudicator_ms).toBeGreaterThan(0);
    expect(round.adjudicator_record_path).toMatch(new RegExp(`${l.sessionId}\\.jsonl$`));
    expect(kinds(s)).toEqual(expect.arrayContaining(['adjudicator-started', 'adjudicator-run', 'adjudicated']));
    // The launch: the exact flags, the run's settings (key + hook), the prompt, cwd = the working copy.
    const argv = JSON.parse(readFileSync(join(home, 'argv-1.json'), 'utf8')) as { args: string[]; cwd: string; env: string[] };
    expect(argv.args).toContain('--restricted');
    expect(argv.args).not.toContain('--bare');
    expect(argv.cwd).toBe(realpathSync(join(r.runDir)) + '/work');
    expect(argv.env).not.toContain('ANTHROPIC_API_KEY');
    const settings = JSON.parse(readFileSync(join(home, 'settings-1.json'), 'utf8')) as Json;
    expect(settings).toMatchObject({ permissions: { blockReadsOutsideWorkingDirectories: true }, hooks: { PreToolUse: [{ matcher: '*' }] } });
    const stdin = readFileSync(join(home, 'stdin-1.txt'), 'utf8');
    expect(stdin).toContain('_council/ADJUDICATE.md');
    expect(stdin).toContain('_mainloop/ADJUDICATION.json (it holds {})');
    // The hook ran on every call and allowed each.
    const hookLog = readFileSync(join(l.dir, 'hook.log'), 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Json);
    expect(hookLog.map((x) => [x['tool'], x['decision']])).toEqual([['Read', 'allow'], ['Glob', 'allow'], ['Read', 'allow'], ['Edit', 'allow']]);
    // The raw output and the id-assigned one are kept; the working copy is gone, and so is the round's root.
    expect(JSON.parse(readFileSync(join(l.dir, 'ADJUDICATION.raw.json'), 'utf8')) as Json).toMatchObject({ findings: [{ id: 'f_000000000001' }] });
    expect(existsSync(join(r.runDir, 'work'))).toBe(false);
    expect(existsSync(rootPathOf(s.h.layout, s.roundId, 1))).toBe(false);
  });

  it('gives the adjudicator a proven copy: ROUND.json with relative paths, the counted answers, the table, the spec', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env, { keepWorkspace: true });
    expect(r.outcome).toBe('adjudicated');
    const work = join(r.runDir, 'work');
    const view = JSON.parse(readFileSync(join(work, '_council', 'ROUND.json'), 'utf8')) as Json & { legs: Json[] };
    expect(view).toMatchObject({ round_id: s.roundId, root: '.', brief_path: 'BRIEF.md', output_path: '_mainloop/ADJUDICATION.json', nonce: s.summary.nonce, tests: null });
    for (const leg of view.legs) {
      expect(leg['answer_path']).toBe(leg['counted'] === true ? `_council/legs/${String(leg['seat'])}-${String(leg['role'])}-${String(leg['attempt'])}/answer.md` : null);
      if (typeof leg['answer_path'] === 'string') expect(readFileSync(join(work, leg['answer_path']), 'utf8')).toMatch(/^NONCE: /);
    }
    expect(JSON.stringify(view)).not.toContain(s.h.layout.roundsDir);
    expect(readFileSync(join(work, '_council', 'RATIFICATION.md'), 'utf8')).toContain('| a-primary-1 |');
    expect(readFileSync(join(work, '_council', 'TESTS.md'), 'utf8')).toContain('None: no tests ran');
    expect(readFileSync(join(work, '_council', 'ADJUDICATE.md'), 'utf8')).toContain('## Headless runs');
    expect(readFileSync(join(work, 'BRIEF.md'), 'utf8')).toBe(readFileSync(join(s.h.layout.roundsDir, String(s.roundId), 'BRIEF.md'), 'utf8'));
  });

  it('re-prompts once with the validator\'s errors, and stores the second document when it is valid', async () => {
    const s = await settledRound();
    const bad = placeholderDoc(s.summary, { outcome: 'follow-up', verdict: 'NEEDS-WORK', approve: false });
    const { home, env } = adjHome([{ output: bad }, { output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('adjudicated');
    expect(r.reason).toBe('adjudicated after one re-prompt');
    expect(r.launches.map((l) => l.validation?.ok)).toEqual([false, true]);
    const second = readFileSync(join(home, 'stdin-2.txt'), 'utf8');
    expect(second).toContain('[verdict] NEEDS-WORK with 0 owed rows');
    expect(second).toContain('This is the last attempt');
    expect(kinds(s)).toEqual(expect.arrayContaining(['adjudication-rejected', 'adjudicated']));
    expect(getRound(s.h.store.db, s.roundId)).toMatchObject({ status: 'adjudicated', needs_ruling: 0 });
    // Costs add up over both launches.
    expect(getRound(s.h.store.db, s.roundId)!.adjudicator_cost_usd).toBeCloseTo(0.0246);
  });

  it('holds the round for a ruling when the second document fails too (plan 3.8), and refuses another headless run', async () => {
    const s = await settledRound();
    const bad = placeholderDoc(s.summary, { outcome: 'follow-up', verdict: 'NEEDS-WORK', approve: false });
    const { env } = adjHome([{ output: bad }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('needs-ruling');
    expect(r.launches).toHaveLength(2);
    const round = getRound(s.h.store.db, s.roundId)!;
    expect(round).toMatchObject({ status: 'awaiting-adjudication', needs_ruling: 1 });
    expect(counts(s)).toBe(0);
    const held = getEvents(s.h.store.db, s.roundId).filter((e) => e.kind === 'needs-ruling');
    expect(held).toHaveLength(1);
    expect(held[0]!.detail).toMatchObject({ reason: 'adjudication-invalid' });
    expect(roundSummary(s.h.store, s.h.layout, s.roundId).held).toEqual({ reason: 'adjudication-invalid' });
    await expect(headless(s, env)).rejects.toThrow(HeadlessError);
    await expect(headless(s, env)).rejects.toThrow(/held for your ruling/);
    // The user's own adjudication is the ruling: it still stores.
    expect(adjudicate(s.h.store, s.h.layout, s.roundId, JSON.stringify(adjudicationFromSummary(s.summary, { outcome: 'owed', verdict: 'NEEDS-WORK', approve: false }))).stored).toBe(true);
  });

  it.each([
    ['a plugin tool', { initTools: ['Edit', 'Glob', 'Grep', 'Read', 'mcp__canary__touch'] }, 'mcp__canary__touch'],
    ['a wrong permission mode', { permissionMode: 'auto' }, 'not dontAsk'],
    ['an MCP server that offers no tool', { initMcpServers: [{ name: 'canary', status: 'connected' }] }, 'mcp_servers is not empty'],
    ['an extra readable root', { initAdditionalDirectories: ['/'] }, 'additional_directories is not empty'],
  ])('stops the run at init on %s: setup, no adjudication, no tool executed', async (_what, init, problem) => {
    const s = await settledRound();
    // A model that would call the plugin tool 1.5 s after init, then write a valid adjudication.
    const { home, env } = adjHome([{ ...init, hangAfterInit: true, output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('failed');
    expect(r.launches).toHaveLength(1);
    const l = r.launches[0]!;
    expect(l.initGate).toContain(problem);
    expect(l.ratification).toMatchObject({ status: 'FAIL', failureClass: 'setup' });
    // The record names the gate as the failed check, with its reason.
    expect(l.ratification.checks.find((c) => c.name === 'init-gate')).toMatchObject({ ok: false, detail: l.initGate });
    expect(l.exit.doneBy).toBe('cancel');
    expect(existsSync(join(home, 'TOOL-EXECUTED'))).toBe(false);
    const stream = readFileSync(join(l.dir, 'stream.jsonl'), 'utf8');
    expect(stream).not.toContain('tool_use');
    expect(getRound(s.h.store.db, s.roundId)).toMatchObject({ status: 'awaiting-adjudication', needs_ruling: 0 });
    expect(counts(s)).toBe(0);
  });

  it('fails a run that read outside the copy like a contaminated leg: held, nothing stored, even with a valid document', async () => {
    const s = await settledRound();
    const outside = join(scratch('sc-adj-outside-'), 'OUTSIDE-CANARY.txt');
    writeFileSync(outside, 'secret canary\n');
    const { env } = adjHome([{ toolUses: [{ name: 'Read', input: { file_path: outside } }], output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('needs-ruling');
    const l = r.launches[0]!;
    expect(l.ratification.status).toBe('CONTAMINATED');
    const failed = l.ratification.checks.filter((c) => !c.ok).map((c) => c.name);
    expect(failed).toEqual(expect.arrayContaining(['tool-paths', 'permission-denials', 'hook-denials']));
    expect(l.ratification.permissionDenials).toHaveLength(1);
    expect(readFileSync(join(l.dir, 'stream.jsonl'), 'utf8')).not.toContain('secret canary');
    expect(getRound(s.h.store.db, s.roundId)).toMatchObject({ status: 'awaiting-adjudication', needs_ruling: 1 });
    expect(JSON.parse(getRound(s.h.store.db, s.roundId)!.adjudicator_denials_json!)).toHaveLength(1);
    expect(counts(s)).toBe(0);
    expect(getEvents(s.h.store.db, s.roundId).find((e) => e.kind === 'needs-ruling')?.detail).toMatchObject({ reason: 'adjudicator-contaminated' });
  });

  it('judges reads from the transcript: an outside read the stream and the hook never showed still contaminates', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ transcriptOnly: [{ name: 'Read', input: { file_path: '/etc/hosts' } }], output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('needs-ruling');
    const failed = r.launches[0]!.ratification.checks.filter((c) => !c.ok);
    // The read is caught from the transcript alone; the hook log is short of the transcript's calls too.
    expect(failed.map((c) => c.name)).toEqual(['tool-paths', 'hook']);
    expect(failed[0]!.detail).toContain('/etc/hosts');
  });

  it.each([
    ['*/../../*', 'climbs (..)'],
    ['{/etc/passwd,**}', 'brace alternative holding "/"'],
    ['src/{a,/etc/passwd}', 'brace alternative holding "/"'],
    ['.[.]/[.]/etc/passwd', 'character class [.]'],
  ])('judges the glob %s from the transcript alone', async (pattern, detail) => {
    const s = await settledRound();
    const { env } = adjHome([{ transcriptOnly: [{ name: 'Glob', input: { pattern } }], output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('needs-ruling');
    const failed = r.launches[0]!.ratification.checks.filter((c) => !c.ok);
    expect(failed.map((c) => c.name)).toEqual(['tool-paths', 'hook']);
    expect(failed[0]!.detail).toContain(detail);
  });

  it('denies a brace glob that names an outside path at the hook, and holds the round', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ toolUses: [{ name: 'Glob', input: { pattern: '{/etc/passwd,**}' } }], output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('needs-ruling');
    const l = r.launches[0]!;
    expect(l.ratification.status).toBe('CONTAMINATED');
    expect(l.ratification.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(expect.arrayContaining(['tool-paths', 'permission-denials', 'hook-denials']));
    const hookLog = readFileSync(join(l.dir, 'hook.log'), 'utf8').trim().split('\n').map((x) => JSON.parse(x) as Json);
    expect(hookLog[0]).toMatchObject({ tool: 'Glob', decision: 'deny' });
    expect(String(hookLog[0]!['reason'])).toContain('brace alternative holding "/"');
  });

  it('adjudicates a run that read a file with "$" in its name (round 1 row 11)', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ toolUses: [{ name: 'Read', input: { file_path: 'app/routes/$id.tsx' } }, { name: 'Glob', input: { pattern: '*.tsx', path: 'app/routes/$id' } }], output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome, r.reason).toBe('adjudicated');
    expect(r.launches[0]!.ratification.checks.find((c) => c.name === 'tool-paths')).toMatchObject({ ok: true });
  });

  it('allows a brace glob in one segment end to end: adjudicated', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ toolUses: [{ name: 'Glob', input: { pattern: '**/*.{py,md}' }, result: { filenames: ['BRIEF.md'] } }, { name: 'Grep', input: { pattern: 'x', glob: '*.{py,md}' } }], output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome, r.reason).toBe('adjudicated');
  });

  it('cancels a running launch when the call is aborted: failed, nothing stored, the process gone', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ hangAfterInit: true, actAfterMs: 8000, output: placeholderDoc(s.summary) }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const r = await headless(s, env, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(6000);
    expect(r.outcome).toBe('failed');
    expect(r.launches[0]!.exit.doneBy).toBe('cancel');
    expect(getRound(s.h.store.db, s.roundId)).toMatchObject({ status: 'awaiting-adjudication', needs_ruling: 0 });
  });

  it.each([
    // A denied call has no allow entry, so the hook check fails beside the denials (round 1 row 5).
    ['an Edit outside _mainloop/', { toolUses: [{ name: 'Edit', input: { file_path: 'BRIEF.md', old_string: 'NONCE', new_string: 'X' } }] }, ['edit-paths', 'permission-denials', 'hook', 'hook-denials']],
    ['an Edit of its own inputs', { toolUses: [{ name: 'Edit', input: { file_path: '_council/ROUND.json', old_string: '{', new_string: '[' } }] }, ['edit-paths', 'permission-denials', 'hook', 'hook-denials']],
    ['a change to the copy', { writeIntoCopy: 'planted.txt' }, ['copy-unchanged']],
    ['a Glob whose result names a file outside the copy', { toolUses: [{ name: 'Glob', input: { pattern: '**/*' }, result: { filenames: ['../../OUTSIDE-CANARY.txt'] } }] }, ['tool-paths']],
    ['a tool beyond the four', { toolUses: [{ name: 'Bash', input: { command: 'true' } }] }, ['tools-used', 'permission-denials', 'hook', 'hook-denials']],
    ['a subagent sidechain', { sidechain: true }, ['sidechains']],
    ['a sub-agent row in the stream only (parent_tool_use_id)', { subAgent: true }, ['sidechains']],
    ['another cwd in system/init', { initCwd: '/' }, ['cwd']],
    ['an extra root in the transcript', { extraRoots: ['/'] }, ['extra-roots']],
    ['a loaded instruction file', { instructionFiles: ['CLAUDE.md'] }, ['instruction-files']],
  ])('is contaminated by %s', async (_what, scenario, failedChecks) => {
    const s = await settledRound();
    const { env } = adjHome([{ ...scenario, output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('needs-ruling');
    expect(r.launches[0]!.ratification.status).toBe('CONTAMINATED');
    expect(r.launches[0]!.ratification.checks.filter((c) => !c.ok).map((c) => c.name).sort()).toEqual([...failedChecks].sort());
    // Nothing a contaminated run wrote is read.
    expect(existsSync(join(r.launches[0]!.dir, 'ADJUDICATION.raw.json'))).toBe(false);
    expect(counts(s)).toBe(0);
  });

  it.each([
    ['a wrong model', { model: 'claude-haiku-5-5' }, 'model', ['model', 'model-usage']],
    ['a wrong effort', { effort: 'low' }, 'model', ['effort']],
    ['no output written', { output: undefined }, 'empty', ['output']],
    ['a hook that never ran', { skipHook: true }, 'setup', ['hook']],
    ['an error result', { result: { is_error: true, subtype: 'error_during_execution', result: 'API Error: 529 overloaded_error' } }, 'capacity', ['result']],
    ['another session in init', { initSession: '00000000-0000-4000-8000-00000000dead' }, 'setup', ['session']],
    ['a malformed stream line', { malformedLine: true }, 'setup', ['stream']],
    ['another CLI version in init', { initVersion: '2.1.999' }, 'setup', ['cli-version']],
    ['no transcript', { noTranscript: true }, 'model', ['transcript', 'model', 'effort']],
  ])('fails, without holding the round, on %s', async (_what, scenario, cls, failedChecks) => {
    const s = await settledRound();
    const { env } = adjHome([{ output: placeholderDoc(s.summary), ...scenario }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('failed');
    expect(r.launches[0]!.ratification).toMatchObject({ status: 'FAIL', failureClass: cls });
    expect(r.launches[0]!.ratification.checks.filter((c) => !c.ok).map((c) => c.name).sort()).toEqual([...failedChecks].sort());
    expect(getRound(s.h.store.db, s.roundId)).toMatchObject({ status: 'awaiting-adjudication', needs_ruling: 0 });
  });

  it('runs --bare with ANTHROPIC_API_KEY: no hook in the settings, the key passed through by name, adjudicated', async () => {
    const s = await settledRound();
    const { home, env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const r = await headless(s, { ...env, ANTHROPIC_API_KEY: 'sk-test-not-a-key' });
    expect(r.outcome, r.reason).toBe('adjudicated');
    expect(r.bare).toBe(true);
    const argv = JSON.parse(readFileSync(join(home, 'argv-1.json'), 'utf8')) as { args: string[]; env: string[] };
    expect(argv.args).toContain('--bare');
    expect(argv.args).toContain('--restricted');
    expect(argv.env).toContain('ANTHROPIC_API_KEY');
    expect(JSON.parse(readFileSync(join(home, 'settings-1.json'), 'utf8'))).toEqual({ permissions: { blockReadsOutsideWorkingDirectories: true } });
    expect(existsSync(join(r.launches[0]!.dir, 'hook.log'))).toBe(false);
    expect(r.launches[0]!.ratification.checks.map((c) => c.name)).not.toContain('hook');
  });

  it('refuses a round that is not awaiting adjudication, and a round another headless run holds', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const adjDir = join(s.h.layout.roundsDir, String(s.roundId), 'adjudicator');
    mkdirSync(adjDir, { recursive: true });
    writeFileSync(join(adjDir, 'running.json'), JSON.stringify({ pid: process.pid }));
    await expect(headless(s, env)).rejects.toThrow(/already running/);
    // A lock whose process is gone is taken over.
    writeFileSync(join(adjDir, 'running.json'), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    expect((await headless(s, env)).outcome).toBe('adjudicated');
    expect(existsSync(join(adjDir, 'running.json'))).toBe(false);
    await expect(headless(s, env)).rejects.toThrow(/is adjudicated; only a round awaiting adjudication/);
  });

  it('takes over a stale lock exclusively: a caller that judged it stale after another took it over refuses (round 1 row 10)', () => {
    const dir = scratch('sc-adj-lock-');
    const file = join(dir, 'running.json');
    const DEAD = 2 ** 22 + 12345;
    writeFileSync(file, JSON.stringify({ pid: DEAD }));
    // Caller A judges the lock stale; before A takes it over, caller B takes it over (B runs to completion here).
    let releaseB: (() => void) | null = null;
    expect(() => takeAdjudicatorLock(dir, { afterStaleRead: () => (releaseB = takeAdjudicatorLock(dir)) })).toThrow(/already running/);
    expect(releaseB).not.toBeNull();
    expect((JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid).toBe(process.pid);
    expect(existsSync(`${file}.takeover`)).toBe(false);
    releaseB!();
    expect(existsSync(file)).toBe(false);
    // A lock released between the judgment and the takeover: the caller takes a fresh one.
    writeFileSync(file, JSON.stringify({ pid: DEAD }));
    const release = takeAdjudicatorLock(dir, { afterStaleRead: () => rmSync(file) });
    expect((JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid).toBe(process.pid);
    release();
    // A takeover already in progress: refused, naming the file, and the stale lock is left as it was.
    writeFileSync(file, JSON.stringify({ pid: DEAD }));
    writeFileSync(`${file}.takeover`, JSON.stringify({ pid: DEAD + 1 }));
    expect(() => takeAdjudicatorLock(dir)).toThrow(/taking over a stale adjudicator lock/);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { pid: number }).pid).toBe(DEAD);
  });

  it('builds the copy from a rebuilt root when the round\'s root no longer hashes to the sealed tree', async () => {
    const s = await settledRound();
    writeFileSync(join(rootPathOf(s.h.layout, s.roundId, 1), 'BRIEF.md'), 'tampered\n');
    const { env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env, { keepWorkspace: true });
    expect(r.outcome).toBe('adjudicated');
    const started = getEvents(s.h.store.db, s.roundId).find((e) => e.kind === 'adjudicator-started')?.detail as { source_root: string };
    expect(started.source_root).toMatch(new RegExp(`-${s.roundId}-a2$`));
    expect(readFileSync(join(r.runDir, 'work', 'BRIEF.md'), 'utf8')).not.toBe('tampered\n');
  });

  it('launches nothing when the working copy does not hash to the sealed tree, and removes the partial copy', async () => {
    const s = await settledRound();
    const { home, env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env, {
      afterCopy: (root) => {
        writeFileSync(join(root, 'BRIEF.md'), 'changed in the copy\n');
        // A read-only dir in the copy (a copied tree keeps its modes): the removal opens it first (round 1 row 9).
        mkdirSync(join(root, 'ro'));
        writeFileSync(join(root, 'ro', 'x.txt'), 'x\n');
        chmodSync(join(root, 'ro'), 0o500);
      },
    });
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('not the sealed');
    expect(r.launches).toHaveLength(0);
    expect(existsSync(join(home, 'argv-1.json'))).toBe(false);
    expect(kinds(s)).toContain('adjudicator-workspace-fail');
    expect(existsSync(join(r.runDir, 'work'))).toBe(false);
  });

  it('records a launch whose store was refused because the round was adjudicated meanwhile: failed, the event written', async () => {
    const s = await settledRound();
    // The model writes its document 1.5 s after init; the user adjudicates the round in between (round 1 row 8).
    const { home, env } = adjHome([{ hangAfterInit: true, actAfterMs: 1500, output: placeholderDoc(s.summary) }]);
    const running = headless(s, env);
    const started = Date.now();
    while (!existsSync(join(home, 'argv-1.json')) && Date.now() - started < 15_000) await new Promise((res) => setTimeout(res, 20));
    expect(existsSync(join(home, 'argv-1.json'))).toBe(true);
    const mine = adjudicate(s.h.store, s.h.layout, s.roundId, JSON.stringify(adjudicationFromSummary(s.summary, { outcome: 'owed', verdict: 'NEEDS-WORK', approve: false })));
    expect(mine.stored).toBe(true);
    const r = await running;
    expect(r.outcome).toBe('failed');
    expect(r.reason).toContain('the store refused the adjudication, so nothing was stored');
    expect(r.reason).toContain('only a round awaiting adjudication');
    expect(r.launches).toHaveLength(1);
    expect(r.launches[0]!.ratification.status).toBe('PASS');
    const runs = getEvents(s.h.store.db, s.roundId).filter((e) => e.kind === 'adjudicator-run');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.detail).toMatchObject({ launch: 1, status: 'PASS', store_error: expect.stringContaining('is adjudicated') });
    // The user's adjudication stands: one adjudicated event, the user's.
    expect(getEvents(s.h.store.db, s.roundId).filter((e) => e.kind === 'adjudicated')).toHaveLength(1);
    expect(getRound(s.h.store.db, s.roundId)).toMatchObject({ status: 'adjudicated', needs_ruling: 0 });
  });

  it('merges the record over calls: tools and denials kept, cost in the round total (round 1 row 7)', async () => {
    const s = await settledRound();
    const outside = join(scratch('sc-adj-outside-'), 'OUTSIDE-CANARY.txt');
    writeFileSync(outside, 'secret canary\n');
    const { env } = adjHome([
      { toolUses: [{ name: 'Read', input: { file_path: outside } }], output: placeholderDoc(s.summary) },
      { toolUses: [{ name: 'Grep', input: { pattern: 'x', glob: '*.py' } }], output: placeholderDoc(s.summary) },
    ]);
    const first = await headless(s, env);
    expect(first.outcome).toBe('needs-ruling');
    // The user releases the hold (P8's ruling command will), and a second call adjudicates cleanly.
    s.h.store.db.prepare('UPDATE rounds SET needs_ruling = 0 WHERE id = ?').run(s.roundId);
    const second = await headless(s, env);
    expect(second.outcome, second.reason).toBe('adjudicated');
    const round = getRound(s.h.store.db, s.roundId)!;
    expect(JSON.parse(round.adjudicator_tools_json!)).toEqual({ offered: ['Edit', 'Glob', 'Grep', 'Read'], used: ['Edit', 'Grep', 'Read'] });
    const denials = JSON.parse(round.adjudicator_denials_json!) as Json[];
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({ tool_name: 'Read' });
    expect(round.adjudicator_cost_usd).toBeCloseTo(0.0246);
    const summary = roundSummary(s.h.store, s.h.layout, s.roundId);
    const legs = summary.legs.reduce((t, l) => t + (l.cost_usd ?? 0), 0);
    expect(summary.cost.usd).toBeCloseTo(legs + 0.0246);
    expect(renderSummary(summary).find((l) => l.startsWith('cost $'))).toContain(`headless adjudicator $0.0246`);
  });

  it('copies only the counted legs\' answers: a leg that failed is listed with no answer', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), { codex: { [OCC.a]: [codexCase('usage-limit')] } });
    // A leg that failed but left an answer (as a contaminated leg can): it is not a review, so it is not an input.
    writeFileSync(join(h.layout.roundsDir, String(prepared.inputs.roundId), 'legs', 'a-primary-1', 'answer.md'), 'NONCE: 000000000000\nan answer from a leg that did not ratify\n');
    const s: Settled = { h, roundId: prepared.inputs.roundId, summary: roundSummary(h.store, h.layout, prepared.inputs.roundId) };
    const { env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const r = await headless(s, env, { keepWorkspace: true });
    expect(r.outcome, r.reason).toBe('adjudicated');
    const view = JSON.parse(readFileSync(join(r.runDir, 'work', '_council', 'ROUND.json'), 'utf8')) as { legs: Json[] };
    expect(view.legs.map((l) => [`${String(l['seat'])}-${String(l['role'])}`, l['counted'], l['answer_path'] !== null])).toEqual([
      ['a-primary', false, false],
      ['b-primary', true, true],
      ['c-primary', true, true],
      ['a-fallback', true, true],
    ]);
    expect(readdirSync(join(r.runDir, 'work', '_council', 'legs')).sort()).toEqual(['a-fallback-1', 'b-primary-1', 'c-primary-1']);
  });

  it('never meets _council or _mainloop in a sealed tree: a repository name cannot start with "_"', () => {
    const { repo, head } = fixtureRepo();
    for (const name of ['_council', '_mainloop']) {
      expect(() => buildRoot(join(scratch('sc-adj-reserved-'), 'r'), { repo, name, head })).toThrow(/must be 1-100 characters/);
    }
  });

  it('fails at preflight, launching nothing, when claude is not logged in and no API key is set', async () => {
    const s = await settledRound();
    const { home, env } = adjHome([{ output: placeholderDoc(s.summary) }], { loggedIn: false });
    const r = await headless(s, env);
    expect(r.outcome).toBe('failed');
    expect(r.launches).toHaveLength(0);
    expect(r.reason).toContain('not logged in');
    expect(existsSync(join(home, 'argv-1.json'))).toBe(false);
    expect(kinds(s)).toContain('adjudicator-preflight-fail');
  });
});

describe('headless adjudicator: the validator rejects each class of bad output (P7 acceptance 1)', () => {
  const HIGH_ONLY = ROSTER_TOML.replace('leg_timeout_minutes = 1', 'leg_timeout_minutes = 1\nhigh_only_from_round = 1');
  type Case = [string, string | null, (s: Settled) => Json, string];
  const CASES: Case[] = [
    ['NEEDS-WORK with 0 owed', null, (s) => placeholderDoc(s.summary, { outcome: 'follow-up', verdict: 'NEEDS-WORK', approve: false }), '[verdict] NEEDS-WORK with 0 owed rows'],
    [
      'a duplicate in unmapped',
      null,
      (s) => placeholderDoc(s.summary, undefined, (a) => (a['unmapped'] as Json[]).push({ seat: 'b', leg_finding: 'F1', reason: 'a duplicate' })),
      '[attribution] b F1 is mapped twice',
    ],
    ['a missing human-ask row', 'asks', (s) => placeholderDoc(s.summary), '[human-asks] ask H1 has no human_asks row'],
    [
      'round 4+ HIGH-only on an owed MEDIUM row',
      'high-only',
      (s) => placeholderDoc(s.summary, undefined, (a) => ((a['findings'] as Json[])[0]!['severity'] = 'MEDIUM')),
      '[round-rule]',
    ],
    [
      'round 4+ HIGH-only on effective verdicts',
      'high-only',
      (s) =>
        placeholderDoc(s.summary, undefined, (a) => {
          const f = (a['findings'] as Json[])[0]!;
          f['severity'] = 'MEDIUM';
          f['outcome'] = 'ruling';
          a['needs_ruling'] = true;
          a['verdict'] = 'SHIP-WITH-FIXES';
        }),
      '[effective] seat b: effective verdict NEEDS-WORK should be SHIP-WITH-FIXES',
    ],
    [
      'a majority override with no user in the loop (headless: a ruling)',
      null,
      (s) =>
        placeholderDoc(s.summary, { outcome: 'refuted', verdict: 'SHIP-WITH-FIXES', approve: false }),
      'with no user in the loop (headless) that is a ruling',
    ],
    // Round 1 row 2: needs_ruling true does not make a refuted majority row a ruling.
    [
      'a refuted majority override with needs_ruling true',
      null,
      (s) => placeholderDoc(s.summary, { outcome: 'refuted', verdict: 'SHIP-WITH-FIXES', approve: false, needsRuling: true }),
      'its outcome must be "ruling"',
    ],
  ];

  it.each(CASES)('rejects %s twice and holds the round', async (_what, variant, docOf, expected) => {
    const s = await settledRound(variant === 'high-only' ? HIGH_ONLY : ROSTER_TOML);
    if (variant === 'high-only') expect(s.summary.rule).toBe('high-only');
    if (variant === 'asks') {
      s.h.store.db
        .prepare("UPDATE events SET detail_json = json_set(detail_json, '$.human_asks', json(?)) WHERE round_id = ? AND kind = 'round-prepared'")
        .run(JSON.stringify(['Please add a test for the end index.']), s.roundId);
    }
    const { env } = adjHome([{ output: docOf(s) }]);
    const r = await headless(s, env);
    expect(r.outcome).toBe('needs-ruling');
    expect(r.launches.map((l) => l.validation?.ok)).toEqual([false, false]);
    expect(r.launches[1]!.validation!.errors.join('\n')).toContain(expected);
    expect(getRound(s.h.store.db, s.roundId)).toMatchObject({ status: 'awaiting-adjudication', needs_ruling: 1 });
  });

  it('the same majority override passes interactively (with a warning to show the user), so the rule is the headless one', async () => {
    const s = await settledRound();
    const text = JSON.stringify(adjudicationFromSummary(s.summary, { outcome: 'refuted', verdict: 'SHIP-WITH-FIXES', approve: false }));
    const r = adjudicate(s.h.store, s.h.layout, s.roundId, text, { check: true });
    expect(r.outcome.ok).toBe(true);
    const h = adjudicate(s.h.store, s.h.layout, s.roundId, text, { check: true, headless: true });
    expect(h.outcome.ok).toBe(false);
    // With needs_ruling true (round 1 row 2): still rejected headless, still accepted interactively with its proof.
    const held = JSON.stringify(adjudicationFromSummary(s.summary, { outcome: 'refuted', verdict: 'SHIP-WITH-FIXES', approve: false, needsRuling: true }));
    expect(adjudicate(s.h.store, s.h.layout, s.roundId, held, { check: true, headless: true }).outcome.ok).toBe(false);
    const interactive = adjudicate(s.h.store, s.h.layout, s.roundId, held, { check: true });
    expect(interactive.outcome.ok).toBe(true);
    if (interactive.outcome.ok) expect(interactive.outcome.warnings.join('\n')).toContain('show the user the proof');
  });
});

describe('adjudicate <id> --headless (the CLI)', () => {
  const REGISTRY = fakeRegistry({
    codex: [{ id: 'gpt-6.1-sol', family: 'openai' }],
    claude: [
      { id: 'claude-sonnet-5-5', family: 'anthropic' },
      { id: 'claude-haiku-5-5', family: 'anthropic' },
      { id: 'claude-opus-5-5', family: 'anthropic' },
    ],
  });

  async function cli(s: Settled, env: NodeJS.ProcessEnv, adjudicator: string, ...args: string[]): Promise<{ code: number; lines: string[] }> {
    const configPath = join(scratch('sc-adj-cli-'), 'config.toml');
    writeFileSync(configPath, `${ROSTER_TOML}\n${adjudicator}`);
    const paths: StorePaths = { configPath, dbPath: s.h.layout.dbPath, rootsPath: s.h.layout.rootsDir };
    const lines: string[] = [];
    let code = 0;
    const io: ProgramIo = { write: (l) => lines.push(l), env, setExitCode: (c) => (code = c), registry: REGISTRY, claudeBin: FAKE, headlessPollMs: 10 };
    await buildProgram(io).exitOverride().parseAsync(['node', 'sc', 'adjudicate', ...args, '--config', paths.configPath, '--db', paths.dbPath, '--roots', paths.rootsPath]);
    return { code, lines };
  }

  it('adjudicates with [adjudicator] model and effort, prints the launch and the stored verdict, exit 0', async () => {
    const s = await settledRound();
    const { home, env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const r = await cli(s, env, '[adjudicator]\nmodel = "claude-opus-5-5"\neffort = "max"\n', String(s.roundId), '--headless');
    expect(r.code).toBe(0);
    expect(r.lines.filter((l) => !l.startsWith('warn'))[0]).toBe(`round ${s.roundId}: adjudicated: adjudicated`);
    expect(r.lines.join('\n')).toContain('launch 1: PASS, model claude-opus-5-5, effort max');
    expect(r.lines.join('\n')).toContain(`stored: round ${s.roundId} verdict NEEDS-WORK, owed 1, approve no, needs ruling no`);
    const argv = JSON.parse(readFileSync(join(home, 'argv-1.json'), 'utf8')) as { args: string[] };
    expect(argv.args[argv.args.indexOf('--effort') + 1]).toBe('max');
    expect(argv.args[argv.args.indexOf('--max-turns') + 1]).toBe('40');
  });

  it('exits 4 when the round is held for a ruling, and prints JSON with --json', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ output: placeholderDoc(s.summary, { outcome: 'follow-up', verdict: 'NEEDS-WORK', approve: false }) }]);
    const r = await cli(s, env, '[adjudicator]\nmodel = "claude-opus-5-5"\n', String(s.roundId), '--headless', '--json');
    expect(r.code).toBe(4);
    const out = JSON.parse(r.lines.join('\n')) as Json & { launches: Json[] };
    expect(out).toMatchObject({ round_id: s.roundId, outcome: 'needs-ruling', adjudication: null });
    expect(out.launches.map((l) => l['status'])).toEqual(['PASS', 'PASS']);
  });

  it('refuses without [adjudicator] model, with a file, or with --check', async () => {
    const s = await settledRound();
    const { env } = adjHome([{ output: placeholderDoc(s.summary) }]);
    const none = await cli(s, env, '', String(s.roundId), '--headless');
    expect(none.code).toBe(1);
    expect(none.lines.join('\n')).toContain('[adjudicator] model is not set');
    const file = await cli(s, env, '[adjudicator]\nmodel = "claude-opus-5-5"\n', String(s.roundId), 'x.json', '--headless');
    expect(file.lines.join('\n')).toContain('--headless takes no file and no --check');
    const check = await cli(s, env, '[adjudicator]\nmodel = "claude-opus-5-5"\n', String(s.roundId), '--headless', '--check');
    expect(check.code).toBe(1);
    const neither = await cli(s, env, '', String(s.roundId));
    expect(neither.lines.join('\n')).toContain('give the ADJUDICATION.json file, or --headless');
    expect(readdirSync(join(s.h.layout.roundsDir, String(s.roundId))).includes('adjudicator')).toBe(false);
  });
});
