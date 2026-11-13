import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClaudeAdapter } from '../../src/adapters/claude/index.js';
import { createCodexAdapter } from '../../src/adapters/codex/index.js';
import type { SeatAdapters } from '../../src/adapters/index.js';
import { parseConfigText, type CouncilConfig } from '../../src/config/index.js';
import { prepareRound, runLegs, type DataLayout, type PreparedRound, type ResolvedTarget, type RunOptions, type RunResult } from '../../src/engine/index.js';
import { openStore, type Store } from '../../src/store/index.js';
import { fixtureDir, scratch } from './fixtures.js';
import { commitAll, git, initRepo, writeTree } from './git-fixture.js';

/*
 * The fake-CLI round harness (P5): a git repository, a fake HOME holding the fake codex and claude configs, the
 * real codex and claude adapters pointed at the fake binaries, and a store and data layout under a temp dir.
 */

export const FAKE_CLAUDE = new URL('../fixtures/bin/fake-claude.mjs', import.meta.url).pathname;
export const FAKE_CODEX = new URL('../fixtures/bin/fake-codex.mjs', import.meta.url).pathname;

export const fakeAdapters: SeatAdapters = (backend) =>
  backend === 'claude' ? createClaudeAdapter({ bin: FAKE_CLAUDE }) : backend === 'codex' ? createCodexAdapter({ bin: FAKE_CODEX }) : undefined;

/** The roster every fake round uses: codex on a, two claude models on b and c, a claude fallback for a. */
export const ROSTER_TOML = `
[council]
leg_timeout_minutes = 1

[[seats]]
id = "a"
backend = "codex"
model = "gpt-6.1-sol"
effort = "low"
fallback = { backend = "claude", model = "claude-sonnet-5-5", effort = "low", on = ["usage_limit", "auth"] }

[[seats]]
id = "b"
backend = "claude"
model = "claude-haiku-5-5"
effort = "low"

[[seats]]
id = "c"
backend = "claude"
model = "claude-opus-5-5"
effort = "low"
`;

export const OCC = {
  a: 'gpt-6.1-sol/low',
  aFallback: 'claude-sonnet-5-5/low',
  b: 'claude-haiku-5-5/low',
  c: 'claude-opus-5-5/low',
} as const;

export async function rosterConfig(toml = ROSTER_TOML): Promise<CouncilConfig> {
  const r = await parseConfigText(toml);
  if (!r.ok) throw new Error(`bad test config: ${JSON.stringify(r.errors)}`);
  return r.config;
}

export interface FakeCases {
  /** Per fake-claude occupant key (`model/effort`): the cases, one per launch. */
  claude?: Record<string, Array<Record<string, unknown>>>;
  codex?: Record<string, Array<Record<string, unknown>>>;
  /** Top-level fake-codex keys (preflight behaviour: loggedIn, models). */
  codexTop?: Record<string, unknown>;
  claudeTop?: Record<string, unknown>;
}

export const claudeCase = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ fixture: fixtureDir('claude', name), replay: true, ...extra });
export const codexCase = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ fixture: fixtureDir('codex', name), replay: true, ...extra });

/** Every seat succeeds by default; `cases` replaces an occupant's launches. */
export function defaultCases(cases: FakeCases = {}): FakeCases {
  return {
    claude: { [OCC.aFallback]: [claudeCase('success')], [OCC.b]: [claudeCase('success')], [OCC.c]: [claudeCase('success')], ...cases.claude },
    codex: { [OCC.a]: [codexCase('success')], ...cases.codex },
    codexTop: cases.codexTop,
    claudeTop: cases.claudeTop,
  };
}

/** A fake HOME for the legs: both fake CLIs read their config from it. */
export function fakeHome(cases: FakeCases): { home: string; env: NodeJS.ProcessEnv } {
  const home = scratch('sc-round-home-');
  const c = defaultCases(cases);
  writeFileSync(join(home, 'fake-claude.json'), JSON.stringify({ fixture: fixtureDir('claude', 'success'), byOccupant: c.claude, ...c.claudeTop }));
  writeFileSync(
    join(home, 'fake-codex.json'),
    JSON.stringify({ promptInput: join(fixtureDir('codex', 'prompt-input'), 'clean.json'), mcp: [], fixture: fixtureDir('codex', 'success'), byOccupant: c.codex, ...c.codexTop }),
  );
  mkdirSync(join(home, '.codex'));
  return { home, env: { PATH: process.env['PATH'], HOME: home, CODEX_HOME: join(home, '.codex') } };
}

/** A repository with a plan and a small module: `main` at the base, `feature` one commit ahead. */
export function fixtureRepo(): { repo: string; base: string; head: string } {
  const repo = initRepo(join(scratch('sc-round-repo-'), 'widget'));
  writeTree(repo, {
    'docs/PLAN.md': '# Plan\n\n1. Sum a range, inclusive of both ends.\n',
    'calc/rangesum.py': 'def range_sum(values, start, end):\n    total = 0\n    for i in range(start, end + 1):\n        total += values[i]\n    return total\n',
  });
  const base = commitAll(repo, 'calc: range sum');
  git(repo, ['checkout', '--quiet', '-b', 'feature']);
  writeTree(repo, { 'calc/rangesum.py': 'def range_sum(values, start, end):\n    total = 0\n    for i in range(start, end):\n        total += values[i]\n    return total\n' });
  const head = commitAll(repo, 'calc: tidy the range loop');
  return { repo, base, head };
}

/** One more commit on the checked-out branch. */
export function commitChange(repo: string, path: string, content: string, message: string): string {
  writeTree(repo, { [path]: content });
  return commitAll(repo, message);
}

export interface Harness {
  store: Store;
  layout: DataLayout;
  dir: string;
}

export function harness(): Harness {
  const dir = scratch('sc-round-data-');
  const store = openStore(join(dir, 'data', 'council.db'));
  return { store, dir, layout: { dbPath: join(dir, 'data', 'council.db'), roundsDir: join(dir, 'data', 'rounds'), rootsDir: join(dir, 'roots') } };
}

export interface RoundRun {
  prepared: PreparedRound;
  result: RunResult;
}

/** Prepares and runs one round through the fake CLIs. */
export async function runRound(
  h: Harness,
  target: ResolvedTarget,
  cases: FakeCases = {},
  options: Partial<RunOptions> & { config?: CouncilConfig } = {},
): Promise<RoundRun> {
  const config = options.config ?? (await rosterConfig());
  const prepared = prepareRound(h.store, { config, configPath: '/dev/null', layout: h.layout, target });
  const { env } = fakeHome(cases);
  const result = await runLegs(h.store, prepared.roundDir, { adapters: fakeAdapters, env, pollMs: 20, legTimeoutMs: 20_000, ...options });
  return { prepared, result };
}
