import type { AdjudicatedFinding, Adjudication } from '../adjudicate/schema.js';
import type { CiState } from './ci.js';
import type { EventDecision } from './events.js';
import { neutralize, textProblems, type TextRules } from './text.js';

/*
 * The review body (plan 3.7), in its fixed order:
 *   1 the marker line (an identity post starts with the identity marker, N5)
 *   2 the verdict with its owed count, the event's line, and "Ruling needed" when a ruling is needed
 *   3 one line per leg: seat, backend, model, leg verdict
 *   4 the summary paragraph
 *   5 the fix table: | # | file:line | The change | Owner | Owed? |
 *   6 earlier items, with their status
 *   7 follow-ups and nits, marked non-blocking
 *   8 "Not verified"
 *   9 refuted items, each with its proof
 *  10 the blocker call
 * Every string taken from the adjudication goes through `neutralize`, and the finished body through `validateBody`.
 */

/** GitHub's limit on a review body, in bytes (plan 3.7). */
export const BODY_MAX_BYTES = 60_000;

export interface BodyLeg {
  seat: string;
  role: string;
  attempt: number;
  backend: string;
  model: string;
  effort: string | null;
  status: string;
  failureClass: string | null;
  counted: boolean;
  verdictRaw: string | null;
  verdictEffective: string | null;
}

export interface CouncilBody {
  kind: 'council';
  marker: string;
  decision: EventDecision;
  adjudication: Adjudication;
  /** The verdict and owed count as stored (SWF with 0 owed reads as SHIP). */
  verdict: string;
  owed: number;
  legs: BodyLeg[];
  quorum: 'council' | 'solo';
  ci: CiState;
  /** Why a ruling is needed beyond the ruling findings (the user's own change request on this head, 3.8). */
  holds: string[];
  /** A 3.6 fallback: the round reviewed the whole change, and why. */
  fullRoundReason: string | null;
}

export interface IdentityBody {
  kind: 'identity';
  marker: string;
  decision: EventDecision;
  /** The earlier PR, the approved commit and its review. */
  number: number;
  commitId: string;
  reviewId: number;
  ci: CiState;
}

const CAP = { summary: 4_000, title: 300, proof: 600, evidence: 400, item: 400, blocker: 2_000 } as const;

function cap(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** One table cell: one line, pipes escaped. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

const where = (f: Pick<AdjudicatedFinding, 'path' | 'line'>): string => (f.path === null ? '(no file)' : f.line === null ? f.path : `${f.path}:${f.line}`);

function ciLine(ci: CiState): string {
  switch (ci.state) {
    case 'off':
      return 'CI: the gate is off.';
    case 'green':
      return `CI: green (${ci.note}).`;
    case 'red':
      return `CI: red (${ci.failing.join(', ')}).`;
    case 'pending':
      return `CI: pending (${ci.pending.join(', ')}).`;
    case 'unknown':
      return `CI: unknown (${ci.note}).`;
  }
}

function legLine(l: BodyLeg): string {
  const who = `${l.backend} ${l.model}${l.effort !== null ? ` (${l.effort})` : ''}`;
  if (!l.counted) return `- Seat ${l.seat} (${l.role}, attempt ${l.attempt}): ${who}: not counted, ${l.status}${l.failureClass !== null ? ` (${l.failureClass})` : ''}.`;
  const v = l.verdictRaw ?? 'none';
  const eff = l.verdictEffective !== null && l.verdictEffective !== v ? ` (effective ${l.verdictEffective})` : '';
  return `- Seat ${l.seat}: ${who}: ${v}${eff}.`;
}

/**
 * Renders a council body, list sections cut to `listMax` items each (with a count of the rest) so the body fits
 * GitHub's size limit.
 */
function renderCouncil(b: CouncilBody, rules: TextRules, listMax: number): string {
  const a = b.adjudication;
  const t = (s: string, max: number): string => cap(neutralize(s, rules), max);
  const out: string[] = [b.marker, ''];
  out.push(`**Verdict: ${b.verdict}, ${b.owed} owed.** ${b.decision.line}`);
  if (b.fullRoundReason !== null) out.push('', `This round reviewed the whole change because ${t(b.fullRoundReason, CAP.item)}; it keeps its round number and rule.`);
  out.push('', ciLine(b.ci));
  const rulings = a.findings.filter((f) => f.outcome === 'ruling');
  if (b.decision.ruling) {
    out.push('', '## Ruling needed', '');
    for (const h of b.holds) out.push(`- ${t(h, CAP.item)}`);
    for (const f of rulings) out.push(`- ${t(f.title, CAP.title)} (${where(f)}, ${f.severity}): ${t(f.proof, CAP.proof)}`);
    if (b.holds.length === 0 && rulings.length === 0) out.push('- The adjudicator asked for a ruling.');
    out.push('', 'The round holds at this head until you rule.');
  }

  out.push('', '## Legs', '');
  if (b.quorum === 'solo') out.push('SOLO REVIEW: one ratified leg. This is not a council verdict, and it never approves.', '');
  for (const l of b.legs) out.push(legLine(l));

  out.push('', '## Summary', '', t(a.summary, CAP.summary));

  const owed = a.findings.filter((f) => f.outcome === 'owed');
  const table = [...owed, ...rulings];
  out.push('', '## Fix table', '');
  if (table.length === 0) out.push('Nothing owed.');
  else {
    out.push('| # | file:line | The change | Owner | Owed? |', '|---|---|---|---|---|');
    table.forEach((f, i) => out.push(`| ${i + 1} | ${cell(t(where(f), CAP.title))} | ${cell(t(`${f.severity}: ${f.title}`, CAP.title))} | ${cell(t(f.owner, 60))} | ${f.outcome === 'owed' ? 'yes' : 'ruling'} |`));
  }

  const list = <T>(items: readonly T[], line: (x: T) => string): string[] => {
    const shown = items.slice(0, listMax).map(line);
    if (items.length > listMax) shown.push(`- (${items.length - listMax} more in the round record)`);
    return shown;
  };

  const earlier = [...a.earlier_items.map((e) => ({ id: e.source, status: e.status, evidence: e.evidence })), ...a.human_asks.map((h) => ({ id: h.id, status: h.status, evidence: h.evidence }))];
  out.push('', '## Earlier items', '');
  if (earlier.length === 0) out.push('None.');
  else out.push(...list(earlier, (e) => `- ${t(e.id, 80)}: ${e.status}${e.evidence.trim() !== '' ? `. ${t(e.evidence, CAP.evidence)}` : ''}`));

  const nonBlocking = a.findings.filter((f) => f.outcome === 'follow-up' || f.outcome === 'nit' || f.outcome === 'noted');
  out.push('', '## Follow-ups and nits (non-blocking)', '');
  if (nonBlocking.length === 0) out.push('None.');
  else out.push(...list(nonBlocking, (f) => `- ${f.outcome}: ${t(f.title, CAP.title)} (${t(where(f), CAP.title)}${f.owner !== 'this' ? `, owner ${t(f.owner, 60)}` : ''})`));

  out.push('', '## Not verified', '');
  if (a.not_verified.length === 0) out.push('Nothing listed.');
  else out.push(...list(a.not_verified, (n) => `- ${t(n, CAP.item)}`));

  const refuted = a.findings.filter((f) => f.outcome === 'refuted');
  out.push('', '## Refuted', '');
  if (refuted.length === 0) out.push('None.');
  else out.push(...list(refuted, (f) => `- ${t(f.title, CAP.title)} (${t(where(f), CAP.title)}): ${t(f.proof, CAP.proof)}`));

  out.push('', '## Blocker call', '', t(a.blocker_call, CAP.blocker));
  return `${out.join('\n')}\n`;
}

function renderIdentity(b: IdentityBody): string {
  const out: string[] = [b.marker, ''];
  out.push(`**${b.decision.line}**`);
  out.push(
    '',
    `This head's tree is byte-identical to ${b.commitId.slice(0, 7)} on #${b.number}, which this login approved (review ${b.reviewId}); the approval still stands and the trees still match. No seats ran.`,
  );
  out.push('', ciLine(b.ci));
  return `${out.join('\n')}\n`;
}

/** The body for a decision, cut to fit `BODY_MAX_BYTES` when its lists are long. */
export function renderBody(b: CouncilBody | IdentityBody, rules: TextRules): string {
  if (b.kind === 'identity') return renderIdentity(b);
  for (const listMax of [Infinity, 50, 20, 5, 0]) {
    const body = renderCouncil(b, rules, listMax);
    if (Buffer.byteLength(body) <= BODY_MAX_BYTES) return body;
  }
  return renderCouncil(b, rules, 0);
}

export interface BodyCheck {
  /** The marker the body must start with. */
  marker: string;
  rules: TextRules;
  /** Council bodies: the owed count and owed rows the adjudication holds. Null for an identity body. */
  owed: number | null;
}

/** Plan 3.7 "Validation by code before posting": every problem, or none. */
export function validateBody(body: string, check: BodyCheck): string[] {
  const problems = textProblems(body, check.rules);
  const first = body.split('\n', 1)[0] ?? '';
  if (first !== check.marker) problems.push(`the first line is not the marker "${check.marker}"`);
  const bytes = Buffer.byteLength(body);
  if (bytes > 60_000) problems.push(`the body is ${bytes} bytes, over GitHub's 60,000`);
  if (check.owed !== null) {
    const m = /^\*\*Verdict: [A-Z-]+, (\d+) owed\.\*\*/m.exec(body);
    if (!m || Number(m[1]) !== check.owed) problems.push(`the verdict line's owed count is not the adjudication's ${check.owed}`);
    const rows = body.split('\n').filter((l) => /^\| \d+ \|.*\| yes \|$/.test(l)).length;
    if (rows !== check.owed) problems.push(`the fix table has ${rows} owed row(s), not the adjudication's ${check.owed}`);
  }
  return problems;
}
