import { describe, expect, it } from 'vitest';
import {
  effectiveLegVerdict,
  findingIdOf,
  legsClear,
  normalizeTitle,
  owedEligible,
  validateAdjudication,
  validateAdjudicationText,
  type AdjudicationContext,
} from '../src/adjudicate/index.js';

/*
 * The plan 7.3 validator: one rejection per class of bad ADJUDICATION.json, each named by its error class, and the
 * effective-verdict rules of plan 3.2.
 */

const TARGET = 'diff:github.com/o/widget:feature';
const HEAD = 'a'.repeat(40);
const NONCE = '0123456789ab';
const PATH = 'widget/calc/rangesum.py';
const id = (title: string, path: string | null = PATH): string => findingIdOf(TARGET, path, title);
const F1 = id('range_sum drops the end element');
const F2 = id('mean divides by zero');
const ITEM = id('an earlier owed row');

function ctx(over: Partial<AdjudicationContext> = {}): AdjudicationContext {
  return {
    roundNo: 2,
    nonce: NONCE,
    headSha: HEAD,
    mode: 'diff',
    rule: 'serious',
    targetKey: TARGET,
    legs: [
      { seat: 'a', verdictRaw: 'NEEDS-WORK', findings: [{ id: 'F1', severity: 'HIGH' }, { id: 'F2', severity: 'LOW' }] },
      { seat: 'b', verdictRaw: 'SHIP-WITH-FIXES', findings: [{ id: 'F1', severity: 'MEDIUM' }] },
      { seat: 'c', verdictRaw: 'SHIP', findings: null },
    ],
    earlierItems: [{ id: ITEM, severity: 'HIGH', kind: 'finding', closedContext: false }],
    humanAsks: [],
    knownFindingIds: new Set([ITEM]),
    ...over,
  };
}

type Adj = Record<string, unknown> & { findings: Array<Record<string, unknown>> };

function valid(): Adj {
  return {
    nonce: NONCE,
    head_sha: HEAD,
    round: 2,
    verdict: 'NEEDS-WORK',
    approve: false,
    needs_ruling: false,
    reason: 'one owed defect',
    findings: [
      {
        id: F1,
        title: 'range_sum drops the end element',
        path: PATH,
        line: 11,
        severity: 'HIGH',
        outcome: 'owed',
        owner: 'this',
        proof: 'widget/calc/rangesum.py:11 range(start, end)',
        kind: 'finding',
        raised_by: [
          { seat: 'a', leg_finding: 'F1', severity: 'HIGH' },
          { seat: 'b', leg_finding: 'F1', severity: 'MEDIUM' },
        ],
        same_as: null,
        closes_item: null,
      },
      {
        id: F2,
        title: 'mean divides by zero',
        path: PATH,
        line: 20,
        severity: 'LOW',
        outcome: 'follow-up',
        owner: 'this',
        proof: 'widget/calc/rangesum.py:20',
        kind: 'finding',
        raised_by: [
          { seat: 'a', leg_finding: 'F2', severity: 'LOW' },
          { seat: 'c', leg_finding: 'X1', severity: 'LOW' },
        ],
        same_as: null,
        closes_item: null,
      },
    ],
    unmapped: [],
    earlier_items: [{ source: ITEM, status: 'closed', evidence: 'widget/calc/rangesum.py:3 now inclusive', fix_row: null }],
    human_asks: [],
    leg_verdicts: [
      { seat: 'a', raw: 'NEEDS-WORK', effective: 'NEEDS-WORK' },
      { seat: 'b', raw: 'SHIP-WITH-FIXES', effective: 'SHIP-WITH-FIXES' },
      { seat: 'c', raw: 'SHIP', effective: 'SHIP' },
    ],
    not_verified: [],
    followups: [F2],
    summary: 'One owed defect, one follow-up.',
    blocker_call: 'Fix the loop bound.',
  };
}

const f = (a: Adj, i: number): Record<string, unknown> => a.findings[i]!;

function errorsOf(a: unknown, c: AdjudicationContext = ctx()): string[] {
  const r = validateAdjudication(a, c);
  return r.ok ? [] : r.errors;
}

/** One case per rejection: [class, description, edit, the context (optional), expected text in an error]. */
const CASES: Array<[string, string, (a: Adj) => void, Partial<AdjudicationContext> | null, string]> = [
  ['schema', 'a required field is missing', (a) => delete a['verdict'], null, '[schema] verdict'],
  ['schema', 'an unknown key', (a) => (a['verdikt'] = 'SHIP'), null, 'unknown key(s) verdikt'],
  ['schema', 'a verdict outside the three', (a) => (a['verdict'] = 'LGTM'), null, '[schema] verdict'],
  ['schema', 'an outcome outside the six', (a) => (f(a, 0)['outcome'] = 'maybe'), null, '[schema] findings[0].outcome'],
  ['schema', 'a malformed finding id', (a) => (f(a, 0)['id'] = 'C1'), null, '[schema] findings[0].id'],
  ['schema', 'an empty summary', (a) => (a['summary'] = ' '), null, '[schema] summary'],
  ['identity', 'the wrong nonce', (a) => (a['nonce'] = 'ffffffffffff'), null, '[identity] nonce ffffffffffff'],
  ['identity', 'the wrong head', (a) => (a['head_sha'] = 'b'.repeat(40)), null, "[identity] head_sha"],
  ['identity', 'the wrong round', (a) => (a['round'] = 3), null, '[identity] round 3'],
  ['ids', 'a duplicate finding id', (a) => a.findings.push({ ...f(a, 1), raised_by: [] }), null, `[ids] finding id ${F2} appears twice`],
  ['ids', 'an id that is not the stable hash', (a) => (f(a, 0)['title'] = 'retitled'), null, `must have the stable id ${id('retitled')}`],
  ['ids', 'same_as to an unknown finding', (a) => (f(a, 0)['same_as'] = 'f_000000000000'), null, 'same_as f_000000000000 is not a finding of an earlier round'],
  ['ids', 'closes_item to an unknown item', (a) => (f(a, 0)['closes_item'] = 'R9'), null, 'closes_item R9 is not an earlier item'],
  ['attribution', 'a leg finding left unmapped', (a) => (f(a, 1)['raised_by'] = [{ seat: 'c', leg_finding: 'X1', severity: 'LOW' }]), null, "seat a's finding F2 is not mapped"],
  ['attribution', 'a leg finding mapped twice', (a) => (f(a, 1)['raised_by'] as unknown[]).push({ seat: 'a', leg_finding: 'F1', severity: 'HIGH' }), null, 'a F1 is mapped twice'],
  ['attribution', 'a duplicate in unmapped', (a) => (a['unmapped'] = [{ seat: 'b', leg_finding: 'F1', reason: 'dup' }]), null, 'b F1 is mapped twice'],
  ['attribution', 'a leg finding the seat never raised', (a) => (f(a, 0)['raised_by'] as unknown[]).push({ seat: 'b', leg_finding: 'F9', severity: 'LOW' }), null, 'seat b raised no finding F9'],
  ['attribution', 'a seat with no ratified leg', (a) => (f(a, 0)['raised_by'] as unknown[]).push({ seat: 'd', leg_finding: 'F1', severity: 'HIGH' }), null, 'seat d has no ratified leg'],
  ['attribution', 'unmapped with no reason', (a) => {
    f(a, 1)['raised_by'] = [{ seat: 'c', leg_finding: 'X1', severity: 'LOW' }];
    a['unmapped'] = [{ seat: 'a', leg_finding: 'F2', reason: ' ' }];
  }, null, 'unmapped a F2 has no reason'],
  ['attribution', 'a finding raised by nobody', (a) => {
    a.findings.push({ ...f(a, 1), id: id('orphan'), title: 'orphan', outcome: 'noted', raised_by: [] });
  }, null, `finding ${id('orphan')} names no seat`],
  ['attribution', "raised_by changing the seat's own severity", (a) => ((f(a, 0)['raised_by'] as Array<Record<string, unknown>>)[1]!['severity'] = 'HIGH'), null, 'was raised at MEDIUM, not HIGH'],
  ['verdict', 'NEEDS-WORK with 0 owed', (a) => (f(a, 0)['outcome'] = 'follow-up'), null, '[verdict] NEEDS-WORK with 0 owed rows'],
  ['verdict', 'SHIP with an owed row', (a) => (a['verdict'] = 'SHIP'), null, '[verdict] SHIP with 1 owed row(s)'],
  ['verdict', 'a ruling without needs_ruling', (a) => (f(a, 1)['outcome'] = 'ruling'), null, 'are rulings, so needs_ruling must be true'],
  ['severity', 'an owed NIT', (a) => {
    f(a, 1)['severity'] = 'NIT';
    f(a, 1)['outcome'] = 'owed';
    a['followups'] = [];
  }, null, `[severity] finding ${F2} is owed at NIT`],
  ['owner', 'an owed row owned by another repository', (a) => (f(a, 0)['owner'] = 'other-org/infra'), null, '[owner] finding'],
  ['round-rule', 'an owed MEDIUM in round 4', (a) => {
    a['round'] = 4;
    f(a, 0)['severity'] = 'MEDIUM';
  }, { roundNo: 4, rule: 'high-only' }, `[round-rule] finding ${F1} is owed at MEDIUM in round 4`],
  ['effective', 'a ratified leg with no entry', (a) => (a['leg_verdicts'] as unknown[]).pop(), null, 'leg_verdicts has no entry for seat c'],
  ['effective', 'a seat listed twice', (a) => (a['leg_verdicts'] as unknown[]).push({ seat: 'c', raw: 'SHIP', effective: 'SHIP' }), null, 'lists seat c twice'],
  ['effective', "a raw verdict that is not the leg's", (a) => ((a['leg_verdicts'] as Array<Record<string, unknown>>)[2]!['raw'] = 'NEEDS-WORK'), null, "raw verdict NEEDS-WORK is not the leg's own (SHIP)"],
  ['effective', 'a NEEDS-WORK held with nothing blocking', (a) => {
    f(a, 0)['outcome'] = 'refuted';
    f(a, 0)['proof'] = 'widget/calc/rangesum.py:11 is range(start, end + 1)';
    a['verdict'] = 'SHIP-WITH-FIXES';
  }, null, 'effective verdict NEEDS-WORK should be SHIP-WITH-FIXES'],
  ['coverage', 'an earlier item with no row', (a) => (a['earlier_items'] = []), null, `[coverage] earlier item ${ITEM} has no row`],
  ['coverage', 'a row for an unknown item', (a) => (a['earlier_items'] as unknown[]).push({ source: 'R7', status: 'open', evidence: '', fix_row: null }), null, 'row R7 is not an earlier item'],
  ['coverage', 'two rows for one item', (a) => (a['earlier_items'] as unknown[]).push({ source: ITEM, status: 'closed', evidence: '', fix_row: null }), null, 'has two rows'],
  ['coverage', 'an open owed-eligible item with no owed fix_row', (a) => ((a['earlier_items'] as Array<Record<string, unknown>>)[0]!['status'] = 'half-closed'), null, 'is half-closed and owed under this round'],
  ['coverage', 'a fix_row naming no finding', (a) => ((a['earlier_items'] as Array<Record<string, unknown>>)[0]!['fix_row'] = 'f_000000000000'), null, 'fix_row f_000000000000 is not a finding'],
  ['human-asks', 'an ask with no row', () => undefined, { humanAsks: ['Please add a test.'] }, '[human-asks] ask H1 has no human_asks row'],
  ['human-asks', 'a human_ask row when there is no change request', (a) => a.findings.push({ ...f(a, 1), id: id('ask', null), title: 'ask', path: null, kind: 'human_ask', outcome: 'noted', raised_by: [] }), null, 'is a human_ask, but this round has no change request'],
  ['human-asks', 'an open ask whose row is not owed', (a) => {
    a.findings.push({ ...f(a, 1), id: id('add a test', null), title: 'add a test', path: null, line: null, kind: 'human_ask', outcome: 'noted', raised_by: [] });
    a['human_asks'] = [{ id: 'H1', status: 'open', evidence: 'no test yet', fix_row: id('add a test', null) }];
  }, { humanAsks: ['Please add a test.'] }, 'ask H1 is open, so its row'],
  ['human-asks', 'an ask row naming an ordinary finding', (a) => (a['human_asks'] = [{ id: 'H1', status: 'open', evidence: '', fix_row: F1 }]), { humanAsks: ['Please add a test.'] }, 'fix_row must name its kind "human_ask" finding row'],
  ['refutation', 'a refutation without proof', (a) => {
    f(a, 1)['outcome'] = 'refuted';
    f(a, 1)['proof'] = 'no';
    a['followups'] = [];
  }, null, `[refutation] finding ${F2} is refuted without proof`],
  ['refutation', 'a majority-raised owed-eligible finding refuted in auto without a ruling', (a) => {
    f(a, 0)['outcome'] = 'refuted';
    a['verdict'] = 'SHIP-WITH-FIXES';
    a['leg_verdicts'] = [
      { seat: 'a', raw: 'NEEDS-WORK', effective: 'SHIP-WITH-FIXES' },
      { seat: 'b', raw: 'SHIP-WITH-FIXES', effective: 'SHIP-WITH-FIXES' },
      { seat: 'c', raw: 'SHIP', effective: 'SHIP' },
    ];
  }, { mode: 'auto' }, 'in auto that is a ruling'],
  ['approval', 'approve while a ruling is needed', (a) => {
    a['approve'] = true;
    a['needs_ruling'] = true;
  }, null, '[approval] approve is true while a ruling is needed'],
  ['approval', 'approve with an owed row', (a) => (a['approve'] = true), null, '[approval] approve is true with verdict NEEDS-WORK and 1 owed row(s)'],
  ['approval', 'approve with the legs not clear (one SHIP, two legs with no verdict)', (a) => {
    f(a, 0)['outcome'] = 'follow-up';
    a['followups'] = [F1, F2];
    a['verdict'] = 'SHIP-WITH-FIXES';
    a['approve'] = true;
    a['leg_verdicts'] = [
      { seat: 'a', raw: 'none', effective: 'none' },
      { seat: 'b', raw: 'none', effective: 'none' },
      { seat: 'c', raw: 'SHIP', effective: 'SHIP' },
    ];
  }, {
    legs: [
      { seat: 'a', verdictRaw: 'none', findings: [{ id: 'F1', severity: 'HIGH' }, { id: 'F2', severity: 'LOW' }] },
      { seat: 'b', verdictRaw: 'none', findings: [{ id: 'F1', severity: 'MEDIUM' }] },
      { seat: 'c', verdictRaw: 'SHIP', findings: null },
    ],
  }, '[approval] approve is true but the legs are not clear'],
  ['followups', 'a follow-up missing from followups', (a) => (a['followups'] = []), null, `[followups] follow-up ${F2} is missing`],
  ['followups', 'an owed row in followups', (a) => (a['followups'] = [F2, F1]), null, `followups lists ${F1}, whose outcome is owed`],
  ['followups', 'an unknown id in followups', (a) => (a['followups'] = [F2, 'f_000000000000']), null, 'followups lists f_000000000000, which is not a finding'],
];

describe('adjudicate: plan 7.3 validator', () => {
  it('accepts the valid adjudication, and extracts the leg whose block was missing', () => {
    const r = validateAdjudication(valid(), ctx());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.effective).toMatchObject({ verdict: 'NEEDS-WORK', owed: 1, legsClear: false, majorityOverrides: [] });
    expect(r.effective.extracted).toEqual([{ seat: 'c', legFinding: 'X1', severity: 'LOW', findingId: F2 }]);
  });

  it.each(CASES)('[%s] rejects %s', (_cls, _what, edit, over, expected) => {
    const a = valid();
    edit(a);
    const errors = errorsOf(a, ctx(over ?? {}));
    expect(errors.join('\n')).toContain(expected);
    expect(errors.every((e) => /^\[[a-z-]+\] /.test(e))).toBe(true);
  });

  it('covers every check class with at least one rejection', () => {
    const classes = new Set(CASES.map((c) => c[0]));
    expect([...classes].sort()).toEqual(['approval', 'attribution', 'coverage', 'effective', 'followups', 'human-asks', 'identity', 'ids', 'owner', 'refutation', 'round-rule', 'schema', 'severity', 'verdict'].sort());
  });

  it('asks no row for a closed-context item (plan 3.5)', () => {
    const a = valid();
    a['earlier_items'] = [];
    expect(errorsOf(a, ctx({ earlierItems: [{ id: ITEM, severity: 'HIGH', kind: 'finding', closedContext: true }] }))).toEqual([]);
  });

  it('rejects text that is not JSON', () => {
    const r = validateAdjudicationText('{not json', ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/^\[json\] not valid JSON/);
  });

  it('rejects approve over a ruling row, whatever needs_ruling says', () => {
    const a = valid();
    f(a, 0)['outcome'] = 'ruling';
    a['needs_ruling'] = false;
    a['approve'] = true;
    a['verdict'] = 'SHIP-WITH-FIXES';
    expect(errorsOf(a).join('\n')).toContain('[approval] approve is true while a ruling is needed');
  });

  it('accepts approve with nits only when the legs are clear, and reads SWF with 0 owed as SHIP', () => {
    const a = valid();
    f(a, 0)['outcome'] = 'follow-up';
    a['followups'] = [F1, F2];
    a['verdict'] = 'SHIP-WITH-FIXES';
    a['approve'] = true;
    a['leg_verdicts'] = [
      { seat: 'a', raw: 'NEEDS-WORK', effective: 'SHIP-WITH-FIXES' },
      { seat: 'b', raw: 'SHIP-WITH-FIXES', effective: 'SHIP-WITH-FIXES' },
      { seat: 'c', raw: 'SHIP', effective: 'SHIP' },
    ];
    const r = validateAdjudication(a, ctx());
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.effective).toMatchObject({ verdict: 'SHIP', owed: 0, legsClear: true });
  });

  it('rejects approve on a solo review even with nothing owed', () => {
    const a = valid();
    a.findings = [];
    a['followups'] = [];
    a['verdict'] = 'SHIP';
    a['approve'] = true;
    a['unmapped'] = [];
    a['leg_verdicts'] = [{ seat: 'c', raw: 'SHIP', effective: 'SHIP' }];
    const solo = ctx({ legs: [{ seat: 'c', verdictRaw: 'SHIP', findings: [] }] });
    expect(errorsOf(a, solo)).toContain('[approval] approve is true on a solo review: a solo review never approves (plan 3.1 step 8)');
    a['approve'] = false;
    expect(errorsOf(a, solo)).toEqual([]);
  });

  it('warns, in an interactive round, when a majority-raised owed-eligible finding is refuted', () => {
    const a = valid();
    f(a, 0)['outcome'] = 'refuted';
    a['verdict'] = 'SHIP-WITH-FIXES';
    a['leg_verdicts'] = [
      { seat: 'a', raw: 'NEEDS-WORK', effective: 'SHIP-WITH-FIXES' },
      { seat: 'b', raw: 'SHIP-WITH-FIXES', effective: 'SHIP-WITH-FIXES' },
      { seat: 'c', raw: 'SHIP', effective: 'SHIP' },
    ];
    const r = validateAdjudication(a, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.effective.majorityOverrides).toEqual([F1]);
      expect(r.warnings[0]).toContain('show the user the proof before acting on it');
    }
  });

  it('accepts human asks: one human_ask row each, owed while open, even in round 4 (Q7)', () => {
    const a = valid();
    const ask = id('add a test', null);
    a['round'] = 4;
    f(a, 0)['severity'] = 'HIGH';
    a.findings.push({ ...f(a, 1), id: ask, title: 'add a test', path: null, line: null, severity: 'LOW', kind: 'human_ask', outcome: 'owed', raised_by: [] });
    a['human_asks'] = [{ id: 'H1', status: 'open', evidence: 'no test yet', fix_row: ask }];
    const r = validateAdjudication(a, ctx({ roundNo: 4, rule: 'high-only', humanAsks: ['Please add a test.'] }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});

describe('adjudicate: plan 3.2 effective verdicts and ids', () => {
  it('a NEEDS-WORK holds only while one of its own findings blocks', () => {
    expect(effectiveLegVerdict('NEEDS-WORK', [{ severity: 'HIGH', outcome: 'owed', kind: 'finding' }], 'serious')).toBe('NEEDS-WORK');
    expect(effectiveLegVerdict('NEEDS-WORK', [{ severity: 'HIGH', outcome: 'ruling', kind: 'finding' }], 'serious')).toBe('NEEDS-WORK');
    expect(effectiveLegVerdict('NEEDS-WORK', [{ severity: 'MEDIUM', outcome: 'ruling', kind: 'finding' }], 'high-only')).toBe('SHIP-WITH-FIXES');
    expect(effectiveLegVerdict('NEEDS-WORK', [{ severity: 'HIGH', outcome: 'refuted', kind: 'finding' }], 'round-1')).toBe('SHIP-WITH-FIXES');
    expect(effectiveLegVerdict('NEEDS-WORK', [], 'round-1')).toBe('SHIP-WITH-FIXES');
    expect(effectiveLegVerdict('SHIP', [{ severity: 'HIGH', outcome: 'owed', kind: 'finding' }], 'round-1')).toBe('SHIP');
    expect(effectiveLegVerdict('none', [], 'round-1')).toBe('none');
  });

  it('legs clear: two exact SHIP, or two SHIP/SWF with no NEEDS-WORK', () => {
    expect(legsClear(['SHIP', 'SHIP', 'NEEDS-WORK'])).toBe(true);
    expect(legsClear(['SHIP', 'SHIP-WITH-FIXES', 'NEEDS-WORK'])).toBe(false);
    expect(legsClear(['SHIP-WITH-FIXES', 'SHIP-WITH-FIXES'])).toBe(true);
    expect(legsClear(['SHIP', 'none'])).toBe(false);
  });

  it('owed-eligible: anything but a NIT, from round 4 only HIGH, a human ask always', () => {
    expect(owedEligible({ severity: 'LOW', kind: 'finding' }, 'serious')).toBe(true);
    expect(owedEligible({ severity: 'NIT', kind: 'finding' }, 'round-1')).toBe(false);
    expect(owedEligible({ severity: 'MEDIUM', kind: 'finding' }, 'high-only')).toBe(false);
    expect(owedEligible({ severity: 'NIT', kind: 'human_ask' }, 'high-only')).toBe(true);
  });

  it('finding ids are stable across spelling noise and differ by target and path', () => {
    expect(normalizeTitle('  Range_Sum  drops\tthe END.  ')).toBe('range_sum drops the end');
    expect(findingIdOf(TARGET, PATH, 'Range sum drops the end.')).toBe(findingIdOf(TARGET, PATH, 'range  sum drops the end'));
    expect(findingIdOf(TARGET, PATH, 'x')).not.toBe(findingIdOf('plan:other', PATH, 'x'));
    expect(findingIdOf(TARGET, PATH, 'x')).not.toBe(findingIdOf(TARGET, null, 'x'));
    expect(findingIdOf(TARGET, PATH, 'x')).toMatch(/^f_[0-9a-f]{12}$/);
  });
});
