import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adjudicate, findingIdOf } from '../src/adjudicate/index.js';
import {
  getEvents,
  getLegs,
  getRound,
  nextStep,
  prepareRound,
  quorumOf,
  readRoundInputs,
  removeOwnedRoot,
  residueSuspects,
  resolveDiffTarget,
  resolvePlanTarget,
  rootName,
  rootPathOf,
  roundSummary,
  runWorker,
} from '../src/engine/index.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { git } from './helpers/git-fixture.js';
import { openStore } from '../src/store/index.js';
import { claudeCase, codexCase, commitChange, fakeAdapters, fakeHome, fixtureRepo, harness, OCC, rosterConfig, runRound, type Harness } from './helpers/round.js';

cleanScratchAfterAll();

/** A valid adjudication for a round, built from what the store recorded, with per-test edits. */
function adjudicationFor(h: Harness, roundId: number, edit: (a: Record<string, unknown>, ctx: AdjCtx) => void = () => undefined): string {
  const round = getRound(h.store.db, roundId)!;
  const inputs = readRoundInputs(join(h.layout.roundsDir, String(roundId)));
  const legs = getLegs(h.store.db, roundId).filter((l) => l.status === 'PASS');
  const summary = roundSummary(h.store, h.layout, roundId);
  const findings: Array<Record<string, unknown>> = [];
  const unmapped: Array<Record<string, unknown>> = [];
  // Every leg's parsed findings map onto one canonical finding per title; a leg that needs extraction gets X1.
  const title = 'range_sum excludes the end index';
  const path = `${inputs.repoName}/calc/rangesum.py`;
  const id = findingIdOf(inputs.targetKey, path, title);
  const raisedBy: Array<Record<string, unknown>> = [];
  for (const leg of summary.legs.filter((l) => l.counted)) {
    if (leg.findings_extracted_by === 'adjudicator-needed') raisedBy.push({ seat: leg.seat, leg_finding: 'X1', severity: 'MEDIUM' });
    else for (const f of leg.findings) raisedBy.push({ seat: leg.seat, leg_finding: f.id, severity: f.severity });
  }
  findings.push({ id, title, path, line: 11, severity: 'HIGH', outcome: 'owed', owner: 'this', proof: 'calc/rangesum.py:3 range(start, end) drops values[end]', kind: 'finding', raised_by: raisedBy, same_as: null, closes_item: null });
  const a: Record<string, unknown> = {
    nonce: round.nonce,
    head_sha: round.head_sha,
    round: round.round_no,
    verdict: 'NEEDS-WORK',
    approve: false,
    needs_ruling: false,
    reason: 'the loop drops the end element',
    findings,
    unmapped,
    earlier_items: inputs.earlierItems.filter((i) => !i.closedContext).map((i) => ({ source: i.id, status: 'closed', evidence: 'fixed', fix_row: null })),
    human_asks: [],
    leg_verdicts: legs.map((l) => ({ seat: l.seat_id, raw: l.verdict_raw, effective: l.verdict_raw })),
    not_verified: [],
    followups: [],
    summary: 'One owed defect.',
    blocker_call: 'Fix the loop bound.',
  };
  edit(a, { id, path, title, inputs });
  return JSON.stringify(a);
}

interface AdjCtx {
  id: string;
  path: string;
  title: string;
  inputs: ReturnType<typeof readRoundInputs>;
}

describe('round runner: plan 4.4 decisions', () => {
  const base = { role: 'primary' as const, attempt: 1, fallback: { backend: 'claude' as const, model: 'm', on: ['usage_limit' as const, 'auth' as const] }, timeLeftMs: 10_000, minLegMs: 100, rootClean: true };
  it.each([
    ['usage_limit', 'fallback'],
    ['auth', 'fallback'],
    ['capacity', 'relaunch'],
    ['transport', 'relaunch'],
    ['empty', 'relaunch'],
    ['timeout', 'relaunch'],
    ['model', 'out'],
    ['contaminated', 'out'],
    ['setup', 'out'],
  ] as const)('%s on a primary first attempt -> %s', (cls, kind) => {
    expect(nextStep({ ...base, failureClass: cls }).kind).toBe(kind);
  });
  it('relaunches only once, never into a changed root, and only with time left', () => {
    expect(nextStep({ ...base, failureClass: 'capacity', attempt: 2 }).kind).toBe('out');
    expect(nextStep({ ...base, failureClass: 'capacity', rootClean: false }).kind).toBe('out');
    expect(nextStep({ ...base, failureClass: 'timeout', timeLeftMs: 50 }).kind).toBe('out');
  });
  it('falls back only from a primary, and only on a class the fallback lists', () => {
    expect(nextStep({ ...base, failureClass: 'usage_limit', role: 'fallback' }).kind).toBe('out');
    expect(nextStep({ ...base, failureClass: 'auth', fallback: { ...base.fallback, on: ['usage_limit'] } }).kind).toBe('out');
    expect(nextStep({ ...base, failureClass: 'usage_limit', fallback: undefined }).kind).toBe('out');
  });
  it('labels quorum: 2+ council, 1 solo, 0 none', () => {
    expect([quorumOf(3), quorumOf(2), quorumOf(1), quorumOf(0)]).toEqual(['council', 'council', 'solo', 'none']);
  });
});

describe('round runner end to end through the fake CLIs', () => {
  it('runs a council round of three legs and records everything, then stores the adjudication and reads it back', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(result).toMatchObject({ status: 'awaiting-adjudication', quorum: 'council', ratified: 3 });
    const legs = getLegs(h.store.db, prepared.inputs.roundId);
    expect(legs.map((l) => [l.seat_id, l.role, l.attempt, l.status, l.verdict_raw])).toEqual([
      ['a', 'primary', 1, 'PASS', 'SHIP-WITH-FIXES'],
      ['b', 'primary', 1, 'PASS', 'NEEDS-WORK'],
      ['c', 'primary', 1, 'PASS', 'NEEDS-WORK'],
    ]);
    // Ratification fields from each CLI's own record.
    for (const l of legs) {
      expect(l.cwd_ok).toBe(1);
      expect(l.nonce_seen).toBe(1);
      expect(l.root_mutated).toBe(0);
      expect(l.model_observed).toContain(l.model);
    }
    expect(legs.find((l) => l.seat_id === 'b')?.cost_usd).toBeGreaterThan(0);
    expect(legs.find((l) => l.seat_id === 'a')?.enforcement_label).toBe('sandboxed-exec');
    // The claude legs' findings blocks are stored as leg findings; codex wrote none, so the adjudicator extracts.
    const lf = h.store.db.prepare('SELECT leg_id, local_id, severity, extracted_by FROM leg_findings ORDER BY leg_id').all();
    expect(lf.map((r) => ({ ...r }))).toEqual([
      { leg_id: legs[1]!.id, local_id: 'F1', severity: 'HIGH', extracted_by: 'leg' },
      { leg_id: legs[2]!.id, local_id: 'F1', severity: 'HIGH', extracted_by: 'leg' },
    ]);
    const summary = roundSummary(h.store, h.layout, prepared.inputs.roundId);
    expect(summary.quorum).toMatchObject({ label: 'council', ratified: 3 });
    expect(summary.legs.find((l) => l.seat === 'a')?.findings_extracted_by).toBe('adjudicator-needed');
    expect(readFileSync(summary.legs[1]!.answer_path!, 'utf8')).toMatch(/^NONCE: [0-9a-f]{12}/);
    expect(summary.round_no).toBe(1);
    expect(summary.scope).toBe('full');

    const r = adjudicate(h.store, h.layout, prepared.inputs.roundId, adjudicationFor(h, prepared.inputs.roundId));
    expect(r.outcome.ok, JSON.stringify(r.outcome)).toBe(true);
    const round = getRound(h.store.db, prepared.inputs.roundId)!;
    expect(round).toMatchObject({ status: 'adjudicated', verdict: 'NEEDS-WORK', owed_count: 1, approve: 0, needs_ruling: 0 });
    // Read back: the canonical finding, its three sources (one extracted from codex's prose), and every mapping.
    const sources = h.store.db.prepare('SELECT finding_id, leg_finding_id FROM finding_sources').all();
    expect(sources).toHaveLength(3);
    const mapped = h.store.db.prepare('SELECT local_id, extracted_by, mapped_finding_id FROM leg_findings ORDER BY id').all().map((x) => ({ ...x }));
    expect(mapped.map((m) => m['extracted_by'])).toEqual(['leg', 'leg', 'adjudicator']);
    expect(new Set(mapped.map((m) => m['mapped_finding_id'])).size).toBe(1);
    expect(getLegs(h.store.db, prepared.inputs.roundId).map((l) => l.verdict_effective)).toEqual(['SHIP-WITH-FIXES', 'NEEDS-WORK', 'NEEDS-WORK']);
    expect(existsSync(prepared.inputs.root)).toBe(false);
    expect(existsSync(join(prepared.roundDir, 'ADJUDICATION.json'))).toBe(true);
    expect(getEvents(h.store.db, prepared.inputs.roundId).map((e) => e.kind)).toEqual(['round-prepared', 'legs-settled', 'adjudicated']);
  }, 60_000);

  it.each([
    ['usage_limit', 'usage-limit'],
    ['auth', 'auth'],
  ])('moves a seat to its fallback within the round on %s', async (cls, fixture) => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), { codex: { [OCC.a]: [codexCase(fixture)] } });
    expect(result.quorum).toBe('council');
    const a = getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'a');
    expect(a.map((l) => [l.role, l.attempt, l.status, l.failure_class, l.backend, l.model])).toEqual([
      ['primary', 1, 'FAIL', cls, 'codex', 'gpt-6.1-sol'],
      ['fallback', 1, 'PASS', null, 'claude', 'claude-sonnet-5-5'],
    ]);
    expect(getEvents(h.store.db, prepared.inputs.roundId).find((e) => e.kind === 'fallback')?.detail).toMatchObject({ seat: 'a', failure_class: cls, preflight: false });
  }, 60_000);

  it('sends a primary that fails preflight straight to its fallback, recorded as PREFLIGHT_FAIL', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), { codexTop: { loggedIn: false } });
    const a = getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'a');
    expect(a.map((l) => [l.role, l.status, l.failure_class])).toEqual([
      ['primary', 'PREFLIGHT_FAIL', 'auth'],
      ['fallback', 'PASS', null],
    ]);
  }, 60_000);

  it('settles a quorum of 2 of 3 when one leg fails, and excludes a contaminated leg without relaunching it', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), {
      claude: { [OCC.c]: [claudeCase('contaminated-used'), claudeCase('success')] },
    });
    expect(result).toMatchObject({ quorum: 'council', ratified: 2 });
    const c = getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'c');
    expect(c.map((l) => [l.status, l.failure_class])).toEqual([['CONTAMINATED', 'contaminated']]);
    expect(h.store.db.prepare('SELECT count(*) AS n FROM leg_findings WHERE leg_id = ?').get(c[0]!.id)).toMatchObject({ n: 0 });
    expect(getEvents(h.store.db, prepared.inputs.roundId).find((e) => e.kind === 'seat-out')?.detail).toMatchObject({ seat: 'c', failure_class: 'contaminated' });
    const summary = roundSummary(h.store, h.layout, prepared.inputs.roundId);
    expect(summary.legs.find((l) => l.seat === 'c')).toMatchObject({ counted: false, status: 'CONTAMINATED' });
    // The excluded leg is not part of the adjudication: mapping its findings, or giving it a verdict, is rejected.
    const bad = adjudicate(h.store, h.layout, prepared.inputs.roundId, adjudicationFor(h, prepared.inputs.roundId, (a) => {
      (a['leg_verdicts'] as unknown[]).push({ seat: 'c', raw: 'NEEDS-WORK', effective: 'NEEDS-WORK' });
    }));
    expect(bad.outcome.ok).toBe(false);
    if (!bad.outcome.ok) expect(bad.outcome.errors.join('\n')).toContain('[effective] leg_verdicts lists seat c, which has no ratified leg');
  }, 60_000);

  it('counts a wrong-model leg out with no relaunch', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), { claude: { [OCC.c]: [claudeCase('model-not-found')] } });
    expect(result.ratified).toBe(2);
    expect(getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'c').map((l) => [l.status, l.failure_class])).toEqual([['FAIL', 'model']]);
  }, 60_000);

  it('labels a round with one ratified leg a solo review, which never approves', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), {
      claude: { [OCC.b]: [claudeCase('contaminated-used')], [OCC.c]: [claudeCase('model-not-found')] },
    });
    expect(result).toMatchObject({ status: 'awaiting-adjudication', quorum: 'solo', ratified: 1 });
    const summary = roundSummary(h.store, h.layout, prepared.inputs.roundId);
    expect(summary.quorum.label).toBe('solo');
    expect(summary.quorum.note).toContain('SOLO REVIEW');
    expect(summary.quorum.note).toContain('not a council verdict');
    const approve = adjudicate(h.store, h.layout, prepared.inputs.roundId, adjudicationFor(h, prepared.inputs.roundId, (a) => {
      a['findings'] = [];
      a['unmapped'] = [{ seat: 'a', leg_finding: 'X1', reason: 'restates the brief' }];
      a['verdict'] = 'SHIP';
      a['approve'] = true;
    }));
    expect(approve.outcome.ok).toBe(false);
    if (!approve.outcome.ok) expect(approve.outcome.errors).toContain('[approval] approve is true on a solo review: a solo review never approves (plan 3.1 step 8)');
    const ok = adjudicate(h.store, h.layout, prepared.inputs.roundId, adjudicationFor(h, prepared.inputs.roundId));
    expect(ok.outcome.ok).toBe(true);
  }, 60_000);

  it('fails a round with no ratified leg, and refuses to adjudicate it', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), {
      codex: { [OCC.a]: [codexCase('wrong-model')] },
      claude: { [OCC.b]: [claudeCase('contaminated-used')], [OCC.c]: [claudeCase('model-not-found')] },
    });
    expect(result).toMatchObject({ status: 'failed', quorum: 'none', ratified: 0 });
    expect(getRound(h.store.db, prepared.inputs.roundId)?.status).toBe('failed');
    expect(() => adjudicate(h.store, h.layout, prepared.inputs.roundId, '{}')).toThrow(/round \d+ is failed/);
  }, 60_000);

  it('kills a leg at its cap, relaunches it once while time remains, and counts the relaunch', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(
      h,
      resolveDiffTarget(repo, 'main..feature'),
      { codex: { [OCC.a]: [codexCase('success', { hang: true }), codexCase('success')] } },
      { legTimeoutMs: 3000, roundBudgetMs: 20_000 },
    );
    expect(result.ratified).toBe(3);
    const a = getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'a');
    expect(a.map((l) => [l.attempt, l.status, l.failure_class])).toEqual([
      [1, 'FAIL', 'timeout'],
      [2, 'PASS', null],
    ]);
    expect(getEvents(h.store.db, prepared.inputs.roundId).find((e) => e.kind === 'relaunch')?.detail).toMatchObject({ seat: 'a', attempt: 2, failure_class: 'timeout' });
  }, 60_000);

  it('a leg that times out again is out after one relaunch, and its process group is gone', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(
      h,
      resolveDiffTarget(repo, 'main..feature'),
      { codex: { [OCC.a]: [codexCase('success', { hang: true })] } },
      { legTimeoutMs: 1000, roundBudgetMs: 20_000 },
    );
    expect(result.ratified).toBe(2);
    const a = getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'a');
    expect(a.map((l) => [l.attempt, l.status, l.failure_class])).toEqual([
      [1, 'FAIL', 'timeout'],
      [2, 'FAIL', 'timeout'],
    ]);
    for (const l of a) {
      const record = JSON.parse(readFileSync(join(prepared.roundDir, 'legs', `a-primary-${l.attempt}`, 'process.json'), 'utf8')) as { exit: { timedOut: boolean } };
      expect(record.exit.timedOut).toBe(true);
    }
  }, 60_000);

  it('does not relaunch a timed-out leg when the round has no time left', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared } = await runRound(
      h,
      resolveDiffTarget(repo, 'main..feature'),
      { codex: { [OCC.a]: [codexCase('success', { hang: true }), codexCase('success')] } },
      { legTimeoutMs: 1500, roundBudgetMs: 1600 },
    );
    const a = getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'a');
    expect(a.map((l) => [l.attempt, l.failure_class])).toEqual([[1, 'timeout']]);
    expect(getEvents(h.store.db, prepared.inputs.roundId).find((e) => e.kind === 'seat-out')?.detail).toMatchObject({ seat: 'a', why: expect.stringContaining('no time remains') });
  }, 60_000);

  it('treats a ratified leg with no verdict and no findings as empty, and relaunches it once', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), {
      claude: { [OCC.b]: [claudeCase('success', { answer: 'NONCE: ${NONCE}\n\nI read the diff.\n' }), claudeCase('success')] },
    });
    expect(getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'b').map((l) => [l.attempt, l.status, l.failure_class, l.nonce_seen])).toEqual([
      [1, 'FAIL', 'empty', 1],
      [2, 'PASS', null, 1],
    ]);
  }, 60_000);

  it('relaunches once on capacity', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), { claude: { [OCC.b]: [claudeCase('overloaded'), claudeCase('success')] } });
    expect(getLegs(h.store.db, prepared.inputs.roundId).filter((l) => l.seat_id === 'b').map((l) => [l.attempt, l.status, l.failure_class])).toEqual([
      [1, 'FAIL', 'capacity'],
      [2, 'PASS', null],
    ]);
  }, 60_000);
});

describe('round numbering, delta rounds and round 4+ (plan 3.5, 3.6, D5)', () => {
  it('runs round 2 as a delta on FOLD.diff, carrying round 1 owed rows (not its follow-ups) as earlier items', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const r1 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    // Round 1: the claude legs' finding is owed; codex's extracted item is a separate follow-up, which is not carried.
    const r1ok = adjudicate(h.store, h.layout, r1.prepared.inputs.roundId, adjudicationFor(h, r1.prepared.inputs.roundId, (a, c) => {
      const owed = (a['findings'] as Array<Record<string, unknown>>)[0]!;
      const raised = owed['raised_by'] as Array<{ seat: string }>;
      owed['raised_by'] = raised.filter((r) => r.seat !== 'a');
      const title = 'range_sum has no test for an empty range';
      const id = findingIdOf(c.inputs.targetKey, c.path, title);
      (a['findings'] as unknown[]).push({ ...owed, id, title, severity: 'LOW', outcome: 'follow-up', raised_by: raised.filter((r) => r.seat === 'a') });
      a['followups'] = [id];
    }));
    expect(r1ok.outcome.ok, JSON.stringify(r1ok.outcome)).toBe(true);
    commitChange(repo, 'calc/rangesum.py', 'def range_sum(values, start, end):\n    return sum(values[start:end + 1])\n', 'calc: fix the bound');
    const r2 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    const i2 = r2.prepared.inputs;
    expect(i2).toMatchObject({ roundNo: 2, rule: 'serious', scope: 'delta', baseline: r1.prepared.inputs.head });
    expect(existsSync(join(i2.root, 'FOLD.diff'))).toBe(true);
    expect(readFileSync(join(i2.root, 'FOLD.diff'), 'utf8')).toContain('return sum(values[start:end + 1])');
    const brief = readFileSync(i2.briefFile, 'utf8');
    expect(brief).toContain('ROUND: 2');
    expect(brief).toContain('only the delta, FOLD.diff');
    const owedId = findingIdOf(i2.targetKey, `${i2.repoName}/calc/rangesum.py`, 'range_sum excludes the end index');
    expect(i2.earlierItems.map((i) => [i.id, i.closedContext])).toEqual([[owedId, false]]);
    expect(brief).toContain(`- ${owedId}`);
    expect(readFileSync(join(i2.root, 'PREVIOUS-REVIEWS.md'), 'utf8')).toContain('DATA: HIGH widget/calc/rangesum.py:11 range_sum excludes the end index');

    // The earlier item needs its row; an open owed-eligible item needs an owed fix_row.
    const missing = adjudicate(h.store, h.layout, i2.roundId, adjudicationFor(h, i2.roundId, (a) => {
      a['earlier_items'] = [];
    }));
    expect(missing.outcome.ok).toBe(false);
    if (!missing.outcome.ok) expect(missing.outcome.errors).toContain(`[coverage] earlier item ${owedId} has no row (closed, half-closed or open)`);
    const openNoFix = adjudicate(h.store, h.layout, i2.roundId, adjudicationFor(h, i2.roundId, (a) => {
      a['earlier_items'] = [{ source: owedId, status: 'open', evidence: 'still drops it', fix_row: null }];
    }));
    expect(openNoFix.outcome.ok).toBe(false);
    if (!openNoFix.outcome.ok) expect(openNoFix.outcome.errors.join('\n')).toContain(`earlier item ${owedId} is open and owed under this round's rule`);
    const ok = adjudicate(h.store, h.layout, i2.roundId, adjudicationFor(h, i2.roundId, (a) => {
      a['findings'] = [];
      a['verdict'] = 'SHIP';
      a['unmapped'] = adjudicationLegFindings(h, i2.roundId).map((x) => ({ ...x, reason: 'the earlier item, now closed' }));
      a['leg_verdicts'] = (a['leg_verdicts'] as Array<{ seat: string; raw: string }>).map((v) => ({ ...v, effective: v.raw === 'NEEDS-WORK' ? 'SHIP-WITH-FIXES' : v.raw }));
    }));
    expect(ok.outcome.ok, JSON.stringify(ok.outcome)).toBe(true);
    const item = h.store.db.prepare('SELECT status, body_sha256 FROM earlier_items WHERE round_id = ?').get(i2.roundId) as { status: string; body_sha256: string };
    expect(item.status).toBe('closed');
    expect(item.body_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Round 3: the closed item is closed context, with no row asked.
    commitChange(repo, 'calc/notes.md', 'notes\n', 'notes');
    const r3 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(r3.prepared.inputs.roundNo).toBe(3);
    expect(r3.prepared.inputs.earlierItems.map((i) => [i.id, i.closedContext])).toEqual([[owedId, true]]);
    expect(readFileSync(r3.prepared.inputs.briefFile, 'utf8')).toContain(`Closed context (closed earlier, unchanged; no row needed): ${owedId}.`);
  }, 120_000);

  it('counts a head only once a round on it is adjudicated', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const r1 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(r1.prepared.inputs.roundNo).toBe(1);
    // Settled but never adjudicated: the next head is still round 1, with no baseline.
    commitChange(repo, 'calc/notes.md', 'notes\n', 'notes');
    const r2 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(r2.prepared.inputs).toMatchObject({ roundNo: 1, baseline: null, scope: 'full' });
  }, 60_000);

  it('keeps the round number on a re-run at the same head, and falls back to a full review after a rebase (D17)', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const r1 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(adjudicate(h.store, h.layout, r1.prepared.inputs.roundId, adjudicationFor(h, r1.prepared.inputs.roundId)).outcome.ok).toBe(true);
    const again = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(again.prepared.inputs).toMatchObject({ roundNo: 1, baseline: null, scope: 'full' });
    // Rewrite the branch: the baseline is no longer an ancestor of the head.
    git(repo, ['reset', '--quiet', '--hard', 'main']);
    commitChange(repo, 'calc/rangesum.py', 'def range_sum(values, start, end):\n    return sum(values[start:end])\n', 'calc: rewritten');
    const r2 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(r2.prepared.inputs).toMatchObject({ roundNo: 2, rule: 'serious', scope: 'fallback' });
    expect(r2.prepared.inputs.fullRoundReason).toContain('not an ancestor');
    expect(getRound(h.store.db, r2.prepared.inputs.roundId)?.full_round_reason).toContain('not an ancestor');
    expect(readFileSync(r2.prepared.inputs.briefFile, 'utf8')).toContain('This round is a full review, but this rule still applies (D17).');
  }, 120_000);

  it('briefs round 4 as HIGH-only and rejects a MEDIUM owed row there; a NEEDS-WORK leg with only non-HIGH findings is effectively SWF', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    for (let round = 1; round <= 3; round++) {
      const r = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
      expect(r.prepared.inputs.roundNo).toBe(round);
      // Close every earlier item; the finding is raised again and stays owed.
      const ok = adjudicate(h.store, h.layout, r.prepared.inputs.roundId, adjudicationFor(h, r.prepared.inputs.roundId));
      expect(ok.outcome.ok, JSON.stringify(ok.outcome)).toBe(true);
      commitChange(repo, `calc/round${round}.md`, `round ${round}\n`, `round ${round}`);
    }
    const r4 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    const i4 = r4.prepared.inputs;
    expect(i4).toMatchObject({ roundNo: 4, rule: 'high-only', scope: 'delta' });
    const brief = readFileSync(i4.briefFile, 'utf8');
    expect(brief).toContain('From round 4 only HIGH blocks');
    expect(brief).toContain('Report only HIGH defects');

    const medium = adjudicate(h.store, h.layout, i4.roundId, adjudicationFor(h, i4.roundId, (a) => {
      (a['findings'] as Array<Record<string, unknown>>)[0]!['severity'] = 'MEDIUM';
    }));
    expect(medium.outcome.ok).toBe(false);
    if (!medium.outcome.ok) expect(medium.outcome.errors.join('\n')).toMatch(/\[round-rule\] finding f_[0-9a-f]{12} is owed at MEDIUM in round 4/);

    // The adjudicator rates it MEDIUM: a follow-up in round 4, and the claude legs' NEEDS-WORK reads as SWF.
    const followUp = (a: Record<string, unknown>, swf: boolean): void => {
      const f = (a['findings'] as Array<Record<string, unknown>>)[0]!;
      f['severity'] = 'MEDIUM';
      f['outcome'] = 'follow-up';
      a['followups'] = [f['id']];
      a['verdict'] = 'SHIP-WITH-FIXES';
      a['earlier_items'] = (a['earlier_items'] as Array<Record<string, unknown>>).map((e) => ({ ...e, status: 'closed' }));
      if (swf) a['leg_verdicts'] = (a['leg_verdicts'] as Array<{ seat: string; raw: string }>).map((v) => ({ ...v, effective: v.raw === 'NEEDS-WORK' ? 'SHIP-WITH-FIXES' : v.raw }));
    };
    const stale = adjudicate(h.store, h.layout, i4.roundId, adjudicationFor(h, i4.roundId, (a) => followUp(a, false)));
    expect(stale.outcome.ok).toBe(false);
    if (!stale.outcome.ok) expect(stale.outcome.errors).toContain("[effective] seat b: effective verdict NEEDS-WORK should be SHIP-WITH-FIXES from its own mapped findings under this round's rule (plan 3.2)");
    const ok = adjudicate(h.store, h.layout, i4.roundId, adjudicationFor(h, i4.roundId, (a) => {
      followUp(a, true);
      a['approve'] = true;
    }));
    expect(ok.outcome.ok, JSON.stringify(ok.outcome)).toBe(true);
    // SHIP-WITH-FIXES with 0 owed rows is recorded as SHIP (plan 3.2); the follow-up is in the follow-ups store.
    expect(getRound(h.store.db, i4.roundId)).toMatchObject({ verdict: 'SHIP', owed_count: 0, approve: 1 });
    expect(h.store.db.prepare('SELECT count(*) AS n FROM followups WHERE round_id = ?').get(i4.roundId)).toMatchObject({ n: 1 });
  }, 180_000);

  it('numbers plan targets by repo and path, with an uncommitted plan snapshotted', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const t = resolvePlanTarget(repo, 'docs/PLAN.md');
    expect(t.snapshot).toBeNull();
    const r1 = await runRound(h, t);
    expect(r1.prepared.inputs).toMatchObject({ mode: 'plan', roundNo: 1, planPath: 'docs/PLAN.md', label: 'docs/PLAN.md' });
    expect(readFileSync(r1.prepared.inputs.briefFile, 'utf8')).toContain('The plan docs/PLAN.md: the whole plan at widget/docs/PLAN.md, at HEAD.');
    const { writeTree } = await import('./helpers/git-fixture.js');
    writeTree(repo, { 'docs/PLAN.md': '# Plan\n\n1. Sum a range, inclusive of both ends.\n2. Add a mean.\n', 'scratch.txt': 'not part of the plan\n' });
    const t2 = resolvePlanTarget(repo, 'docs/PLAN.md');
    expect(t2.snapshot).toContain('uncommitted docs/PLAN.md');
    expect(t2.head).not.toBe(t.head);
    // The same uncommitted content is the same snapshot commit.
    expect(resolvePlanTarget(repo, 'docs/PLAN.md').head).toBe(t2.head);
    // The user's index and branch are untouched: nothing staged, the file still modified in the work tree.
    expect(git(repo, ['diff', '--cached', '--name-only'])).toBe('');
    expect(git(repo, ['diff', '--name-only'])).toBe('docs/PLAN.md');
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(t.head);
    const r2 = await runRound(h, t2);
    expect(readFileSync(join(r2.prepared.inputs.root, 'widget', 'docs', 'PLAN.md'), 'utf8')).toContain('2. Add a mean.');
    expect(existsSync(join(r2.prepared.inputs.root, 'widget', 'scratch.txt'))).toBe(false);
    expect(r2.prepared.inputs.targetId).toBe(r1.prepared.inputs.targetId);
  }, 120_000);
});

/** Every leg finding of the counted legs, as {seat, leg_finding}, for unmapped lists. */
function adjudicationLegFindings(h: Harness, roundId: number): Array<{ seat: string; leg_finding: string }> {
  return roundSummary(h.store, h.layout, roundId)
    .legs.filter((l) => l.counted)
    .flatMap((l) => (l.findings_extracted_by === 'leg' ? l.findings.map((f) => ({ seat: l.seat, leg_finding: f.id })) : []));
}

describe('residue sweep (plan 3.1 step 7)', () => {
  it('fails the leg that changed the root, and keeps legs that ended before the change', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const { prepared, result } = await runRound(h, resolveDiffTarget(repo, 'main..feature'), {
      claude: { [OCC.c]: [claudeCase('success', { delayMs: 2500, writeIntoRoot: 'residue.txt' })] },
    });
    const legs = getLegs(h.store.db, prepared.inputs.roundId);
    expect(legs.map((l) => [l.seat_id, l.status, l.root_mutated])).toEqual([
      ['a', 'PASS', 0],
      ['b', 'PASS', 0],
      ['c', 'CONTAMINATED', 1],
    ]);
    expect(result).toMatchObject({ quorum: 'council', ratified: 2 });
    expect(getEvents(h.store.db, prepared.inputs.roundId).find((e) => e.kind === 'residue')?.detail).toMatchObject({ failed_legs: [] });
  }, 60_000);

  it('blames legs alive after the last clean sweep; a change nobody was caught for fails every ratified leg', () => {
    const leg = (status: 'PASS' | 'CONTAMINATED', endedAtMs: number, rootMutated = false) => ({ status, endedAtMs, rootMutated });
    expect(residueSuspects([leg('PASS', 100), leg('PASS', 300)], 200)).toEqual([leg('PASS', 300)]);
    expect(residueSuspects([leg('PASS', 100), leg('CONTAMINATED', 150, true)], 200)).toEqual([]);
    expect(residueSuspects([leg('PASS', 100), leg('PASS', 150)], 200)).toEqual([leg('PASS', 100), leg('PASS', 150)]);
  });
});

describe('fold row 1: deletes are contained, roots are created exclusively', () => {
  it('removes only a real root dir directly under the roots dir, by its root name', () => {
    const h = harness();
    const rootsDir = h.layout.rootsDir;
    mkdirSync(rootsDir, { recursive: true });
    const outside = scratch('sc-outside-');
    writeFileSync(join(outside, 'keep.txt'), 'keep\n');
    const real = join(rootsDir, rootName(h.layout, 7, 1));
    mkdirSync(real);
    const link = join(rootsDir, rootName(h.layout, 8, 1));
    symlinkSync(outside, link);
    expect(removeOwnedRoot(h.layout, outside).removed).toBe(false);
    expect(removeOwnedRoot(h.layout, join(rootsDir, '..', '..')).removed).toBe(false);
    expect(removeOwnedRoot(h.layout, join(rootsDir, 'not-a-root')).removed).toBe(false);
    expect(removeOwnedRoot(h.layout, link)).toMatchObject({ removed: false, why: expect.stringContaining('not a directory') });
    expect(removeOwnedRoot(h.layout, join(outside, rootName(h.layout, 7, 1))).removed).toBe(false);
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true);
    expect(removeOwnedRoot(h.layout, real).removed).toBe(true);
    expect(existsSync(real)).toBe(false);
  });

  it('names roots by store, so two stores sharing a roots dir never collide', () => {
    const a = harness();
    const b = harness();
    const shared = { ...b.layout, rootsDir: a.layout.rootsDir };
    expect(rootName(a.layout, 1, 1)).not.toBe(rootName(shared, 1, 1));
    expect(rootName(a.layout, 1, 1)).toMatch(/^[0-9a-f]{8}-1-a1$/);
  });

  it('never deletes a pre-existing root dir when preparation fails', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const taken = rootPathOf(h.layout, 1, 1);
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, 'someone-elses.txt'), 'mine\n');
    await expect(runRound(h, resolveDiffTarget(repo, 'main..feature'))).rejects.toThrow(/EEXIST/);
    expect(readFileSync(join(taken, 'someone-elses.txt'), 'utf8')).toBe('mine\n');
    expect(getRound(h.store.db, 1)?.status).toBe('failed');
  }, 60_000);

  it('deletes the root named by the layout at adjudication, never the one round.json names', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const r = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    const victim = scratch('sc-victim-');
    writeFileSync(join(victim, 'keep.txt'), 'keep\n');
    const file = join(r.prepared.roundDir, 'round.json');
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), root: victim }));
    expect(adjudicate(h.store, h.layout, r.prepared.inputs.roundId, adjudicationFor(h, r.prepared.inputs.roundId)).outcome.ok).toBe(true);
    expect(readFileSync(join(victim, 'keep.txt'), 'utf8')).toBe('keep\n');
    expect(existsSync(rootPathOf(h.layout, r.prepared.inputs.roundId, 1))).toBe(false);
    expect(existsSync(`${rootPathOf(h.layout, r.prepared.inputs.roundId, 1)}.git`)).toBe(false);
  }, 60_000);
});

describe('fold row 3: the store decides, round.json is a display copy', () => {
  it('a tampered round.json cannot change the rule or the earlier items the validator applies', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const r1 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    expect(adjudicate(h.store, h.layout, r1.prepared.inputs.roundId, adjudicationFor(h, r1.prepared.inputs.roundId)).outcome.ok).toBe(true);
    commitChange(repo, 'calc/notes.md', 'notes\n', 'notes');
    const r2 = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    const i2 = r2.prepared.inputs;
    const file = join(r2.prepared.roundDir, 'round.json');
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), rule: 'round-1', earlierItems: [], roundNo: 1 }));
    expect(roundSummary(h.store, h.layout, i2.roundId)).toMatchObject({ rule: 'serious', earlier_items: [expect.objectContaining({ id: i2.earlierItems[0]!.id })] });
    const r = adjudicate(h.store, h.layout, i2.roundId, adjudicationFor(h, i2.roundId, (a) => {
      a['earlier_items'] = [];
    }));
    expect(r.outcome.ok).toBe(false);
    if (!r.outcome.ok) expect(r.outcome.errors.join('\n')).toContain(`earlier item ${i2.earlierItems[0]!.id} has no row`);
  }, 120_000);

  it("a tampered leg reply.json cannot drop a leg's findings from the attribution check", async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const r = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    const reply = join(r.prepared.roundDir, 'legs', 'b-primary-1', 'reply.json');
    const parsed = JSON.parse(readFileSync(reply, 'utf8')) as { findings: { findings: unknown[] } };
    parsed.findings.findings = [];
    writeFileSync(reply, JSON.stringify(parsed));
    const res = adjudicate(h.store, h.layout, r.prepared.inputs.roundId, adjudicationFor(h, r.prepared.inputs.roundId, (a) => {
      a['findings'] = [];
      a['unmapped'] = [];
      a['verdict'] = 'SHIP';
      a['leg_verdicts'] = (a['leg_verdicts'] as Array<{ seat: string; raw: string }>).map((v) => ({ ...v, effective: v.raw === 'NEEDS-WORK' ? 'SHIP-WITH-FIXES' : v.raw }));
    }));
    expect(res.outcome.ok).toBe(false);
    if (!res.outcome.ok) expect(res.outcome.errors).toContain("[attribution] seat b's finding F1 is not mapped (raised_by of a finding, or unmapped with a reason)");
  }, 60_000);

  it('fails the round before any leg runs when the root changed after it was sealed', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const config = await rosterConfig();
    const prepared = prepareRound(h.store, { config, configPath: '/dev/null', layout: h.layout, target: resolveDiffTarget(repo, 'main..feature') });
    writeFileSync(join(prepared.inputs.root, 'widget', 'calc', 'rangesum.py'), 'swapped\n');
    const { env } = fakeHome({});
    await expect(runWorker(h.store, h.layout, prepared.inputs.roundId, { adapters: fakeAdapters, env, pollMs: 20 })).rejects.toThrow(/no longer hashes to the sealed tree/);
    expect(getRound(h.store.db, prepared.inputs.roundId)?.status).toBe('failed');
    expect(getLegs(h.store.db, prepared.inputs.roundId)).toEqual([]);
  }, 60_000);
});

describe('fold row 2: the snapshot honours the user excludes and leaves secrets out', () => {
  const treeFiles = (repo: string, sha: string): string[] => git(repo, ['ls-tree', '-r', '--name-only', sha]).split('\n');

  it('leaves out files ignored only by the global excludes file (core.excludesFile), git default and info/exclude', () => {
    const { repo } = fixtureRepo();
    const home = scratch('sc-user-home-');
    writeFileSync(join(home, 'global-ignore'), 'global-only.log\n');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${join(home, 'global-ignore')}\n`);
    mkdirSync(join(home, 'xdg', 'git'), { recursive: true });
    writeFileSync(join(home, 'xdg', 'git', 'ignore'), 'xdg-only.log\n');
    writeFileSync(join(repo, '.git', 'info', 'exclude'), 'info-only.log\n');
    for (const f of ['global-only.log', 'xdg-only.log', 'info-only.log', 'new-module.py']) writeFileSync(join(repo, f), 'x\n');
    const env = { PATH: process.env['PATH'], HOME: home };
    const t = resolveDiffTarget(repo, undefined, { env });
    const files = treeFiles(repo, t.head);
    expect(files).toContain('new-module.py');
    expect(files).not.toContain('global-only.log');
    expect(files).not.toContain('info-only.log');
    // With no core.excludesFile configured, git's default $XDG_CONFIG_HOME/git/ignore applies.
    writeFileSync(join(home, '.gitconfig'), '');
    const t2 = resolveDiffTarget(repo, undefined, { env: { ...env, XDG_CONFIG_HOME: join(home, 'xdg') } });
    expect(treeFiles(repo, t2.head)).not.toContain('xdg-only.log');
    expect(treeFiles(repo, t2.head)).toContain('global-only.log');
  });

  it('keeps a globally ignored .env and secret-named untracked files out of the root, and warns', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const home = scratch('sc-user-home-');
    writeFileSync(join(home, '.gitconfig'), `[core]\n\texcludesFile = ${join(home, 'ignore')}\n`);
    writeFileSync(join(home, 'ignore'), '.env\n');
    writeFileSync(join(repo, '.env'), 'TOKEN=secret\n');
    writeFileSync(join(repo, 'server.pem'), 'key\n');
    writeFileSync(join(repo, '.env.local'), 'TOKEN=secret\n');
    mkdirSync(join(repo, 'keys'));
    writeFileSync(join(repo, 'keys', 'id_ed25519'), 'key\n');
    writeFileSync(join(repo, 'id_utils.py'), 'def f(): pass\n');
    const t = resolveDiffTarget(repo, undefined, { env: { PATH: process.env['PATH'], HOME: home } });
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain('".env.local"');
    expect(t.warnings[0]).toContain('"server.pem"');
    expect(t.warnings[0]).toContain('"keys/id_ed25519"');
    expect(t.warnings[0]).not.toContain('"id_utils.py"');
    const r = await runRound(h, t);
    const root = join(r.prepared.inputs.root, 'widget');
    for (const f of ['.env', '.env.local', 'server.pem', 'keys/id_ed25519']) expect(existsSync(join(root, f)), f).toBe(false);
    expect(existsSync(join(root, 'id_utils.py'))).toBe(true);
    expect(git(repo, ['diff', '--cached', '--name-only'])).toBe('');
  }, 60_000);
});

describe('fold row 4: one adjudication per round, the store is the source of truth', () => {
  it('two adjudications racing for one round store exactly one', async () => {
    const h = harness();
    const { repo } = fixtureRepo();
    const r = await runRound(h, resolveDiffTarget(repo, 'main..feature'));
    const id = r.prepared.inputs.roundId;
    const first = adjudicationFor(h, id);
    const second = adjudicationFor(h, id, (a) => {
      (a['findings'] as Array<Record<string, unknown>>)[0]!['severity'] = 'MEDIUM';
      a['reason'] = 'the second adjudicator';
    });
    const other = openStore(h.layout.dbPath);
    try {
      // The second process gets in between this call's decision and its transaction, and stores first.
      expect(() =>
        adjudicate(h.store, h.layout, id, first, {
          beforeTransaction: () => {
            expect(adjudicate(other, h.layout, id, second).stored).toBe(true);
          },
        }),
      ).toThrow(/is adjudicated; only a round awaiting adjudication/);
    } finally {
      other.close();
    }
    expect(getEvents(h.store.db, id).filter((e) => e.kind === 'adjudicated')).toHaveLength(1);
    expect(h.store.db.prepare('SELECT severity FROM findings WHERE round_id = ?').all(id).map((x) => ({ ...x }))).toEqual([{ severity: 'MEDIUM' }]);
    // The stored document and the exported file are the second adjudication's.
    const doc = getEvents(h.store.db, id).find((e) => e.kind === 'adjudicated')?.detail as { document: { reason: string } };
    expect(doc.document.reason).toBe('the second adjudicator');
    expect(JSON.parse(readFileSync(join(r.prepared.roundDir, 'ADJUDICATION.json'), 'utf8'))).toMatchObject({ reason: 'the second adjudicator' });
    expect(readdirSync(r.prepared.roundDir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  }, 60_000);
});
