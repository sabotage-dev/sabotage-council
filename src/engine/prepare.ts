import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderBrief, type Brief, type ReviewScope } from '../brief/render.js';
import type { RoundRule } from '../brief/rules.js';
import type { CouncilConfig } from '../config/schema.js';
import type { RootInputs } from '../root/build.js';
import type { EarlierItem } from '../root/data-files.js';
import { prepareRoot } from '../root/seal.js';
import type { Store } from '../store/open.js';
import type { PreparedDetail } from './facts.js';
import { insertEvent, latestCouncilHead, now, numberRound, upsertTarget, type CarriedItem, type RosterSnapshot } from './records.js';
import { createRootDir, removeOwnedRoot } from './roots.js';
import { baselineIsSnapshot, chainSnapshot, type ResolvedTarget, type RoundMode } from './target.js';

/*
 * Plan 3.1 steps 1-3 for plan and diff rounds: the round number and baseline (3.6), the root built at exact SHAs
 * (5.3, P1), the brief for the mode and round rule (3.9, P1), and the round row. The legs run later, in the
 * background worker, from what this writes into the round dir.
 */

/** Where a round's files live: the store's dir holds `rounds/<id>/`; roots go under the roots dir (plan 5.3, 5.4). */
export interface DataLayout {
  dbPath: string;
  roundsDir: string;
  rootsDir: string;
}

export function roundDirOf(layout: DataLayout, roundId: number): string {
  return join(layout.roundsDir, String(roundId));
}

/** Everything the worker and the adjudicator need, written to `<round dir>/round.json`. */
export interface RoundInputs {
  version: 1;
  roundId: number;
  targetId: number;
  mode: RoundMode;
  label: string;
  targetKey: string;
  repoTop: string;
  repoName: string;
  head: string;
  base: string | null;
  mergeBase: string | null;
  baseline: string | null;
  planPath: string | null;
  snapshot: string | null;
  roundNo: number;
  rule: RoundRule;
  scope: ReviewScope;
  fullRoundReason: string | null;
  nonce: string;
  root: string;
  briefFile: string;
  earlierItems: CarriedItem[];
  /** The asks of the reviewer's open change request (pr and auto, P6); always empty in plan and diff. */
  humanAsks: string[];
  roster: RosterSnapshot;
  legTimeoutMs: number;
  configPath: string;
}

export interface PrepareOptions {
  config: CouncilConfig;
  configPath: string;
  layout: DataLayout;
  target: ResolvedTarget;
  facts?: readonly string[] | undefined;
  questions?: readonly string[] | undefined;
  /** Tests pin the nonce; a real round draws a fresh one (P1). */
  nonce?: string | undefined;
}

export interface PreparedRound {
  inputs: RoundInputs;
  roundDir: string;
  brief: Brief;
}

export function readRoundInputs(roundDir: string): RoundInputs {
  return JSON.parse(readFileSync(join(roundDir, 'round.json'), 'utf8')) as RoundInputs;
}

export function rosterOf(config: CouncilConfig): RosterSnapshot {
  return {
    seats: config.seats,
    council: { leg_timeout_minutes: config.council.leg_timeout_minutes, high_only_from_round: config.council.high_only_from_round },
  };
}

/**
 * Numbers the round, builds and seals its root with the brief, and records the round as `running`. The round row is
 * inserted first so its id names the round dir and the root (`<store tag>-<id>-a1`, created exclusively); a failure
 * after that marks the round `failed` and removes only the root dirs this call created. Everything a later step
 * decides on goes into the store (the `round-prepared` event); `round.json` is a display copy (fold row 3).
 */
export function prepareRound(store: Store, options: PrepareOptions): PreparedRound {
  const { db } = store;
  const targetId = upsertTarget(db, options.target);
  // A follow-up round on uncommitted work builds on the last reviewed snapshot (fold row 10).
  const t = chainSnapshot(options.target, latestCouncilHead(db, targetId));
  const numbering = numberRound(db, targetId, t.head, t.revision);
  const roster = rosterOf(options.config);
  const startedAt = now();
  const insert = db
    .prepare(
      `INSERT INTO rounds (target_id, round_no, mode, head_sha, base_sha, baseline_sha, nonce, roster_json, started_at, status)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, 'running')`,
    )
    .run(targetId, numbering.roundNo, t.mode, t.head, numbering.baseline, JSON.stringify(roster), startedAt);
  const roundId = Number(insert.lastInsertRowid);
  const roundDir = roundDirOf(options.layout, roundId);
  let rootDir: string | null = null;
  let gitDirOwned = false;
  try {
    mkdirSync(roundDir, { recursive: true, mode: 0o700 });
    // Exclusive: an existing dir with this name is never adopted, and never deleted by this call's cleanup.
    rootDir = createRootDir(options.layout, roundId, 1);
    // The seal creates `<root>.git`; one that is already there is not this call's to delete.
    gitDirOwned = !existsSync(`${rootDir}.git`);
    const previous: EarlierItem[] = numbering.items.map((i) => ({ id: i.id, text: i.text, closedContext: i.closedContext, from: `round ${i.fromRound}` }));
    const inputs: RootInputs = {
      repo: t.repoTop,
      name: t.repoName,
      head: t.head,
      base: t.base ?? undefined,
      baseline: numbering.baseline ?? undefined,
      foldPaths: t.foldPaths ?? undefined,
      baselineSnapshot: baselineIsSnapshot(t.repoTop, numbering.baseline, t.head),
      previousReviews: previous,
      context: t.context,
    };
    const prepared = prepareRoot(rootDir, inputs, (layout) =>
      renderBrief({
        mode: t.mode,
        target: t.label,
        round: numbering.roundNo,
        highOnlyFromRound: roster.council.high_only_from_round,
        layout,
        planPath: t.planPath ?? undefined,
        nonce: options.nonce,
        facts: options.facts,
        questions: options.questions,
      }),
    );
    const brief = prepared.brief;
    const fold = prepared.built.fold;
    const fullRoundReason = fold?.kind === 'fallback' ? fold.reason : null;
    const briefFile = join(roundDir, 'BRIEF.md');
    writeFileSync(briefFile, brief.text, { flag: 'wx' });
    const roundInputs: RoundInputs = {
      version: 1,
      roundId,
      targetId,
      mode: t.mode,
      label: t.label,
      targetKey: t.targetKey,
      repoTop: t.repoTop,
      repoName: t.repoName,
      head: t.head,
      base: t.base,
      mergeBase: prepared.built.mergeBase,
      baseline: numbering.baseline,
      planPath: t.planPath,
      snapshot: t.snapshot,
      roundNo: numbering.roundNo,
      rule: brief.rule,
      scope: brief.scope,
      fullRoundReason,
      nonce: brief.nonce,
      root: prepared.sealed.root,
      briefFile,
      earlierItems: numbering.items,
      humanAsks: [],
      roster,
      legTimeoutMs: roster.council.leg_timeout_minutes * 60_000,
      configPath: options.configPath,
    };
    writeFileSync(join(roundDir, 'round.json'), `${JSON.stringify(roundInputs, null, 2)}\n`, { flag: 'wx' });
    db.prepare('UPDATE rounds SET base_sha = ?, full_round_reason = ?, nonce = ? WHERE id = ?').run(
      prepared.built.mergeBase,
      fullRoundReason,
      brief.nonce,
      roundId,
    );
    const detail: PreparedDetail = {
      version: 2,
      round_no: numbering.roundNo,
      rule: brief.rule,
      scope: brief.scope,
      baseline: numbering.baseline,
      snapshot: t.snapshot,
      warnings: t.warnings,
      revision: t.revision,
      tree_hash: prepared.sealed.treeHash,
      brief_text: brief.text,
      brief_promises: [...brief.promises],
      earlier_items: numbering.items,
      human_asks: [],
      root_inputs: inputs,
    };
    insertEvent(db, 'round-prepared', roundId, detail);
    return { inputs: roundInputs, roundDir, brief };
  } catch (error) {
    db.prepare("UPDATE rounds SET status = 'failed', finished_at = ? WHERE id = ?").run(now(), roundId);
    insertEvent(db, 'round-failed', roundId, { stage: 'prepare', error: error instanceof Error ? error.message : String(error) });
    if (rootDir !== null) {
      removeOwnedRoot(options.layout, rootDir);
      if (gitDirOwned) removeOwnedRoot(options.layout, `${rootDir}.git`);
    }
    throw error;
  }
}
