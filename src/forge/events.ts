import type { CiState } from './ci.js';

/*
 * The event mapping of plan 3.7: rows checked top to bottom, the first match wins. Pure, so every row is a table
 * test. The rows, as built (P6 folded N2, N3, N10 and the `auto.approve` check on the council approval row):
 *   1 the user is the PR author                                   COMMENT (a needed ruling still gets its section)
 *   2 a ruling finding, needs_ruling, or the user's own change request standing on this head (3.8)
 *                                                                 COMMENT with "Ruling needed"
 *   3 identity path, re-checked live, auto.approve on, CI green, not hold-listed, no open change request of the
 *     user's (N2)                                                 APPROVE, identity marker first
 *   4 identity path, any of those failing (red CI included, N3)  COMMENT "approval held: identity, <why>"
 *   5 SHIP or SWF, 0 owed, legs clear, no ruling, adjudicator approve, a council (not solo), auto.approve on, CI
 *     green, tests allow, not hold-listed                         APPROVE on the reviewed head
 *   6 NEEDS-WORK, or owed >= 1                                    REQUEST_CHANGES
 *   7 CI red                                                      REQUEST_CHANGES "CI red: <checks>" (or COMMENT)
 *   8 any other hold                                              COMMENT "approval held: <why>"
 */

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

export interface EventFacts {
  /** `github.login` is the PR's author (GitHub refuses APPROVE and REQUEST_CHANGES on your own PR). */
  isAuthor: boolean;
  /** The identity path (3.10): no seats, a tree the user already approved. */
  identity: boolean;
  /** A ruling finding, `needs_ruling: true`, or the user's own change request standing on this head (3.8). */
  needsRuling: boolean;
  verdict: 'SHIP' | 'SHIP-WITH-FIXES' | 'NEEDS-WORK' | null;
  owed: number;
  legsClear: boolean;
  /** Two or more counted legs; a solo review never approves. */
  council: boolean;
  /** The adjudicator's `approve`. */
  adjudicatorApprove: boolean;
  /** `auto.approve` (D6). */
  autoApprove: boolean;
  ci: CiState;
  /** `auto.ci_red_event`: what CI red posts (row 7). */
  ciRedEvent: 'REQUEST_CHANGES' | 'COMMENT';
  /** Opt-in tests (D12): `off` when the repository has none configured. */
  tests: { state: 'off' | 'pass' | 'failed' | 'held'; why: string };
  onHoldList: boolean;
  /** The user's own open change request, on any head (identity rows, N2). */
  userChangeRequest: boolean;
  /** Identity path: why the live re-check failed (the earlier approval no longer stands, or the trees differ); null when it held. */
  identityRecheck: string | null;
}

export interface EventDecision {
  event: ReviewEvent;
  /** The table row that matched, 1-8. */
  row: number;
  /** The line the body states under the verdict: "approval held: ...", "CI red: ...", or the approval. */
  line: string;
  /** The body carries a "Ruling needed" section (row 2, and row 1 when a ruling is needed: N10). */
  ruling: boolean;
}

export const ciGreen = (ci: CiState): boolean => ci.state === 'green' || ci.state === 'off';

function ciWhy(ci: CiState): string | null {
  switch (ci.state) {
    case 'green':
    case 'off':
      return null;
    case 'red':
      return `CI red: ${ci.failing.join(', ')}`;
    case 'pending':
      return `CI pending: ${ci.pending.join(', ')}`;
    case 'unknown':
      return `CI unknown: ${ci.note}`;
  }
}

/** What holds an identity approval, in plain words; empty when row 3 matches. */
export function identityHolds(f: EventFacts): string[] {
  const why: string[] = [];
  if (!f.autoApprove) why.push('approvals are off (auto.approve = false)');
  const ci = ciWhy(f.ci);
  if (ci !== null) why.push(ci);
  if (f.onHoldList) why.push('the repository is on the hold list');
  if (f.userChangeRequest) why.push('your own change request stands (needs-ruling, plan 3.8)');
  if (f.identityRecheck !== null) why.push(f.identityRecheck);
  return why;
}

/** What holds a council approval, in plain words; empty when row 5 matches. */
export function councilHolds(f: EventFacts): string[] {
  const why: string[] = [];
  if (f.verdict !== 'SHIP' && f.verdict !== 'SHIP-WITH-FIXES') why.push(`the verdict is ${f.verdict ?? 'missing'}`);
  if (f.owed > 0) why.push(`${f.owed} owed`);
  if (!f.council) why.push('a solo review never approves');
  else if (!f.legsClear) why.push('the legs are not clear');
  if (!f.adjudicatorApprove) why.push('the adjudicator did not approve');
  if (!f.autoApprove) why.push('approvals are off (auto.approve = false)');
  const ci = ciWhy(f.ci);
  if (ci !== null) why.push(ci);
  if (f.tests.state === 'failed' || f.tests.state === 'held') why.push(`tests ${f.tests.state}: ${f.tests.why}`);
  if (f.onHoldList) why.push('the repository is on the hold list');
  return why;
}

export function decideEvent(f: EventFacts): EventDecision {
  if (f.isAuthor) {
    return { event: 'COMMENT', row: 1, line: 'Posted as a comment: you are the author of this pull request, and GitHub allows no other review on your own PR.', ruling: f.needsRuling };
  }
  if (f.needsRuling) return { event: 'COMMENT', row: 2, line: 'Approval held: a ruling is needed (below).', ruling: true };
  if (f.identity) {
    const why = identityHolds(f);
    if (why.length === 0) return { event: 'APPROVE', row: 3, line: 'Approved by identity.', ruling: false };
    return { event: 'COMMENT', row: 4, line: `Approval held: identity, ${why.join('; ')}.`, ruling: false };
  }
  const holds = councilHolds(f);
  if (holds.length === 0) return { event: 'APPROVE', row: 5, line: 'Approved.', ruling: false };
  if (f.verdict === 'NEEDS-WORK' || f.owed >= 1) return { event: 'REQUEST_CHANGES', row: 6, line: `Changes requested: ${f.owed} owed.`, ruling: false };
  if (f.ci.state === 'red') return { event: f.ciRedEvent, row: 7, line: `CI red: ${f.ci.failing.join(', ')}.`, ruling: false };
  return { event: 'COMMENT', row: 8, line: `Approval held: ${holds.join('; ')}.`, ruling: false };
}
