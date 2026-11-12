import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatPath, loadConfig, parseConfigText, type ConfigIssue, type ValidationResult } from '../src/config/index.js';
import { fakeRegistry, FAKE_MODELS } from './fake-registry.js';

const PLAN_EXAMPLE = readFileSync(new URL('./fixtures/config/plan-example.toml', import.meta.url), 'utf8');

interface SeatSpec {
  id: string;
  backend: string;
  model: string;
  effort?: string;
  fallback?: string;
}

function seat(spec: SeatSpec): string {
  const lines = ['[[seats]]', `id = "${spec.id}"`, `backend = "${spec.backend}"`, `model = "${spec.model}"`];
  if (spec.effort) lines.push(`effort = "${spec.effort}"`);
  if (spec.fallback) lines.push(`fallback = ${spec.fallback}`);
  return `${lines.join('\n')}\n`;
}

const A: SeatSpec = { id: 'a', backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
const B: SeatSpec = { id: 'b', backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' };
const C: SeatSpec = { id: 'c', backend: 'grok', model: 'grok-4.7', effort: 'high' };
const D: SeatSpec = { id: 'd', backend: 'antigravity', model: 'gemini-3.8-pro' };

function toml(...parts: string[]): string {
  return parts.join('\n');
}

function errorsOf(result: ValidationResult): ConfigIssue[] {
  if (result.ok) throw new Error(`expected the config to be rejected, got ${JSON.stringify(result.config)}`);
  return result.errors;
}

function okOf(result: ValidationResult) {
  if (!result.ok) throw new Error(`expected the config to load, got ${JSON.stringify(result.errors)}`);
  return result;
}

describe('config: valid documents', () => {
  it('parses the plan section 5.2 example (3 seats) with every table typed', async () => {
    const result = okOf(await parseConfigText(PLAN_EXAMPLE, { registry: fakeRegistry() }));
    const { config } = result;
    expect(config.seats.map((s) => [s.id, s.backend, s.model, s.effort])).toEqual([
      ['a', 'codex', 'gpt-6.1-sol', 'high'],
      ['b', 'claude', 'claude-sonnet-5-5', 'high'],
      ['c', 'grok', 'grok-4.7', 'high'],
    ]);
    expect(config.seats[0]?.fallback).toEqual({ backend: 'kiro', model: 'gpt-5.6-sol', effort: 'high', on: ['usage_limit', 'auth'] });
    expect(config.council).toEqual({ leg_timeout_minutes: 25, untrusted_seat_policy: 'fallback', high_only_from_round: 4 });
    expect(config.adjudicator).toEqual({ model: 'claude-opus-5-5', max_turns: 40, timeout_minutes: 15 });
    expect(config.github).toEqual({ login: 'your-login', council_logins: [], markers_also_count: [] });
    expect(config.auto).toEqual({
      interval_minutes: 5,
      repos_allow: ['your-org/*'],
      repos_skip: [],
      repos_hold: ['your-org/infra-*'],
      include_assigned: false,
      approve: true,
      ci_gate: 'required-checks',
      max_rounds_per_day: 30,
      identity_approval: true,
      tests: { 'your-org/api': { setup: 'npm ci', command: 'npm test', timeout_minutes: 15 } },
    });
    expect(config.pr).toEqual({ interactive_adjudication: 'trusted-only' });
    expect(config.followups).toEqual({ hook: '~/bin/file-followups' });
    expect(config.notify).toEqual({ command: '~/bin/notify' });
    expect(result.modelsChecked).toBe(true);
  });

  it('fills every default from a seats-only document', async () => {
    const { config, modelsChecked, warnings } = okOf(await parseConfigText(toml(seat(A), seat(C), seat(D))));
    expect(config.council).toEqual({ leg_timeout_minutes: 25, untrusted_seat_policy: 'fallback', high_only_from_round: 4 });
    expect(config.adjudicator).toEqual({ max_turns: 40, timeout_minutes: 15 });
    expect(config.pr).toEqual({ interactive_adjudication: 'trusted-only' });
    expect(config.followups).toEqual({});
    expect(config.notify).toEqual({});
    expect(config.github).toBeUndefined();
    expect(config.auto).toBeUndefined();
    expect(modelsChecked).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('gives an [auto] table its plan defaults', async () => {
    const { config } = okOf(await parseConfigText(toml(seat(A), seat(C), seat(D), '[auto]\nrepos_allow = ["org/*"]\n')));
    expect(config.auto).toMatchObject({
      interval_minutes: 5,
      include_assigned: false,
      approve: true,
      ci_gate: 'required-checks',
      max_rounds_per_day: 30,
      identity_approval: true,
      tests: {},
    });
  });

  it('raises no warning for three seats from three families, none the adjudicator family', async () => {
    const result = okOf(await parseConfigText(toml(seat(A), seat(C), seat(D)), { registry: fakeRegistry() }));
    expect(result.warnings).toEqual([]);
  });
});

describe('config: seat count is fixed at 3', () => {
  it('rejects 2 seats', async () => {
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat(B))));
    expect(errors).toEqual([{ path: 'seats', message: 'exactly 3 seats are required (D10); found 2' }]);
  });

  it('rejects 4 seats', async () => {
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat(B), seat(C), seat(D))));
    expect(errors).toEqual([{ path: 'seats', message: 'exactly 3 seats are required (D10); found 4' }]);
  });

  it('rejects a document with no seats', async () => {
    const errors = errorsOf(await parseConfigText('[council]\nleg_timeout_minutes = 10\n'));
    expect(errors.map((e) => e.path)).toEqual(['seats']);
  });
});

describe('config: backends', () => {
  it('rejects an unknown backend', async () => {
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat({ ...B, backend: 'gemini' }), seat(C))));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('seats[1].backend');
    expect(errors[0]?.message).toMatch(/^unknown backend; expected one of: codex, claude, grok, antigravity, kiro, opencode, cursor, muse$/);
  });

  it('rejects an unknown fallback backend', async () => {
    const fallback = '{ backend = "gemini", model = "x", on = ["auth"] }';
    const errors = errorsOf(await parseConfigText(toml(seat({ ...A, fallback }), seat(B), seat(C))));
    expect(errors.map((e) => e.path)).toEqual(['seats[0].fallback.backend']);
  });

  it('accepts each of the eight backends', async () => {
    for (const backend of ['codex', 'claude', 'grok', 'antigravity', 'kiro', 'opencode', 'cursor', 'muse']) {
      okOf(await parseConfigText(toml(seat({ ...A, backend }), seat(B), seat(C))));
    }
  });
});

describe('config: seat ids', () => {
  it('rejects duplicate ids', async () => {
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat(B), seat({ ...C, id: 'a' }))));
    expect(errors).toEqual([{ path: 'seats[2].id', message: 'duplicate seat id "a" (also seats[0].id)' }]);
  });

  it('rejects an id that cannot name a seat', async () => {
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat(B), seat({ ...C, id: 'C/../x' }))));
    expect(errors.map((e) => e.path)).toEqual(['seats[2].id']);
  });
});

describe('config: fallbacks', () => {
  it('rejects a fallback that is the same occupant as its primary', async () => {
    const fallback = '{ backend = "codex", model = "gpt-6.1-sol", effort = "high", on = ["usage_limit"] }';
    const errors = errorsOf(await parseConfigText(toml(seat({ ...A, fallback }), seat(B), seat(C))));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('seats[0].fallback');
    expect(errors[0]?.message).toMatch(/same occupant as seat "a"/);
  });

  it('rejects a fallback equal to a primary that sets no effort', async () => {
    const fallback = '{ backend = "antigravity", model = "gemini-3.8-pro", on = ["auth"] }';
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat(B), seat({ ...D, fallback }))));
    expect(errors.map((e) => e.path)).toEqual(['seats[2].fallback']);
  });

  it('accepts a fallback that differs in backend, model or effort only', async () => {
    for (const fallback of [
      '{ backend = "kiro", model = "gpt-6.1-sol", effort = "high", on = ["auth"] }',
      '{ backend = "codex", model = "gpt-5.6-sol", effort = "high", on = ["auth"] }',
      '{ backend = "codex", model = "gpt-6.1-sol", effort = "medium", on = ["auth"] }',
      '{ backend = "codex", model = "gpt-6.1-sol", on = ["auth"] }',
    ]) {
      okOf(await parseConfigText(toml(seat({ ...A, fallback }), seat(B), seat(C))));
    }
  });

  it('rejects an unknown failure class and an empty on list', async () => {
    const bad = '{ backend = "kiro", model = "gpt-5.6-sol", on = ["rate_limit"] }';
    const empty = '{ backend = "kiro", model = "gpt-5.6-sol", on = [] }';
    expect(errorsOf(await parseConfigText(toml(seat({ ...A, fallback: bad }), seat(B), seat(C)))).map((e) => e.path)).toEqual([
      'seats[0].fallback.on[0]',
    ]);
    expect(errorsOf(await parseConfigText(toml(seat({ ...A, fallback: empty }), seat(B), seat(C)))).map((e) => e.path)).toEqual([
      'seats[0].fallback.on',
    ]);
  });
});

describe('config: quorum is not configurable', () => {
  const message = 'quorum is fixed at 2 and is not configurable (D10)';

  it('rejects a quorum key in [council], once, with the reason', async () => {
    const errors = errorsOf(await parseConfigText(toml('[council]\nquorum = 3\n', seat(A), seat(B), seat(C))));
    expect(errors).toEqual([{ path: 'council.quorum', message }]);
  });

  it('rejects a top-level quorum key', async () => {
    const errors = errorsOf(await parseConfigText(toml('quorum = 1\n', seat(A), seat(B), seat(C))));
    expect(errors).toEqual([{ path: 'quorum', message }]);
  });

  it('still reports other errors next to the quorum key', async () => {
    const errors = errorsOf(await parseConfigText(toml('[council]\nquorum = 3\n', seat(A), seat(B))));
    expect(errors.map((e) => e.path)).toEqual(['council.quorum', 'seats']);
  });
});

describe('config: family warnings', () => {
  it('warns when two seats share a model family, and still loads', async () => {
    const result = okOf(
      await parseConfigText(toml(seat(A), seat({ ...C, backend: 'kiro', model: 'gpt-5.6-sol' }), seat(D)), { registry: fakeRegistry() }),
    );
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.path).toBe('seats');
    expect(result.warnings[0]?.message).toMatch(/^seats "a" and "c" share the openai model family/);
  });

  it("warns when a seat shares the adjudicator's family", async () => {
    const result = okOf(await parseConfigText(toml(seat(A), seat(B), seat(C)), { registry: fakeRegistry() }));
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.path).toBe('seats[1].model');
    expect(result.warnings[0]?.message).toMatch(/^seat "b" shares the adjudicator's model family \(anthropic\)/);
  });

  it('takes the family from the model, not the backend (a Claude model served by kiro)', async () => {
    const result = okOf(
      await parseConfigText(toml(seat(A), seat({ ...B, backend: 'kiro', model: 'claude-sonnet-5.5' }), seat(C)), { registry: fakeRegistry() }),
    );
    expect(result.warnings.map((w) => w.path)).toEqual(['seats[1].model']);
  });
});

describe('config: model ids through the adapter registry', () => {
  it('rejects a model the backend does not offer, on a primary, a fallback and the adjudicator', async () => {
    const fallback = '{ backend = "kiro", model = "gpt-9", on = ["auth"] }';
    const text = toml(seat({ ...A, model: 'gpt-0', fallback }), seat(C), seat(D), '[adjudicator]\nmodel = "claude-nope"\n');
    const errors = errorsOf(await parseConfigText(text, { registry: fakeRegistry() }));
    expect(errors).toEqual([
      { path: 'seats[0].model', message: 'backend "codex" does not offer model "gpt-0"' },
      { path: 'seats[0].fallback.model', message: 'backend "kiro" does not offer model "gpt-9"' },
      { path: 'adjudicator.model', message: 'backend "claude" does not offer model "claude-nope"' },
    ]);
  });

  it('rejects a backend with no registered adapter', async () => {
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat({ ...C, backend: 'muse', model: 'm' }), seat(D)), { registry: fakeRegistry() }));
    expect(errors).toEqual([{ path: 'seats[1].backend', message: 'no adapter is registered for backend "muse"' }]);
  });

  it('reports a lister that fails, and reads each backend once', async () => {
    const registry = fakeRegistry({ ...FAKE_MODELS, codex: new Error('codex not on PATH') });
    const fallback = '{ backend = "codex", model = "gpt-5.6-sol", on = ["auth"] }';
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat({ ...C, fallback }), seat(D)), { registry }));
    expect(errors).toEqual([
      { path: 'seats[0].model', message: 'could not list the models of backend "codex": codex not on PATH' },
      { path: 'seats[1].fallback.model', message: 'could not list the models of backend "codex": codex not on PATH' },
    ]);
    expect(registry.calls.get('codex')).toBe(1);
  });

  it('does not check model ids without a registry', async () => {
    const result = okOf(await parseConfigText(toml(seat({ ...A, model: 'gpt-0' }), seat(C), seat(D))));
    expect(result.modelsChecked).toBe(false);
  });
});

describe('config: strict tables and value checks', () => {
  it('rejects an unknown key with its path', async () => {
    const errors = errorsOf(await parseConfigText(toml('[council]\nleg_timout_minutes = 10\n', seat(A), seat(B), seat(C))));
    expect(errors).toEqual([{ path: 'council.leg_timout_minutes', message: 'unknown key' }]);
  });

  it('rejects out-of-range and wrongly typed values', async () => {
    const text = toml(
      '[council]\nleg_timeout_minutes = 0\nuntrusted_seat_policy = "maybe"\nhigh_only_from_round = 2.5\n',
      seat(A),
      seat(B),
      seat(C),
      '[auto]\nci_gate = "some"\napprove = "yes"\nrepos_allow = ["no-slash"]\n',
      '[pr]\ninteractive_adjudication = "always"\n',
    );
    const paths = errorsOf(await parseConfigText(text)).map((e) => e.path);
    expect(paths.sort()).toEqual(
      [
        'council.leg_timeout_minutes',
        'council.untrusted_seat_policy',
        'council.high_only_from_round',
        'auto.ci_gate',
        'auto.approve',
        'auto.repos_allow[0]',
        'pr.interactive_adjudication',
      ].sort(),
    );
  });

  it('requires an exact repo name in the per-repo tests table', async () => {
    const text = toml(seat(A), seat(B), seat(C), '[auto.tests."org/*"]\ncommand = "npm test"\n');
    const errors = errorsOf(await parseConfigText(text));
    expect(errors).toEqual([{ path: 'auto.tests."org/*"', message: 'expected an exact "owner/repo" (no wildcards)' }]);
  });

  it('requires github.login when [github] is present', async () => {
    const errors = errorsOf(await parseConfigText(toml(seat(A), seat(B), seat(C), '[github]\ncouncil_logins = ["x"]\n')));
    expect(errors.map((e) => e.path)).toEqual(['github.login']);
  });

  it('reports a TOML syntax error with its position', async () => {
    const errors = errorsOf(await parseConfigText('[council\nleg_timeout_minutes = 1\n'));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('');
    expect(errors[0]?.message).toMatch(/^TOML syntax error at line 1, column \d+: /);
  });

  it('formats key paths', () => {
    expect(formatPath(['seats', 1, 'fallback', 'on', 0])).toBe('seats[1].fallback.on[0]');
    expect(formatPath(['auto', 'tests', 'org/api', 'command'])).toBe('auto.tests."org/api".command');
    expect(formatPath([])).toBe('');
  });
});

describe('config: loading from a file', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('loads the file at the given path', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sc-config-'));
    const path = join(dir, 'config.toml');
    writeFileSync(path, PLAN_EXAMPLE);
    const result = await loadConfig(path);
    expect(result.path).toBe(path);
    expect(result.ok).toBe(true);
  });

  it('reports a missing file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'sc-config-'));
    const path = join(dir, 'absent.toml');
    const result = await loadConfig(path);
    expect(result.ok).toBe(false);
    expect(errorsOf(result)).toEqual([{ path: '', message: `no config file at ${path}` }]);
  });
});
