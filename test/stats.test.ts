import { describe, expect, it } from 'vitest';
import { loadStats } from '../src/stats/data.js';
import { agreementOf, percentile } from '../src/stats/metrics.js';
import { buildReport, occupantMatches, thresholdsOf, type StatsReport, type Thresholds } from '../src/stats/report.js';
import { parseSince, WindowError } from '../src/stats/window.js';
import { cleanScratchAfterAll } from './helpers/fixtures.js';
import { OCC, statsStore, three, type FindingSpec, type StatsStore } from './helpers/stats-store.js';

cleanScratchAfterAll();

/*
 * Known-answer tests for every scorecard metric (plan 8.2), the swap-candidate rule (8.3) and the window, on synthetic
 * stores written by the fixture writer (test/helpers/stats-store.ts).
 */

const DEFAULTS: Thresholds = thresholdsOf({ swap_min_ratified_rounds: 20, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'defaults');
const NOW = '2026-11-14T00:00:00.000Z';

function report(w: StatsStore, opts: { since?: string | null; thresholds?: Thresholds; seat?: string | null; occupant?: string | null } = {}): StatsReport {
  return buildReport(loadStats(w.store.db, opts.since ?? null), opts.thresholds ?? DEFAULTS, { seat: opts.seat ?? null, occupant: opts.occupant ?? null }, NOW);
}

const seatCard = (r: StatsReport, seat: string) => {
  const c = r.seats.find((s) => s.seat === seat);
  if (!c) throw new Error(`no seat ${seat} in the report`);
  return c;
};
const occCard = (r: StatsReport, key: string) => {
  const c = r.occupants.find((o) => o.occupant.key === key);
  if (!c) throw new Error(`no occupant ${key} in the report`);
  return c;
};

describe('stats: the window (--since)', () => {
  const now = Date.parse('2026-11-14T12:00:00.000Z');
  it('takes durations, a UTC date and an ISO timestamp with a zone', () => {
    expect(parseSince('30d', now)).toBe('2026-10-15T12:00:00.000Z');
    expect(parseSince('12h', now)).toBe('2026-11-14T00:00:00.000Z');
    expect(parseSince('2w', now)).toBe('2026-10-31T12:00:00.000Z');
    expect(parseSince('90m', now)).toBe('2026-11-14T10:30:00.000Z');
    expect(parseSince('2026-11-01', now)).toBe('2026-11-01T00:00:00.000Z');
    expect(parseSince('2026-11-01T08:00:00+02:00', now)).toBe('2026-11-01T06:00:00.000Z');
  });

  it('rejects anything else', () => {
    for (const bad of ['30', 'd', '0d', '-3d', '30 days', '2026-13-01', '2026-02-30', '2026-11-01T08:00:00', 'yesterday', '']) {
      expect(() => parseSince(bad, now), bad).toThrow(WindowError);
    }
  });

  it('excludes rounds started before it, and says so when nothing is left', () => {
    const w = statsStore();
    w.round({ at: '2026-10-01T00:00:00.000Z', legs: three({ a: 'NEEDS-WORK' }) });
    w.round({ at: '2026-11-10T00:00:00.000Z', legs: three() });
    const all = report(w);
    expect(seatCard(all, 'a')).toMatchObject({ rounds_seated: 2, verdicts: { SHIP: 1, 'NEEDS-WORK': 1 } });
    const recent = report(w, { since: '2026-11-01T00:00:00.000Z' });
    expect(recent.window.rounds.council).toBe(1);
    expect(seatCard(recent, 'a')).toMatchObject({ rounds_seated: 1, verdicts: { SHIP: 1, 'NEEDS-WORK': 0 } });
    expect(recent.message).toBeNull();
    // A round started exactly at the cutoff is in the window.
    expect(report(w, { since: '2026-11-10T00:00:00.000Z' }).window.rounds.council).toBe(1);
    const empty = report(w, { since: '2026-11-12T00:00:00.000Z' });
    expect(empty.message).toBe('no rounds since 2026-11-12T00:00:00.000Z: nothing to score');
    expect(empty.seats).toEqual([]);
    expect(empty.recommendations).toEqual([]);
    w.close();
  });

  it('says so for an empty store', () => {
    const w = statsStore();
    const r = report(w);
    expect(r.message).toBe('no rounds in the run store yet: nothing to score');
    expect(r.window.rounds.total).toBe(0);
    w.close();
  });
});

describe('stats: which rounds count', () => {
  it('counts dry-run, failed, solo and awaiting rounds for the leg metrics; leaves out identity and running rounds', () => {
    const w = statsStore();
    w.round({ dryRun: true, legs: three() }); // adjudicated dry run
    w.round({ status: 'failed', legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'timeout' }, { seat: 'b', occ: OCC.b, status: 'FAIL', failure: 'auth' }] });
    w.round({ legs: [{ seat: 'a', occ: OCC.a, verdict: 'SHIP' }, { seat: 'b', occ: OCC.b, status: 'FAIL', failure: 'empty' }] }); // solo, adjudicated
    w.round({ status: 'awaiting-adjudication', legs: three() });
    w.round({ kind: 'identity' });
    w.round({ status: 'running', legs: three() });
    w.round({ status: 'superseded', legs: [{ seat: 'a', occ: OCC.a, status: 'RUNNING' }, { seat: 'b', occ: OCC.b }] });
    // Superseded after its adjudication (the head moved before the post): its findings count.
    w.round({ status: 'superseded', verdict: 'NEEDS-WORK', legs: [{ seat: 'c', occ: OCC.c, verdict: 'NEEDS-WORK' }, { seat: 'b', occ: OCC.b }], findings: [{ outcome: 'owed', by: ['c'] }] });
    const r = report(w);
    expect(r.window.rounds).toEqual({ total: 8, identity: 1, council: 7, running: 1, settled: 6, adjudicated: 3, failed: 1, awaiting_adjudication: 1, dry_run: 1 });
    expect(seatCard(r, 'c')).toMatchObject({ rounds_seated: 3, adjudicated_ratified: 2, findings: { raised: 1, adopted: 1 } });
    // a: seated in the dry run, the failed round, the solo round and the awaiting round; its RUNNING leg is left out.
    expect(seatCard(r, 'a')).toMatchObject({ rounds_seated: 4, rounds_ratified: 3, ratified_rate: 0.75, adjudicated_ratified: 2 });
    // b: the dry run, failed, solo (failed leg), awaiting, both superseded rounds (one adjudicated).
    expect(seatCard(r, 'b')).toMatchObject({ rounds_seated: 6, rounds_ratified: 4, ratified_rate: 4 / 6, adjudicated_ratified: 2 });
    w.close();
  });
});

describe('stats: failure mix, fallbacks and relaunches', () => {
  it('attributes a fallback leg to its seat and to its own occupant, never to the primary occupant', () => {
    const w = statsStore();
    // Round 1: a's primary hits its usage limit; the fallback ratifies and raises an owed finding.
    w.round({
      legs: [
        { seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'usage_limit', usd: 0.01 },
        { seat: 'a', occ: OCC.af, role: 'fallback', verdict: 'NEEDS-WORK', credits: 0.5 },
        { seat: 'b', occ: OCC.b, verdict: 'NEEDS-WORK' },
        { seat: 'c', occ: OCC.c },
      ],
      findings: [{ outcome: 'owed', severity: 'HIGH', by: ['a', 'b'] }],
    });
    // Round 2: a's primary ratifies.
    w.round({ legs: three() });
    const r = report(w);
    const a = seatCard(r, 'a');
    expect(a).toMatchObject({ rounds_seated: 2, rounds_ratified: 2, ratified_rate: 1 });
    expect(a.failures).toEqual({ legs: 3, failed_legs: 1, by_class: { usage_limit: 1 }, fallback_used_rounds: 1, fallback_used_rate: 0.5, as_fallback_rounds: null, relaunch_rounds: 0, relaunch_rate: 0 });
    expect(a.findings).toMatchObject({ raised: 1, adopted: 1 });
    expect(a.occupants).toEqual([w.occupantId(OCC.a), w.occupantId(OCC.af)]);

    const primary = occCard(r, OCC.a);
    expect(primary).toMatchObject({ rounds_seated: 2, rounds_ratified: 1, ratified_rate: 0.5, seats: ['a'] });
    expect(primary.failures).toMatchObject({ by_class: { usage_limit: 1 }, fallback_used_rounds: 1, fallback_used_rate: 0.5, as_fallback_rounds: 0 });
    expect(primary.findings.raised).toBe(0);
    expect(primary.cost).toMatchObject({ usd: 0.01, legs_with_usd: 1, credits: 0, legs_with_credits: 0 });

    const fallback = occCard(r, OCC.af);
    expect(fallback).toMatchObject({ rounds_seated: 1, rounds_ratified: 1, ratified_rate: 1, seats: ['a'] });
    expect(fallback.failures).toMatchObject({ failed_legs: 0, fallback_used_rounds: 0, fallback_used_rate: null, as_fallback_rounds: 1 });
    expect(fallback.findings).toMatchObject({ raised: 1, adopted: 1 });
    expect(fallback.verdicts).toMatchObject({ 'NEEDS-WORK': 1 });
    expect(fallback.cost).toMatchObject({ credits: 0.5, legs_with_credits: 1 });
    w.close();
  });

  it('tells a relaunch (attempt 2, same role) from a fallback (the fallback role), and counts each failure class', () => {
    const w = statsStore();
    w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'capacity' }, { seat: 'a', occ: OCC.a, attempt: 2 }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'timeout' }, { seat: 'a', occ: OCC.a, attempt: 2, status: 'FAIL', failure: 'timeout' }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'CONTAMINATED' }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'PREFLIGHT_FAIL', failure: 'auth' }, { seat: 'a', occ: OCC.af, role: 'fallback', status: 'FAIL', failure: 'empty' }, { seat: 'a', occ: OCC.af, role: 'fallback', attempt: 2 }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    const a = seatCard(report(w), 'a');
    expect(a.failures.by_class).toEqual({ capacity: 1, timeout: 2, contaminated: 1, auth: 1, empty: 1 });
    expect(a.failures).toMatchObject({ legs: 8, failed_legs: 6, relaunch_rounds: 3, relaunch_rate: 0.75, fallback_used_rounds: 1, fallback_used_rate: 0.25 });
    expect(a).toMatchObject({ rounds_seated: 4, rounds_ratified: 2, ratified_rate: 0.5 });
    w.close();
  });
});

describe('stats: verdict mix', () => {
  it('counts each ratified leg by its raw verdict, none included', () => {
    const w = statsStore();
    w.round({ legs: three({ a: 'SHIP' }) });
    w.round({ legs: three({ a: 'SHIP-WITH-FIXES' }) });
    w.round({ legs: three({ a: 'NEEDS-WORK' }) });
    w.round({ legs: three({ a: 'none' }) });
    w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'model' }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    expect(seatCard(report(w), 'a').verdicts).toEqual({ SHIP: 1, 'SHIP-WITH-FIXES': 1, 'NEEDS-WORK': 1, none: 1 });
    w.close();
  });
});

describe('stats: raised, adopted, refuted and precision', () => {
  it('adopted = owed + follow-up + ruling upheld; refuted = refuted + ruling overturned; nits, noted and pending rulings are neither', () => {
    const w = statsStore();
    const f = (outcome: FindingSpec['outcome'], ruling?: 'upheld' | 'overturned'): FindingSpec => ({ outcome, ...(ruling ? { ruling } : {}), by: ['a'] });
    w.round({ legs: three({ a: 'NEEDS-WORK' }), findings: [f('owed'), f('follow-up'), f('ruling', 'upheld'), f('refuted'), f('ruling', 'overturned'), f('nit'), f('noted'), f('ruling')] });
    const a = seatCard(report(w), 'a');
    expect(a.findings).toEqual({
      raised: 8,
      adopted: 3,
      refuted: 2,
      pending: 1,
      by_outcome: { owed: 1, 'follow-up': 1, nit: 1, refuted: 1, noted: 1, 'ruling-upheld': 1, 'ruling-overturned': 1, 'ruling-pending': 1 },
      precision: 0.6,
      unmapped: 0,
    });
    // Seat b raised nothing: its precision is n/a, not 0.
    expect(seatCard(report(w), 'b').findings.precision).toBeNull();
    w.close();
  });

  it('counts a canonical finding once per seat, and the leg findings it left unmapped apart', () => {
    const w = statsStore();
    w.round({ legs: three({}, { a: { unmapped: 2 } }), findings: [{ outcome: 'refuted', by: ['a', 'a'] }] });
    expect(seatCard(report(w), 'a').findings).toMatchObject({ raised: 1, refuted: 1, unmapped: 2, precision: 0 });
    w.close();
  });

  it('reads findings only from adjudicated rounds (a leg finding no adjudication has mapped yet is not unmapped)', () => {
    const w = statsStore();
    w.round({ status: 'awaiting-adjudication', legs: three({}, { a: { unmapped: 2 } }) });
    expect(seatCard(report(w), 'a')).toMatchObject({ rounds_ratified: 1, adjudicated_ratified: 0, findings: { raised: 0, unmapped: 0 } });
    w.close();
  });
});

describe('stats: unique adopted, owed and HIGH', () => {
  it('a finding two seats raised at different severities is unique to neither; HIGH is the final severity of an adopted finding', () => {
    const w = statsStore();
    w.round({
      legs: three({ a: 'NEEDS-WORK', b: 'NEEDS-WORK' }),
      findings: [
        { outcome: 'owed', severity: 'HIGH', by: ['a', 'b'], bySeverity: { a: 'HIGH', b: 'LOW' } }, // shared: unique to neither
        { outcome: 'owed', severity: 'HIGH', by: ['a'] }, // unique owed HIGH
        { outcome: 'follow-up', severity: 'MEDIUM', by: ['a'], bySeverity: { a: 'HIGH' } }, // a called it HIGH; final MEDIUM: no HIGH credit
        { outcome: 'refuted', severity: 'HIGH', by: ['a'] }, // a refuted HIGH earns nothing
        { outcome: 'ruling', ruling: 'upheld', severity: 'HIGH', by: ['b'] }, // b: unique, owed, HIGH
      ],
    });
    const r = report(w);
    expect(seatCard(r, 'a').unique).toEqual({ raised: 3, adopted: 2, owed: 1, high: 1 });
    expect(seatCard(r, 'b').unique).toEqual({ raised: 1, adopted: 1, owed: 1, high: 1 });
    expect(seatCard(r, 'c').unique).toEqual({ raised: 0, adopted: 0, owed: 0, high: 0 });
    w.close();
  });
});

describe('stats: the drop-one counterfactual', () => {
  it("counts a round whose every blocking finding the seat raised alone as flipped to SHIP, and its blocking findings as lost", () => {
    const w = statsStore();
    const flips = w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'owed', by: ['c'] }, { outcome: 'ruling', by: ['c'] }, { outcome: 'follow-up', by: ['a'] }] });
    // Shared blocking finding: dropping c leaves it (raised by a too).
    w.round({ legs: three({ a: 'NEEDS-WORK', c: 'NEEDS-WORK' }), findings: [{ outcome: 'owed', by: ['c'] }, { outcome: 'owed', by: ['a', 'c'] }] });
    // An overturned ruling no longer blocks: the round was already SHIP, nothing to flip.
    w.round({ legs: three(), findings: [{ outcome: 'ruling', ruling: 'overturned', by: ['c'] }] });
    // A human ask stays owed without c.
    w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'owed', by: ['c'] }, { outcome: 'owed', kind: 'human_ask', by: [] }] });
    const c = seatCard(report(w), 'c');
    expect(c.drop_one).toEqual({ rounds: 4, blocking_lost: 4, flipped_to_ship: 1, flipped_rounds: [flips], quorum_lost: 0 });
    expect(seatCard(report(w), 'a').drop_one).toMatchObject({ blocking_lost: 0, flipped_to_ship: 0 });
    w.close();
  });

  it('never counts a flip when dropping the seat leaves one leg (below quorum): that is quorum lost', () => {
    const w = statsStore();
    w.round({ legs: [{ seat: 'a', occ: OCC.a }, { seat: 'c', occ: OCC.c, verdict: 'NEEDS-WORK' }, { seat: 'b', occ: OCC.b, status: 'FAIL', failure: 'usage_limit' }], findings: [{ outcome: 'owed', by: ['c'] }] });
    const c = seatCard(report(w), 'c');
    expect(c.drop_one).toEqual({ rounds: 1, blocking_lost: 1, flipped_to_ship: 0, flipped_rounds: [], quorum_lost: 1 });
    w.close();
  });
});

describe('stats: dissent', () => {
  it('counts a lone dissent the final verdict sided with as right, and one it did not as wrong', () => {
    const w = statsStore();
    const right = w.round({ legs: three({ a: 'SHIP', b: 'SHIP', c: 'NEEDS-WORK' }), findings: [{ outcome: 'owed', severity: 'HIGH', by: ['c'] }] });
    const wrong = w.round({ legs: three({ a: 'SHIP', b: 'SHIP', c: 'NEEDS-WORK' }), findings: [{ outcome: 'refuted', by: ['c'] }] });
    // A lone SHIP the round agreed with: the two NEEDS-WORK legs' findings were refuted.
    const shipRight = w.round({ legs: three({ a: 'NEEDS-WORK', b: 'NEEDS-WORK', c: 'SHIP' }), findings: [{ outcome: 'refuted', by: ['a', 'b'] }] });
    // Not a lone dissent: only one other leg has a verdict.
    w.round({ legs: three({ a: 'none', b: 'SHIP', c: 'NEEDS-WORK' }) });
    // Not a lone dissent for c (b agrees with it); a lone SHIP for a, since SHIP-WITH-FIXES is not SHIP.
    const aAlone = w.round({ legs: three({ a: 'SHIP', b: 'SHIP-WITH-FIXES', c: 'NEEDS-WORK' }) });
    const r = report(w);
    expect(seatCard(r, 'c').dissent).toEqual({
      lone: 3,
      right: 2,
      right_rate: 2 / 3,
      rounds: [
        { round: right, said: 'not', right: true },
        { round: wrong, said: 'not', right: false },
        { round: shipRight, said: 'ship', right: true },
      ],
    });
    expect(seatCard(r, 'a').dissent).toEqual({ lone: 1, right: 1, right_rate: 1, rounds: [{ round: aAlone, said: 'ship', right: true }] });
    expect(seatCard(r, 'b').dissent.lone).toBe(0);
    w.close();
  });
});

describe('stats: the agreement matrix', () => {
  it('shows two seats that always agree, and counts SHIP-vs-not disagreements', () => {
    const w = statsStore();
    w.round({ legs: three({ a: 'SHIP', b: 'SHIP', c: 'NEEDS-WORK' }) });
    w.round({ legs: three({ a: 'SHIP-WITH-FIXES', b: 'NEEDS-WORK', c: 'SHIP' }) });
    w.round({ legs: three({ a: 'SHIP', b: 'SHIP', c: 'SHIP' }) });
    w.round({ legs: three({ a: 'NEEDS-WORK', b: 'SHIP-WITH-FIXES', c: 'none' }) });
    w.round({ legs: [{ seat: 'a', occ: OCC.a }, { seat: 'b', occ: OCC.b, status: 'FAIL', failure: 'empty' }, { seat: 'c', occ: OCC.c, verdict: 'NEEDS-WORK' }] });
    const data = loadStats(w.store.db, null);
    expect(agreementOf(data, 'seat')).toEqual([
      { a: 'a', b: 'b', rounds: 4, disagree: 0, disagree_rate: 0, always_agree: true },
      { a: 'a', b: 'c', rounds: 4, disagree: 3, disagree_rate: 0.75, always_agree: false },
      { a: 'b', b: 'c', rounds: 3, disagree: 2, disagree_rate: 2 / 3, always_agree: false },
    ]);
    const occ = report(w).agreement.occupants;
    expect(occ[0]).toMatchObject({ a: `${OCC.a} #${w.occupantId(OCC.a)}`, b: `${OCC.b} #${w.occupantId(OCC.b)}`, always_agree: true });
    w.close();
  });
});

describe('stats: cost and duration', () => {
  it('sums USD and credits over every leg, reads quota as a snapshot, and takes nearest-rank percentiles of ratified legs', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([4, 1, 3, 2], 50)).toBe(2);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    const w = statsStore();
    w.round({ legs: three({ a: 'NEEDS-WORK' }, { a: { usd: 0.4, durationMs: 1000, quota: 30 } }), findings: [{ outcome: 'owed', by: ['a'] }, { outcome: 'follow-up', by: ['a'] }] });
    w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'timeout', usd: 0.2, durationMs: 99_000, quota: 80 }, { seat: 'a', occ: OCC.a, attempt: 2, usd: 0.6, durationMs: 3000, quota: 40 }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    w.round({ legs: three({}, { a: { usd: 0.8, durationMs: 2000 } }), findings: [{ outcome: 'refuted', by: ['a'] }] });
    w.round({ status: 'awaiting-adjudication', legs: three({}, { a: { usd: 1, durationMs: 4000 } }) });
    const a = seatCard(report(w), 'a');
    expect(a.cost.usd).toBeCloseTo(3.0, 10);
    expect(a.cost).toMatchObject({ legs_with_usd: 5, credits: 0, legs_with_credits: 0, quota_pct_max: 80, quota_pct_last: 40, duration_ms_p50: 2000, duration_ms_p90: 4000 });
    // USD in adjudicated rounds (0.4 + 0.2 + 0.6 + 0.8 = 2.0) over the 2 adopted findings.
    expect(a.cost.usd_per_adopted).toBeCloseTo(1.0, 10);
    expect(a.cost.credits_per_adopted).toBeNull();
    const b = seatCard(report(w), 'b');
    expect(b.cost).toMatchObject({ usd: 0, legs_with_usd: 0, quota_pct_max: null, duration_ms_p50: null, usd_per_adopted: null });
    w.close();
  });
});

describe('stats: the swap-candidate flag (plan 8.3)', () => {
  /** Seat c over n rounds: in 2 of every 5 it raises a follow-up a also raised, in 3 a refuted finding alone. */
  function lowPrecisionSeat(n: number): StatsStore {
    const w = statsStore();
    for (let i = 0; i < n; i++) {
      const adopted = i % 5 < 2;
      w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [adopted ? { outcome: 'follow-up', by: ['a', 'c'] } : { outcome: 'refuted', by: ['c'], title: `refuted ${i}` }] });
    }
    return w;
  }

  // N = 25 here, so 25 rounds reach it and 24 do not.
  const N25 = thresholdsOf({ swap_min_ratified_rounds: 25, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'config');

  it('flags a seat with 0 unique owed over 25 rounds and precision 40%, and shows the rounds and findings behind it', () => {
    const w = lowPrecisionSeat(25);
    const r = report(w, { thresholds: N25 });
    const c = seatCard(r, 'c');
    expect(c).toMatchObject({ adjudicated_ratified: 25, ratified_rate: 1, unique: { owed: 0 }, findings: { adopted: 10, refuted: 15, precision: 0.4 } });
    const rec = r.recommendations.find((x) => x.seat === 'c');
    expect(rec).toMatchObject({ swap_candidate: true, eligible: true });
    expect(rec?.reasons).toEqual(['0 unique owed over 25 adjudicated round(s) ratified', 'precision 40% is below 50%']);
    expect(rec?.evidence?.rounds).toHaveLength(25);
    expect(rec?.evidence?.findings).toHaveLength(25);
    expect(rec?.evidence?.findings.filter((f) => f.refuted && f.unique)).toHaveLength(15);
    expect(rec?.evidence?.rounds[0]).toMatchObject({ ratified: true, adjudicated: true, said: 'NEEDS-WORK', verdict: 'SHIP', target: 'acme/widget#1' });
    for (const seat of ['a', 'b']) expect(r.recommendations.find((x) => x.seat === seat)?.swap_candidate).toBe(false);
    w.close();
  });

  it('does not flag the same seat over 24 rounds (below N)', () => {
    const w = lowPrecisionSeat(24);
    const rec = report(w, { thresholds: N25 }).recommendations.find((x) => x.seat === 'c');
    expect(seatCard(report(w, { thresholds: N25 }), 'c')).toMatchObject({ unique: { owed: 0 }, findings: { precision: 10 / 24 } });
    expect(rec).toMatchObject({ swap_candidate: false, eligible: false, evidence: null });
    expect(rec?.reasons).toEqual(['24 adjudicated round(s) ratified, below the 25 the flag needs']);
    // The default N (20) is reached by the same 24 rounds.
    expect(report(w).recommendations.find((x) => x.seat === 'c')?.swap_candidate).toBe(true);
    w.close();
  });

  it('takes N, P and R from the thresholds', () => {
    const w = lowPrecisionSeat(10);
    const custom = thresholdsOf({ swap_min_ratified_rounds: 10, swap_precision_below: 0.5, swap_ratified_rate_below: 0.8 }, 'config');
    expect(report(w, { thresholds: custom }).recommendations.find((x) => x.seat === 'c')?.swap_candidate).toBe(true);
    const lenient = thresholdsOf({ swap_min_ratified_rounds: 10, swap_precision_below: 0.4, swap_ratified_rate_below: 0.8 }, 'config');
    expect(report(w, { thresholds: lenient }).recommendations.find((x) => x.seat === 'c')?.swap_candidate).toBe(false);
    w.close();
  });

  it('does not flag a seat with a unique owed finding, whatever its precision', () => {
    const w = lowPrecisionSeat(25);
    w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'owed', by: ['c'] }] });
    const rec = report(w).recommendations.find((x) => x.seat === 'c');
    expect(rec?.swap_candidate).toBe(false);
    expect(rec?.reasons[0]).toBe('1 unique owed finding(s): it found what no other seat did');
    w.close();
  });

  it('counts N in adjudicated rounds the seat ratified in, not in rounds it was seated in', () => {
    const w = statsStore();
    for (let i = 0; i < 19; i++) w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'refuted', by: ['c'] }] });
    for (let i = 0; i < 6; i++) w.round({ legs: [{ seat: 'a', occ: OCC.a }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c, status: 'FAIL', failure: 'timeout' }] });
    const r = report(w);
    expect(seatCard(r, 'c')).toMatchObject({ rounds_seated: 25, adjudicated_ratified: 19, findings: { precision: 0 } });
    expect(r.recommendations.find((x) => x.seat === 'c')).toMatchObject({ swap_candidate: false, eligible: false });
    w.close();
  });

  it('flags a seat whose ratified rate is below R, and not one whose precision is n/a and rate is fine', () => {
    const w = statsStore();
    for (let i = 0; i < 20; i++) w.round({ legs: three() });
    for (let i = 0; i < 6; i++) w.round({ status: 'failed', legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'usage_limit' }, { seat: 'b', occ: OCC.b, status: 'FAIL', failure: 'auth' }, { seat: 'c', occ: OCC.c }] });
    const r = report(w);
    // a and b: 20 of 26 ratified (76.9%) with nothing raised (precision n/a): flagged by the rate.
    const a = r.recommendations.find((x) => x.seat === 'a');
    expect(a?.swap_candidate).toBe(true);
    expect(a?.reasons).toEqual(['0 unique owed over 20 adjudicated round(s) ratified', 'ratified rate 76.9% is below 80%']);
    expect(a?.evidence?.rounds.filter((e) => !e.ratified).map((e) => e.said)).toEqual(Array(6).fill('not ratified: primary 1 FAIL usage_limit'));
    // c: 26 of 26 ratified, nothing raised: precision n/a is not below P.
    const c = r.recommendations.find((x) => x.seat === 'c');
    expect(c?.swap_candidate).toBe(false);
    expect(c?.reasons).toEqual(['precision n/a and ratified rate 100% are at or above the thresholds']);
    w.close();
  });

  it('does not flag a seat exactly at R or exactly at P: "below" is strict', () => {
    const w = statsStore();
    // a: 20 of 25 ratified (exactly 80%), nothing raised. c: 10 refuted and 10 follow-ups of its own (exactly 50%).
    for (let i = 0; i < 20; i++) w.round({ legs: three({ c: 'SHIP-WITH-FIXES' }), findings: [{ outcome: i % 2 === 0 ? 'refuted' : 'follow-up', by: ['c'] }] });
    for (let i = 0; i < 5; i++) w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'usage_limit' }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    const r = report(w);
    expect(seatCard(r, 'a')).toMatchObject({ ratified_rate: 0.8, adjudicated_ratified: 20, unique: { owed: 0 }, findings: { precision: null } });
    expect(seatCard(r, 'c')).toMatchObject({ unique: { owed: 0 }, findings: { precision: 0.5 } });
    for (const seat of ['a', 'c']) {
      const rec = r.recommendations.find((x) => x.seat === seat);
      expect(rec, seat).toMatchObject({ swap_candidate: false, eligible: true, evidence: null });
    }
    w.close();
  });
});

describe('stats: filters and the report shape', () => {
  it('--seat and --occupant choose rows, never the data a metric reads', () => {
    const w = statsStore();
    w.round({ legs: three({ c: 'NEEDS-WORK' }), findings: [{ outcome: 'owed', by: ['c'] }] });
    w.round({ legs: [{ seat: 'a', occ: OCC.a, status: 'FAIL', failure: 'usage_limit' }, { seat: 'a', occ: OCC.af, role: 'fallback' }, { seat: 'b', occ: OCC.b }, { seat: 'c', occ: OCC.c }] });
    const only = report(w, { seat: 'c' });
    expect(only.seats.map((s) => s.seat)).toEqual(['c']);
    expect(only.occupants.map((o) => o.occupant.key)).toEqual([OCC.c]);
    expect(only.recommendations.map((x) => x.seat)).toEqual(['c']);
    // The drop-one counterfactual still sees the other seats' legs.
    expect(seatCard(only, 'c').drop_one.flipped_to_ship).toBe(1);
    expect(only.agreement.seats.map((p) => `${p.a}-${p.b}`)).toEqual(['a-c', 'b-c']);
    const occ = report(w, { occupant: 'kiro:gpt-5.6-sol' });
    expect(occ.occupants.map((o) => o.occupant.key)).toEqual([OCC.af]);
    expect(occ.seats.map((s) => s.seat)).toEqual(['a']);
    expect(report(w, { occupant: 'kiro:gpt-5.6-sol:low' }).occupants).toEqual([]);
    w.close();
  });

  it('matches an occupant spec with or without effort, a model id holding a colon included', () => {
    const o = { backend: 'opencode', model: 'ollama/llama3:8b', effort: 'high' };
    expect(occupantMatches(o, 'opencode:ollama/llama3:8b')).toBe(true);
    expect(occupantMatches(o, 'opencode:ollama/llama3:8b:high')).toBe(true);
    expect(occupantMatches(o, 'opencode:ollama/llama3:8b:low')).toBe(false);
    expect(occupantMatches(o, 'opencode:ollama/llama3')).toBe(false);
    expect(occupantMatches({ backend: 'kiro', model: 'deepseek-3.2', effort: null }, 'kiro:deepseek-3.2')).toBe(true);
    expect(occupantMatches({ backend: 'kiro', model: 'deepseek-3.2', effort: null }, 'kiro:deepseek-3.2:high')).toBe(false);
    expect(occupantMatches({ backend: 'kiro', model: 'deepseek-3.2', effort: null }, 'codex:deepseek-3.2')).toBe(false);
  });

  it('is versioned JSON with a stable set of keys', () => {
    const w = statsStore();
    w.round({ legs: three(), adjudicatorUsd: 0.5 });
    w.seatTest({ occupant: { backend: 'claude', model: 'claude-haiku-5-5', effort: 'low' }, ratified: true, status: 'PASS', verdict: 'NEEDS-WORK', defects: { found: ['D1'], total: 3 }, cost_usd: 0.02, duration_ms: 1000 });
    const r = JSON.parse(JSON.stringify(report(w))) as Record<string, unknown>;
    expect(r['schema']).toBe('sabotage-council.stats');
    expect(r['version']).toBe(1);
    expect(Object.keys(r)).toEqual(['schema', 'version', 'generated_at', 'window', 'filters', 'thresholds', 'message', 'notes', 'seats', 'occupants', 'agreement', 'recommendations', 'seat_tests']);
    const seat = (r['seats'] as Array<Record<string, unknown>>)[0] ?? {};
    expect(Object.keys(seat).sort()).toEqual(
      ['adjudicated_ratified', 'cost', 'dissent', 'drop_one', 'failures', 'findings', 'occupants', 'ratified_rate', 'rounds_ratified', 'rounds_seated', 'seat', 'unique', 'verdicts'].sort(),
    );
    expect(Object.keys(seat['cost'] as object).sort()).toEqual(
      ['credits', 'credits_per_adopted', 'duration_ms_p50', 'duration_ms_p90', 'legs_with_credits', 'legs_with_usd', 'quota_pct_last', 'quota_pct_max', 'usd', 'usd_per_adopted'].sort(),
    );
    expect(r['window']).toMatchObject({ adjudicator_usd: 0.5 });
    expect(r['seat_tests']).toEqual([
      expect.objectContaining({ backend: 'claude', model: 'claude-haiku-5-5', effort: 'low', ratified: true, defects_found: ['D1'], defects_total: 3, cost_usd: 0.02 }),
    ]);
    // A seat test is never a round: nothing above counts it.
    expect((r['window'] as { rounds: { total: number } }).rounds.total).toBe(1);
    w.close();
  });
});
