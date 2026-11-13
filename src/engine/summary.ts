import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ratification } from '../adapters/types.js';
import type { LegReply } from '../parse/index.js';
import type { Store } from '../store/open.js';
import { roundFacts, targetKeyOf, type PrDetail } from './facts.js';
import { readRoundInputs, roundDirOf, type DataLayout } from './prepare.js';
import { getEvents, getLegs, getRound, type LegRow, type RosterSnapshot, type RoundRow } from './records.js';
import { quorumOf, type QuorumLabel } from './run.js';

/*
 * The JSON the main loop reads after `round wait` (plan 7.1 step 2): the legs with their status, verdicts, parsed
 * findings and ratification, the quorum, and where each answer is. Built from the store and the round dir, so
 * `round show` prints the same thing for a running, settled or adjudicated round.
 */

export interface LegSummary {
  leg_id: number;
  seat: string;
  role: string;
  attempt: number;
  backend: string;
  model: string;
  effort: string | null;
  transport: string;
  status: string;
  counted: boolean;
  failure_class: string | null;
  enforcement: string | null;
  cli_version: string | null;
  verdict_raw: string | null;
  verdict_reason: string | null;
  verdict_effective: string | null;
  findings: LegReply['findings']['findings'];
  findings_extracted_by: 'leg' | 'adjudicator-needed' | null;
  findings_problem: string | null;
  answer_path: string | null;
  leg_dir: string;
  ratification: {
    status: string;
    failed_checks: Array<{ name: string; detail: string }>;
    /** Notes from the record that do not fail the leg (for example codex denial text in a read's output). */
    notes: string[];
    model_observed: string | null;
    effort_observed: string | null;
    session_id: string | null;
    record_path: string | null;
  } | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  credits: number | null;
}

export interface RoundSummary {
  round_id: number;
  round_no: number;
  mode: string;
  target: string;
  target_key: string;
  head_sha: string;
  base_sha: string | null;
  baseline_sha: string | null;
  scope: string;
  full_round_reason: string | null;
  rule: string;
  nonce: string | null;
  snapshot: string | null;
  status: string;
  /** `pending` while the round runs; `none` for a failed round, whatever passed before it failed (fold row 6). */
  quorum: { label: QuorumLabel | 'pending'; ratified: number; seats: number; note: string };
  round_dir: string;
  root: string;
  brief_path: string;
  earlier_items: Array<{ id: string; severity: string; origin: string; closed_context: boolean; text: string }>;
  legs: LegSummary[];
  adjudication: { verdict: string | null; owed: number | null; approve: boolean | null; needs_ruling: boolean } | null;
  started_at: string;
  finished_at: string | null;
  settled_at: string | null;
  wall_ms: number | null;
  cost: { usd: number; credits: number; legs_with_cost: number };
  events: Array<{ ts: string; kind: string; detail: unknown }>;
  /** pr rounds (P6): the marker, the kind, the dry-run flag, what was posted, and what the round read. */
  pr?: PrSummary | undefined;
}

export interface PrSummary {
  kind: 'council' | 'identity';
  marker: string | null;
  dry_run: boolean;
  event_posted: string | null;
  review_id: number | null;
  posted_at: string | null;
  author: string | null;
  trusted: boolean | null;
  /** Plan 3.6: the count, the baseline, the counted events and the reviews passed over. */
  count: unknown;
  user_change_request: unknown;
  review_items: string[];
  /** The identity path's match (plan 3.10). */
  identity: unknown;
  next: string;
}

function prSummary(store: Store, round: RoundRow, detail: PrDetail | undefined, identity: Record<string, unknown> | null): PrSummary {
  const posted = round.event_posted !== null;
  const ready = round.status === 'adjudicated' || round.status === 'identity';
  return {
    kind: round.kind,
    marker: round.marker,
    dry_run: round.dry_run === 1,
    event_posted: round.event_posted,
    review_id: round.review_id,
    posted_at: round.posted_at,
    author: detail?.author ?? ((identity?.['pr'] as { author?: string } | undefined)?.author ?? null),
    trusted: detail?.trusted ?? null,
    count: detail?.count ?? identity?.['round_count'] ?? null,
    user_change_request: detail?.user_change_request ?? identity?.['user_change_request'] ?? null,
    review_items: detail?.review_items ?? [],
    identity: identity?.['match'] ?? null,
    next: posted
      ? 'posted'
      : !ready
        ? round.status === 'running'
          ? `sabotage-council round wait ${round.id}`
          : round.status === 'awaiting-adjudication'
            ? `sabotage-council adjudicate ${round.id} <ADJUDICATION.json>`
            : 'nothing: the round did not settle'
        : round.dry_run === 1
          ? `sabotage-council post ${round.id} --dry-run`
          : `sabotage-council post ${round.id} --dry-run, then --post after the user's go`,
  };
}

function identitySummary(store: Store, layout: DataLayout, round: RoundRow): RoundSummary {
  const events = getEvents(store.db, round.id);
  const prepared = events.find((e) => e.kind === 'identity-prepared')?.detail as Record<string, unknown> | undefined;
  const p = (prepared?.['pr'] ?? {}) as { owner?: string; repo?: string; number?: number };
  const roundDir = roundDirOf(layout, round.id);
  return {
    round_id: round.id,
    round_no: round.round_no,
    mode: round.mode,
    target: `${p.owner ?? '?'}/${p.repo ?? '?'}#${String(p.number ?? '?')}`,
    target_key: targetKeyOf(store, round.target_id),
    head_sha: round.head_sha,
    base_sha: round.base_sha,
    baseline_sha: null,
    scope: 'identity',
    full_round_reason: null,
    rule: 'identity',
    nonce: null,
    snapshot: null,
    status: round.status,
    quorum: { label: 'none', ratified: 0, seats: (JSON.parse(round.roster_json) as RosterSnapshot).seats.length, note: 'identity approval: no seats ran (plan 3.10)' },
    round_dir: roundDir,
    root: '',
    brief_path: '',
    earlier_items: [],
    legs: [],
    adjudication: null,
    started_at: round.started_at,
    finished_at: round.finished_at,
    settled_at: null,
    wall_ms: null,
    cost: { usd: 0, credits: 0, legs_with_cost: 0 },
    events,
    pr: prSummary(store, round, undefined, prepared ?? null),
  };
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

function legSummary(roundDir: string, l: LegRow, settled: boolean): LegSummary {
  const legDir = join(roundDir, 'legs', `${l.seat_id}-${l.role}-${l.attempt}`);
  const reply = readJson<LegReply>(join(legDir, 'reply.json'));
  const r = readJson<Ratification>(join(legDir, 'ratification.json'));
  const answer = join(legDir, 'answer.md');
  const f = reply?.findings ?? null;
  return {
    leg_id: l.id,
    seat: l.seat_id,
    role: l.role,
    attempt: l.attempt,
    backend: l.backend,
    model: l.model,
    effort: l.effort,
    transport: l.transport,
    status: l.status,
    counted: settled && l.status === 'PASS',
    failure_class: l.failure_class,
    enforcement: l.enforcement_label,
    cli_version: l.cli_version,
    verdict_raw: l.verdict_raw,
    verdict_reason: reply?.verdict.reason ?? null,
    verdict_effective: l.verdict_effective,
    findings: settled && l.status === 'PASS' && f ? f.findings : [],
    findings_extracted_by: settled && l.status === 'PASS' && f ? f.extracted_by : null,
    findings_problem: f && f.extracted_by === 'adjudicator-needed' ? f.reason : null,
    answer_path: existsSync(answer) ? answer : null,
    leg_dir: legDir,
    ratification: r
      ? {
          status: r.status,
          failed_checks: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
          notes: r.notes ?? [],
          model_observed: r.modelObserved,
          effort_observed: r.effortObserved,
          session_id: r.sessionId,
          record_path: r.recordPath,
        }
      : null,
    started_at: l.started_at,
    finished_at: l.finished_at,
    duration_ms: l.duration_ms,
    tokens_in: l.tokens_in,
    tokens_out: l.tokens_out,
    cost_usd: l.cost_usd,
    credits: l.credits,
  };
}

export function quorumNote(label: QuorumLabel, ratified: number): string {
  if (label === 'council') return `${ratified} ratified legs: a council round`;
  if (label === 'solo') return 'SOLO REVIEW: one ratified leg. This is not a council verdict, and it never approves (plan 3.1 step 8).';
  return 'no ratified leg: the round failed';
}

export function roundSummary(store: Store, layout: DataLayout, roundId: number): RoundSummary {
  const round = getRound(store.db, roundId);
  if (!round) throw new Error(`no round ${roundId} in the store`);
  if (round.kind === 'identity') return identitySummary(store, layout, round);
  const roundDir = roundDirOf(layout, roundId);
  // Display fields come from round.json; everything a decision rests on comes from the store (fold row 3).
  const inputs = readRoundInputs(roundDir);
  const facts = roundFacts(store, layout, roundId);
  // Labels follow the round's status (fold row 6): only a settled round has counted legs or a council.
  const settledRound = round.status === 'awaiting-adjudication' || round.status === 'adjudicated';
  const legs = getLegs(store.db, roundId).map((l) => legSummary(roundDir, l, settledRound));
  const passed = legs.filter((l) => l.status === 'PASS').length;
  const ratified = legs.filter((l) => l.counted).length;
  const label: QuorumLabel | 'pending' = round.status === 'running' ? 'pending' : settledRound ? quorumOf(ratified) : 'none';
  const events = getEvents(store.db, roundId);
  const settled = events.find((e) => e.kind === 'legs-settled')?.ts ?? null;
  // Wall time to settlement (the legs); a failed round without a settlement event ends at finished_at.
  const end = settled ?? round.finished_at;
  const costed = legs.filter((l) => l.cost_usd !== null || l.credits !== null);
  return {
    round_id: round.id,
    round_no: round.round_no,
    mode: round.mode,
    target: inputs.label,
    target_key: facts.targetKey,
    head_sha: round.head_sha,
    base_sha: round.base_sha,
    baseline_sha: round.baseline_sha,
    scope: facts.detail.scope,
    full_round_reason: round.full_round_reason,
    rule: facts.rule,
    nonce: round.nonce,
    snapshot: facts.detail.snapshot,
    status: round.status,
    quorum: {
      label,
      ratified,
      seats: facts.roster.seats.length,
      note:
        round.status === 'running'
          ? `running: ${passed} leg(s) ratified so far`
          : settledRound
            ? quorumNote(quorumOf(ratified), ratified)
            : `the round failed: no council verdict${passed > 0 ? ` (${passed} leg(s) had ratified before it failed; they do not count)` : ''}`,
    },
    round_dir: roundDir,
    root: facts.root,
    brief_path: join(roundDir, 'BRIEF.md'),
    earlier_items: facts.detail.earlier_items.map((i) => ({ id: i.id, severity: i.severity, origin: i.origin, closed_context: i.closedContext, text: i.text })),
    legs,
    adjudication:
      round.status === 'adjudicated' || round.status === 'superseded'
        ? { verdict: round.verdict, owed: round.owed_count, approve: round.approve === null ? null : round.approve === 1, needs_ruling: round.needs_ruling === 1 }
        : null,
    started_at: round.started_at,
    finished_at: round.finished_at,
    settled_at: settled,
    wall_ms: end === null ? null : Date.parse(end) - Date.parse(round.started_at),
    cost: {
      usd: legs.reduce((s, l) => s + (l.cost_usd ?? 0), 0),
      credits: legs.reduce((s, l) => s + (l.credits ?? 0), 0),
      legs_with_cost: costed.length,
    },
    events,
    pr: round.mode === 'pr' ? prSummary(store, round, facts.detail.pr, null) : undefined,
  };
}
