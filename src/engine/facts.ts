import { join } from 'node:path';
import { ruleFor, type RoundRule } from '../brief/rules.js';
import type { RootInputs } from '../root/build.js';
import type { Store } from '../store/open.js';
import { getRound, type CarriedItem, type RosterSnapshot } from './records.js';
import { rootPathOf, type RootsLayout } from './roots.js';

/*
 * What a round is, from the store (fold row 3). Everything the worker runs and the validator judges comes from the
 * rows written at round start: the `rounds` row (number, head, nonce, roster), the `targets` row (the finding-id
 * namespace) and the `round-prepared` event (earlier items, tree hash, brief, root inputs). The round dir's
 * `round.json` is a display copy: editing it changes nothing a round decides.
 */

/** The `round-prepared` event's detail: written once, at round start. */
export interface PreparedDetail {
  version: 2;
  round_no: number;
  rule: RoundRule;
  scope: string;
  baseline: string | null;
  snapshot: string | null;
  /** What numbering compares (3.6): the head for diff targets, the plan's content for plan targets (fold row 11). */
  revision: string;
  tree_hash: string;
  brief_text: string;
  brief_promises: string[];
  earlier_items: CarriedItem[];
  human_asks: string[];
  root_inputs: RootInputs;
}

export interface RoundFacts {
  roundId: number;
  targetId: number;
  roundNo: number;
  mode: 'plan' | 'diff' | 'pr' | 'auto';
  nonce: string;
  head: string;
  rule: RoundRule;
  targetKey: string;
  roster: RosterSnapshot;
  legTimeoutMs: number;
  /** The first attempt's root, from the layout. */
  root: string;
  /** The brief the legs read: the sealed copy inside the root. */
  briefFile: string;
  detail: PreparedDetail;
}

export class FactsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactsError';
  }
}

export function preparedDetail(store: Store, roundId: number): PreparedDetail {
  const row = store.db.prepare("SELECT detail_json FROM events WHERE round_id = ? AND kind = 'round-prepared' ORDER BY id LIMIT 1").get(roundId) as
    | { detail_json: string | null }
    | undefined;
  if (!row?.detail_json) throw new FactsError(`round ${roundId} has no round-prepared record in the store`);
  const detail = JSON.parse(row.detail_json) as PreparedDetail;
  if (detail.version !== 2) throw new FactsError(`round ${roundId} was prepared by an older build (record version ${String(detail.version)})`);
  return detail;
}

export function targetKeyOf(store: Store, targetId: number): string {
  const t = store.db.prepare('SELECT kind, repo, path, branch FROM targets WHERE id = ?').get(targetId) as
    | { kind: string; repo: string | null; path: string | null; branch: string | null }
    | undefined;
  if (!t) throw new FactsError(`no target ${targetId} in the store`);
  return `${t.kind}:${t.repo ?? ''}:${(t.kind === 'plan' ? t.path : t.branch) ?? ''}`;
}

export function roundFacts(store: Store, layout: RootsLayout, roundId: number): RoundFacts {
  const round = getRound(store.db, roundId);
  if (!round) throw new FactsError(`no round ${roundId} in the store`);
  if (round.nonce === null) throw new FactsError(`round ${roundId} has no nonce (it never finished preparing)`);
  const roster = JSON.parse(round.roster_json) as RosterSnapshot;
  const root = rootPathOf(layout, roundId, 1);
  return {
    roundId,
    targetId: round.target_id,
    roundNo: round.round_no,
    mode: round.mode as RoundFacts['mode'],
    nonce: round.nonce,
    head: round.head_sha,
    rule: ruleFor(round.round_no, roster.council.high_only_from_round),
    targetKey: targetKeyOf(store, round.target_id),
    roster,
    legTimeoutMs: roster.council.leg_timeout_minutes * 60_000,
    root,
    briefFile: join(root, 'BRIEF.md'),
    detail: preparedDetail(store, roundId),
  };
}
