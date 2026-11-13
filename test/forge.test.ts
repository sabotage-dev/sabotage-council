import { describe, expect, it } from 'vitest';
import { judgeCi, type CiState } from '../src/forge/ci.js';
import { changeRequestAsks, countRounds, reviewItems, userChangeRequest, type Credit, type MarkerConfig } from '../src/forge/count.js';
import { decideEvent, type EventFacts } from '../src/forge/events.js';
import { firstLine, identityMarker, parseMarker, roundMarker, stripWrapper } from '../src/forge/markers.js';
import { parsePrRef, type Review, type ReviewComment } from '../src/forge/pr.js';
import { BODY_MAX_BYTES, renderBody, validateBody, type CouncilBody } from '../src/forge/render.js';
import { FULLWIDTH_AT, FULLWIDTH_HASH, neutralize, textProblems } from '../src/forge/text.js';
import type { Adjudication } from '../src/adjudicate/schema.js';

/*
 * P6's pure rules: the round count of plan 3.6 (with N14, N19, N20), the user's change request (3.8), the earlier
 * reviews carried as items (3.5), the CI gate, the event mapping of 3.7 (every row, N2, N3, N10), and the body
 * renderer and its validation.
 */

const REF = { owner: 'acme', repo: 'widget', number: 7 };
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const CFG: MarkerConfig = { login: 'me', council_logins: ['council-bot'], markers_also_count: [] };

let nextId = 100;
function review(p: Partial<Review> & { at: string; head: string }): Review {
  return { id: p.id ?? nextId++, login: p.login ?? 'me', state: p.state ?? 'COMMENTED', commitId: p.head, submittedAt: p.at, body: p.body ?? '' };
}
const mark = (n: number, head: string, ref = REF): string => `${roundMarker(ref, n, head)}\n\n**Verdict: SHIP, 0 owed.**`;
const at = (minute: number): string => `2026-11-12T10:${String(minute).padStart(2, '0')}:00Z`;
const count = (reviews: Review[], head: string, credits: Credit[] = [], cfg = CFG) => countRounds({ ref: REF, head, reviews, credits, cfg });

describe('pr targets', () => {
  it('parses owner/repo#num and a pull URL, and refuses anything else', () => {
    expect(parsePrRef('acme/widget#7')).toEqual(REF);
    expect(parsePrRef('https://github.com/acme/widget/pull/7/files')).toEqual(REF);
    for (const bad of ['acme/widget', 'acme#7', 'https://example.com/acme/widget/pull/7', '../x/y#1', 'acme/widget#0', 'a/b#1 2']) {
      expect(() => parsePrRef(bad), bad).toThrow(/a pr target is/);
    }
  });
});

describe('markers (plan 3.6 step 2)', () => {
  it('reads the first non-empty line, with one heading or emphasis wrapper stripped', () => {
    expect(firstLine('\n\n  hello  \nworld')).toBe('hello');
    expect(stripWrapper('## x y ##')).toBe('x y');
    expect(stripWrapper('**x**')).toBe('x');
    expect(stripWrapper('_x_')).toBe('x');
    expect(stripWrapper('**# x**')).toBe('# x');
    const line = roundMarker(REF, 2, A);
    for (const body of [line, `# ${line}`, `**${line}**`, `\n\n__${line}__\nmore`]) expect(parseMarker(body), body).toEqual({ kind: 'round', round: 2, target: 'acme/widget#7', sha: 'aaaaaaa' });
    expect(parseMarker(`> ${line}`)).toBeNull();
    expect(parseMarker(`see ${line}`)).toBeNull();
    expect(parseMarker(identityMarker(REF, A))).toEqual({ kind: 'identity', target: 'acme/widget#7', sha: 'aaaaaaa' });
  });

  it('matches a markers_also_count pattern at the start, with its round and stated sha when present', () => {
    expect(parseMarker('Council round 3 on widget#7 at abc1234', ['Council round'])).toEqual({ kind: 'also', pattern: 'Council round', round: 3, sha: 'abc1234' });
    expect(parseMarker('council round, nothing else', ['Council round'])).toEqual({ kind: 'also', pattern: 'Council round', round: null, sha: null });
    expect(parseMarker('A Council round 3', ['Council round'])).toBeNull();
  });
});

describe('round count (plan 3.6)', () => {
  it('two councils on one head make one round', () => {
    const reviews = [review({ at: at(1), head: A, body: mark(1, A) }), review({ at: at(2), head: A, login: 'council-bot', body: mark(1, A) })];
    expect(count(reviews, A)).toMatchObject({ roundNo: 1, count: 1, headCounted: true, baseline: null });
    expect(count(reviews, B)).toMatchObject({ roundNo: 2, baseline: A, headCounted: false });
  });

  it("ignores a stranger's marker review, and logs it", () => {
    const stranger = review({ at: at(1), head: A, login: 'mallory', body: mark(9, A) });
    const r = count([stranger], B);
    expect(r).toMatchObject({ roundNo: 1, count: 0, baseline: null });
    expect(r.ignored).toEqual([{ reviewId: stranger.id, login: 'mallory', why: 'a marker review by a login outside github.login and council_logins' }]);
  });

  it('ignores a marker whose sha7 does not match its commit_id, and logs the mismatch', () => {
    const lying = review({ at: at(1), head: A, body: mark(1, B) });
    const r = count([lying], C);
    expect(r.roundNo).toBe(1);
    expect(r.ignored[0]?.why).toContain('commit_id');
    // A markers_also_count line that states another sha is not counted either; one that states none uses commit_id.
    const cfg = { ...CFG, markers_also_count: ['Council round'] };
    expect(count([review({ at: at(1), head: A, body: 'Council round 1 on widget#7 at bbbbbbb' })], C, [], cfg).roundNo).toBe(1);
    expect(count([review({ at: at(1), head: A, body: 'Council round 2' })], C, [], cfg)).toMatchObject({ roundNo: 3, baseline: A });
  });

  it('counts dismissed reviews, skips pending ones, and never counts a marker naming another PR', () => {
    expect(count([review({ at: at(1), head: A, state: 'DISMISSED', body: mark(1, A) })], B).roundNo).toBe(2);
    expect(count([review({ at: '', head: A, state: 'PENDING', body: mark(1, A) })], B).roundNo).toBe(1);
    const other = review({ at: at(1), head: A, body: mark(1, A, { ...REF, number: 8 }) });
    expect(count([other], B)).toMatchObject({ roundNo: 1, ignored: [{ reviewId: other.id, why: expect.stringContaining('acme/widget#8') as unknown }] });
  });

  it('never counts an identity approval, so it never advances the round', () => {
    const r = count([review({ at: at(1), head: A, state: 'APPROVED', body: identityMarker(REF, A) })], B);
    expect(r).toMatchObject({ roundNo: 1, count: 0 });
    expect(r.ignored[0]?.why).toContain('identity');
  });

  it('N14: a hand credit on a head before a round 2 marker gives a new head round 3, not 4', () => {
    const credit: Credit = { reviewId: 1, commitId: A, submittedAt: at(1) };
    const reviews = [review({ at: at(2), head: B, body: mark(2, B) })];
    expect(count(reviews, C, [credit])).toMatchObject({ count: 2, roundNo: 3, baseline: B });
  });

  it('N14: a single marker stating round 1 counts one head (a new head first, then the floor)', () => {
    expect(count([review({ at: at(1), head: A, body: mark(1, A) })], B)).toMatchObject({ count: 1, roundNo: 2 });
  });

  it('a credit and a later round 2 marker on the same head give a new head round 3 (the floor survives de-duplication)', () => {
    const credit: Credit = { reviewId: 1, commitId: A, submittedAt: at(1) };
    const reviews = [review({ at: at(2), head: A, body: mark(2, A) })];
    expect(count(reviews, B, [credit])).toMatchObject({ count: 2, roundNo: 3, baseline: A });
    expect(count(reviews, A, [credit])).toMatchObject({ count: 2, roundNo: 2, headCounted: true });
  });

  it('N19: a credit and a counted marker with one review id keep the marker and its round', () => {
    const r1 = review({ at: at(1), head: A, body: mark(4, A) });
    const r = count([r1], B, [{ reviewId: r1.id, commitId: A, submittedAt: at(1) }]);
    expect(r).toMatchObject({ count: 4, roundNo: 5 });
    expect(r.events).toEqual([expect.objectContaining({ reviewId: r1.id, source: 'review', round: 4 })]);
  });

  it('a credit sits at its own review time, and the baseline is the counted head first seen last (N20)', () => {
    const reviews = [review({ at: at(1), head: A, body: mark(1, A) }), review({ at: at(3), head: B, body: mark(2, B) }), review({ at: at(5), head: A, login: 'council-bot', body: mark(1, A) })];
    // A was reviewed again after B, but B is the head first counted last: the baseline is B.
    expect(count(reviews, C)).toMatchObject({ roundNo: 3, baseline: B });
    // A credit added today for a review submitted before B sits at its own time.
    expect(count(reviews, C, [{ reviewId: 1, commitId: D, submittedAt: at(2) }])).toMatchObject({ roundNo: 4, baseline: B });
    // A same-head re-run keeps its number; the baseline is the newest other counted head.
    expect(count(reviews, B)).toMatchObject({ roundNo: 2, baseline: A });
  });
});

describe("the user's own change request (plan 3.8, 3.9)", () => {
  it('our own marker REQUEST_CHANGES is never a human ask or a hold; an unmarked one by the same login is', () => {
    const marked = review({ at: at(1), head: A, state: 'CHANGES_REQUESTED', body: mark(1, A) });
    expect(userChangeRequest([marked], CFG, B)).toBeNull();
    expect(userChangeRequest([marked], CFG, A)).toBeNull();
    const unmarked = review({ at: at(2), head: A, state: 'CHANGES_REQUESTED', body: 'Please rename x.' });
    expect(userChangeRequest([marked, unmarked], CFG, B)).toEqual({ review: unmarked, onHead: false });
    expect(userChangeRequest([marked, unmarked], CFG, A)).toEqual({ review: unmarked, onHead: true });
    // A later marker review by the same login does not clear it: only the user's own unmarked reviews count.
    const later = review({ at: at(3), head: B, state: 'APPROVED', body: mark(2, B) });
    expect(userChangeRequest([marked, unmarked, later], CFG, B)?.review.id).toBe(unmarked.id);
  });

  it('a later COMMENTED review leaves it standing; a later approval or a dismissal clears it', () => {
    const cr = review({ at: at(1), head: A, state: 'CHANGES_REQUESTED', body: 'x' });
    expect(userChangeRequest([cr, review({ at: at(2), head: A, body: 'just a note' })], CFG, B)?.review.id).toBe(cr.id);
    expect(userChangeRequest([cr, review({ at: at(2), head: B, state: 'APPROVED', body: 'ok' })], CFG, B)).toBeNull();
    expect(userChangeRequest([{ ...cr, state: 'DISMISSED' }], CFG, B)).toBeNull();
    expect(userChangeRequest([{ ...cr, login: 'someone-else' }], CFG, B)).toBeNull();
  });

  it('turns the request into asks: the body, then each inline comment', () => {
    const cr = review({ id: 55, at: at(1), head: A, state: 'CHANGES_REQUESTED', body: 'Two things.' });
    const comments: ReviewComment[] = [
      { id: 1, reviewId: 55, login: 'me', path: 'src/a.ts', line: 3, body: 'Use a map.' },
      { id: 2, reviewId: 56, login: 'me', path: 'src/b.ts', line: 1, body: 'other review' },
      { id: 3, reviewId: 55, login: 'me', path: 'src/c.ts', line: null, body: 'Rename.' },
    ];
    expect(changeRequestAsks(cr, comments)).toEqual(['Two things.', 'src/a.ts:3: Use a map.', 'src/c.ts: Rename.']);
    expect(changeRequestAsks({ ...cr, body: '' }, [])).toEqual(['(review 55 requested changes with no text)']);
  });
});

describe('earlier reviews carried as items (plan 3.5)', () => {
  it("carries the baseline head's council reviews this store did not post, and other reviewers' standing change requests", () => {
    const r1 = review({ at: at(1), head: A, body: mark(1, A) });
    const r2 = review({ at: at(2), head: B, body: mark(2, B) });
    const r3 = review({ at: at(3), head: B, login: 'council-bot', body: mark(2, B) });
    const human = review({ at: at(4), head: B, login: 'alice', state: 'CHANGES_REQUESTED', body: 'Fix the loop.' });
    const cleared = [review({ at: at(1), head: A, login: 'bob', state: 'CHANGES_REQUESTED', body: 'x' }), review({ at: at(5), head: B, login: 'bob', state: 'APPROVED', body: '' })];
    const reviews = [r1, r2, r3, human, ...cleared];
    const c = count(reviews, C);
    const items = reviewItems({ reviews, comments: [{ id: 1, reviewId: human.id, login: 'alice', path: 'x.ts', line: 2, body: 'here' }], count: c, cfg: CFG, ours: new Set([r3.id]) });
    expect(items.map((i) => [i.id, i.kind])).toEqual([
      [`R${r2.id}`, 'council-review'],
      [`R${human.id}`, 'change-request'],
    ]);
    expect(items[1]?.text).toContain('Inline comment on x.ts:2:');
  });
});

describe('the CI gate', () => {
  const ctx = (name: string, result: 'green' | 'red' | 'pending', required = false) => ({ name, result, required });
  it('judges required checks, all checks, or nothing', () => {
    const contexts = [ctx('lint', 'red'), ctx('test', 'green', true)];
    expect(judgeCi('required-checks', contexts).state).toBe('green');
    expect(judgeCi('all', contexts)).toMatchObject({ state: 'red', failing: ['lint'] });
    expect(judgeCi('off', contexts).state).toBe('off');
    expect(judgeCi('required-checks', [ctx('test', 'pending', true)])).toMatchObject({ state: 'pending', pending: ['test'] });
    // A required context the branch rules name that has not reported is pending, never green.
    expect(judgeCi('required-checks', [], ['build'])).toMatchObject({ state: 'pending', pending: ['build (expected, not reported)'] });
    expect(judgeCi('required-checks', [ctx('build', 'red')], ['build'])).toMatchObject({ state: 'red' });
  });
});

const GREEN: CiState = { gate: 'required-checks', state: 'green', failing: [], pending: [], note: '2 check(s) judged' };
const BASE: EventFacts = {
  isAuthor: false,
  identity: false,
  needsRuling: false,
  verdict: 'SHIP',
  owed: 0,
  legsClear: true,
  council: true,
  adjudicatorApprove: true,
  autoApprove: true,
  ci: GREEN,
  ciRedEvent: 'REQUEST_CHANGES',
  tests: { state: 'off', why: '' },
  onHoldList: false,
  userChangeRequest: false,
  identityRecheck: null,
};
const RED: CiState = { ...GREEN, state: 'red', failing: ['test'] };
const PENDING: CiState = { ...GREEN, state: 'pending', pending: ['test'] };
const UNKNOWN: CiState = { ...GREEN, state: 'unknown', note: 'CI could not be read' };

describe('event mapping (plan 3.7, every row)', () => {
  it.each<[string, Partial<EventFacts>, string, number]>([
    ['row 1: the user is the author', { isAuthor: true, verdict: 'NEEDS-WORK', owed: 2 }, 'COMMENT', 1],
    ['row 1 before row 2 (N10)', { isAuthor: true, needsRuling: true }, 'COMMENT', 1],
    ['row 2: a ruling', { needsRuling: true }, 'COMMENT', 2],
    ['row 2 before the identity rows', { identity: true, needsRuling: true }, 'COMMENT', 2],
    ['row 3: identity, all green', { identity: true, verdict: null, legsClear: false, council: false, adjudicatorApprove: false }, 'APPROVE', 3],
    ['row 4: identity, approvals off', { identity: true, autoApprove: false }, 'COMMENT', 4],
    ['row 4: identity, CI red (N3: before the CI-red row)', { identity: true, ci: RED }, 'COMMENT', 4],
    ['row 4: identity, CI pending', { identity: true, ci: PENDING }, 'COMMENT', 4],
    ['row 4: identity, hold-listed', { identity: true, onHoldList: true }, 'COMMENT', 4],
    ['row 4: identity, the user\'s own change request (N2)', { identity: true, userChangeRequest: true }, 'COMMENT', 4],
    ['row 4: identity, the live re-check failed', { identity: true, identityRecheck: 'the approval on #3 is now DISMISSED' }, 'COMMENT', 4],
    ['row 5: approve', {}, 'APPROVE', 5],
    ['row 5: SWF with 0 owed approves', { verdict: 'SHIP-WITH-FIXES' }, 'APPROVE', 5],
    ['row 6: NEEDS-WORK', { verdict: 'NEEDS-WORK', owed: 1, adjudicatorApprove: false }, 'REQUEST_CHANGES', 6],
    ['row 6: owed under SWF', { verdict: 'SHIP-WITH-FIXES', owed: 2, adjudicatorApprove: false }, 'REQUEST_CHANGES', 6],
    ['row 6 before row 7', { verdict: 'NEEDS-WORK', owed: 1, ci: RED }, 'REQUEST_CHANGES', 6],
    ['row 7: CI red', { ci: RED }, 'REQUEST_CHANGES', 7],
    ['row 7: CI red, configured to COMMENT', { ci: RED, ciRedEvent: 'COMMENT' }, 'COMMENT', 7],
    ['row 8: legs not clear', { legsClear: false }, 'COMMENT', 8],
    ['row 8: a solo review', { council: false }, 'COMMENT', 8],
    ['row 8: tests held', { tests: { state: 'held', why: 'not built' } }, 'COMMENT', 8],
    ['row 8: tests failed', { tests: { state: 'failed', why: 'npm test' } }, 'COMMENT', 8],
    ['row 8: hold list', { onHoldList: true }, 'COMMENT', 8],
    ['row 8: CI pending', { ci: PENDING }, 'COMMENT', 8],
    ['row 8: CI unknown', { ci: UNKNOWN }, 'COMMENT', 8],
    ['row 8: adjudicator declined', { adjudicatorApprove: false }, 'COMMENT', 8],
    ['row 8: approvals off (auto.approve)', { autoApprove: false }, 'COMMENT', 8],
  ])('%s', (_name, facts, event, row) => {
    const d = decideEvent({ ...BASE, ...facts });
    expect([d.event, d.row]).toEqual([event, row]);
  });

  it('states why, and marks a ruling section on row 2 and on row 1 when a ruling is needed (N10)', () => {
    expect(decideEvent({ ...BASE, isAuthor: true, needsRuling: true }).ruling).toBe(true);
    expect(decideEvent({ ...BASE, isAuthor: true }).ruling).toBe(false);
    expect(decideEvent({ ...BASE, needsRuling: true }).ruling).toBe(true);
    expect(decideEvent({ ...BASE, ci: RED }).line).toBe('CI red: test.');
    expect(decideEvent({ ...BASE, legsClear: false, ci: PENDING }).line).toBe('Approval held: the legs are not clear; CI pending: test.');
    expect(decideEvent({ ...BASE, identity: true, ci: RED, userChangeRequest: true }).line).toBe(
      'Approval held: identity, CI red: test; your own change request stands (needs-ruling, plan 3.8).',
    );
  });
});

const NONCE = '0123456789ab';
function adjudication(extra: Partial<Adjudication> = {}): Adjudication {
  return {
    nonce: NONCE,
    head_sha: A,
    round: 2,
    verdict: 'NEEDS-WORK',
    approve: false,
    needs_ruling: false,
    reason: 'r',
    findings: [
      { id: 'f_000000000001', title: 'Loop | drops the end', path: 'widget/x.py', line: 3, severity: 'HIGH', outcome: 'owed', owner: 'this', proof: 'widget/x.py:3 range(a, b)', kind: 'finding', raised_by: [], same_as: null, closes_item: null },
      { id: 'f_000000000002', title: 'Rename', path: null, line: null, severity: 'NIT', outcome: 'nit', owner: 'this', proof: '', kind: 'finding', raised_by: [], same_as: null, closes_item: null },
      { id: 'f_000000000003', title: 'Bogus', path: 'widget/y.py', line: 9, severity: 'MEDIUM', outcome: 'refuted', owner: 'this', proof: 'widget/y.py:9 guards it', kind: 'finding', raised_by: [], same_as: null, closes_item: null },
    ],
    unmapped: [],
    earlier_items: [{ source: 'R11', status: 'closed', evidence: 'widget/x.py:1', fix_row: null }],
    human_asks: [],
    leg_verdicts: [],
    not_verified: ['the migration on Postgres'],
    followups: ['f_000000000002'],
    summary: 'One owed defect.',
    blocker_call: 'Fix the loop.',
    ...extra,
  };
}
function councilBody(extra: Partial<CouncilBody> = {}): CouncilBody {
  return {
    kind: 'council',
    marker: roundMarker(REF, 2, A),
    decision: decideEvent({ ...BASE, verdict: 'NEEDS-WORK', owed: 1 }),
    adjudication: adjudication(),
    verdict: 'NEEDS-WORK',
    owed: 1,
    legs: [
      { seat: 'a', role: 'primary', attempt: 1, backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', status: 'PASS', failureClass: null, counted: true, verdictRaw: 'NEEDS-WORK', verdictEffective: 'NEEDS-WORK' },
      { seat: 'b', role: 'primary', attempt: 1, backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high', status: 'CONTAMINATED', failureClass: 'contaminated', counted: false, verdictRaw: null, verdictEffective: null },
    ],
    quorum: 'council',
    ci: GREEN,
    holds: [],
    fullRoundReason: null,
    ...extra,
  };
}
const RULES = { nonce: NONCE, participants: new Set(['me', 'alice']) };

describe('the review body (plan 3.7)', () => {
  it('renders the sections in order, marker first, and passes validation', () => {
    const body = renderBody(councilBody(), RULES);
    const order = [roundMarker(REF, 2, A), '**Verdict: NEEDS-WORK, 1 owed.** Changes requested: 1 owed.', '## Legs', '## Summary', '## Fix table', '## Earlier items', '## Follow-ups and nits (non-blocking)', '## Not verified', '## Refuted', '## Blocker call'];
    const positions = order.map((s) => body.indexOf(s));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((x, y) => x - y)).toEqual(positions);
    expect(body.startsWith(`${roundMarker(REF, 2, A)}\n`)).toBe(true);
    expect(body).toContain('| 1 | widget/x.py:3 | HIGH: Loop \\| drops the end | this | yes |');
    expect(body).toContain('- Seat b (primary, attempt 1): claude claude-sonnet-5-5 (high): not counted, CONTAMINATED (contaminated).');
    expect(body).toContain('- R11: closed. widget/x.py:1');
    expect(body).toContain('- nit: Rename ((no file))');
    expect(body).toContain('- Bogus (widget/y.py:9): widget/y.py:9 guards it');
    expect(validateBody(body, { marker: roundMarker(REF, 2, A), rules: RULES, owed: 1 })).toEqual([]);
  });

  it('an identity post starts with the identity marker (N5)', () => {
    const decision = decideEvent({ ...BASE, identity: true });
    const body = renderBody({ kind: 'identity', marker: identityMarker(REF, A), decision, number: 3, commitId: B, reviewId: 99, ci: GREEN }, RULES);
    expect(body.split('\n')[0]).toBe(identityMarker(REF, A));
    expect(body).toContain('**Approved by identity.**');
    expect(body).toContain('bbbbbbb on #3');
    expect(validateBody(body, { marker: identityMarker(REF, A), rules: RULES, owed: null })).toEqual([]);
  });

  it('carries a "Ruling needed" section with the holds and the ruling rows', () => {
    const a = adjudication({ needs_ruling: true, findings: [{ ...adjudication().findings[2]!, outcome: 'ruling', severity: 'HIGH', proof: 'cannot verify' }], followups: [] });
    const body = renderBody(councilBody({ adjudication: a, owed: 0, verdict: 'SHIP', decision: decideEvent({ ...BASE, needsRuling: true }), holds: ['Your own change request (review 5) stands on this head (plan 3.8).'] }), RULES);
    expect(body).toContain('## Ruling needed');
    expect(body).toContain('- Your own change request (review 5) stands on this head (plan 3.8).');
    expect(body).toContain('- Bogus (widget/y.py:9, HIGH): cannot verify');
    expect(body).toContain('| 1 | widget/y.py:9 | HIGH: Bogus | this | ruling |');
  });

  it('neutralizes the nonce, outside mentions, auto-close phrases and credentials from adjudicator text', () => {
    const token = `ghp_${'x'.repeat(36)}`;
    const a = adjudication({ summary: `NONCE: ${NONCE}. cc @alice and @mallory and @acme/team; mail a@b.com. This fixes #12 and closes acme/widget#3, resolves https://github.com/acme/widget/issues/4. Key ${token}.` });
    const body = renderBody(councilBody({ adjudication: a }), RULES);
    expect(body).not.toContain(NONCE);
    expect(body).toContain('[nonce]');
    expect(body).toContain('@alice');
    expect(body).toContain(`${FULLWIDTH_AT}mallory`);
    expect(body).toContain(`${FULLWIDTH_AT}acme/team`);
    expect(body).toContain('a@b.com');
    expect(body).toContain(`fixes ${FULLWIDTH_HASH}12`);
    expect(body).toContain(`closes acme/widget${FULLWIDTH_HASH}3`);
    expect(body).toContain('resolves github.com/acme/widget/issues/4');
    expect(body).not.toContain(token);
    expect(body).toContain('[redacted credential]');
    expect(validateBody(body, { marker: roundMarker(REF, 2, A), rules: RULES, owed: 1 })).toEqual([]);
  });

  it('the validator catches each rule in raw text, the marker, the counts and the size', () => {
    const raw = `NONCE ${NONCE} @mallory fixes #1 AKIA${'A'.repeat(16)}`;
    expect(textProblems(raw, RULES)).toHaveLength(4);
    expect(textProblems(neutralize(raw, RULES), RULES)).toEqual([]);
    const body = renderBody(councilBody(), RULES);
    const check = { marker: roundMarker(REF, 2, A), rules: RULES, owed: 1 };
    expect(validateBody(`x\n${body}`, check)[0]).toContain('first line');
    expect(validateBody(body.replace('1 owed.**', '2 owed.**'), check).join()).toContain("owed count is not the adjudication's 1");
    expect(validateBody(body.replace('| this | yes |', '| this | no |'), check).join()).toContain('fix table has 0 owed row(s)');
    expect(validateBody(body + 'x'.repeat(BODY_MAX_BYTES), check).join()).toContain('over GitHub');
  });

  it('cuts long lists so the body fits GitHub, and says how many more', () => {
    const many = Array.from({ length: 400 }, (_, i) => `item ${i} ${'y'.repeat(380)}`);
    const body = renderBody(councilBody({ adjudication: adjudication({ not_verified: many }) }), RULES);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(BODY_MAX_BYTES);
    expect(body).toMatch(/- \(\d+ more in the round record\)/);
    expect(validateBody(body, { marker: roundMarker(REF, 2, A), rules: RULES, owed: 1 })).toEqual([]);
  });
});
