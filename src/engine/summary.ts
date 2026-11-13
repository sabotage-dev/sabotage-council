import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ratification } from '../adapters/types.js';
import type { LegReply } from '../parse/index.js';
import type { Store } from '../store/open.js';
import { readRoundInputs, roundDirOf, type DataLayout } from './prepare.js';
import { getEvents, getLegs, getRound, type LegRow } from './records.js';
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
  quorum: { label: QuorumLabel; ratified: number; seats: number; note: string };
  round_dir: string;
  root: string;
  brief_path: string;
  earlier_items: Array<{ id: string; severity: string; closed_context: boolean; text: string }>;
  legs: LegSummary[];
  adjudication: { verdict: string | null; owed: number | null; approve: boolean | null; needs_ruling: boolean } | null;
  started_at: string;
  finished_at: string | null;
  settled_at: string | null;
  wall_ms: number | null;
  cost: { usd: number; credits: number; legs_with_cost: number };
  events: Array<{ ts: string; kind: string; detail: unknown }>;
}

function readJson<T>(file: string): T | null {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

function legSummary(roundDir: string, l: LegRow): LegSummary {
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
    counted: l.status === 'PASS',
    failure_class: l.failure_class,
    enforcement: l.enforcement_label,
    cli_version: l.cli_version,
    verdict_raw: l.verdict_raw,
    verdict_reason: reply?.verdict.reason ?? null,
    verdict_effective: l.verdict_effective,
    findings: l.status === 'PASS' && f ? f.findings : [],
    findings_extracted_by: l.status === 'PASS' && f ? f.extracted_by : null,
    findings_problem: f && f.extracted_by === 'adjudicator-needed' ? f.reason : null,
    answer_path: existsSync(answer) ? answer : null,
    leg_dir: legDir,
    ratification: r
      ? {
          status: r.status,
          failed_checks: r.checks.filter((c) => !c.ok).map((c) => ({ name: c.name, detail: c.detail })),
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
  const roundDir = roundDirOf(layout, roundId);
  const inputs = readRoundInputs(roundDir);
  const legs = getLegs(store.db, roundId).map((l) => legSummary(roundDir, l));
  const ratified = legs.filter((l) => l.counted).length;
  const label = quorumOf(ratified);
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
    target_key: inputs.targetKey,
    head_sha: round.head_sha,
    base_sha: round.base_sha,
    baseline_sha: round.baseline_sha,
    scope: inputs.scope,
    full_round_reason: round.full_round_reason,
    rule: inputs.rule,
    nonce: round.nonce,
    snapshot: inputs.snapshot,
    status: round.status,
    quorum: {
      label,
      ratified,
      seats: inputs.roster.seats.length,
      note: round.status === 'running' ? `running: ${ratified} leg(s) ratified so far` : quorumNote(label, ratified),
    },
    round_dir: roundDir,
    root: inputs.root,
    brief_path: inputs.briefFile,
    earlier_items: inputs.earlierItems.map((i) => ({ id: i.id, severity: i.severity, closed_context: i.closedContext, text: i.text })),
    legs,
    adjudication:
      round.status === 'adjudicated'
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
  };
}
