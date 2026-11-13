import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CouncilConfig } from '../config/schema.js';
import { autoSchema } from '../config/schema.js';
import { changeRequestAsks, countRounds, reviewItems, userChangeRequest, type Credit, type MarkerConfig, type ReviewItem, type RoundCount } from '../forge/count.js';
import { ForgeError, type GitHubApi } from '../forge/github.js';
import { findIdentity, type IdentityMatch } from '../forge/identity.js';
import { identityMarker, roundMarker } from '../forge/markers.js';
import { checkPrFiles, defaultMirrorSource, ensureMirror, fetchExact, fetchPr, mirrorPath, treeOf, type MirrorSource } from '../forge/mirror.js';
import { authorTrusted, loginMismatch, prLabel, readPr, repoKeyOf, type PrRef, type PrSnapshot } from '../forge/pr.js';
import type { PrData } from '../root/data-files.js';
import { commitExists, type ShadowRepo } from '../root/git.js';
import type { Store } from '../store/open.js';
import type { DatabaseSync } from '../store/sqlite.js';
import type { PrDetail } from './facts.js';
import { prepareRound, roundDirOf, rosterOf, type DataLayout, type PreparedRound } from './prepare.js';
import { carriedItems, insertEvent, now, sha256, upsertTarget, type CarriedItem, type RoundNumbering } from './records.js';
import { safeName, type ResolvedTarget } from './target.js';

/*
 * `round start pr <owner/repo#num | url>` (plan 9.3, P6): read the PR from GitHub, fetch its head and base into the
 * engine's bare mirror, number the round from the PR's review history (3.6), find the user's own change request
 * (3.8, 3.9) and the earlier reviews to carry (3.5), and then either take the identity path (3.10) or prepare a
 * council round exactly as plan and diff rounds are prepared (P5), with PR.md and the asks as data.
 */

export class PrRoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrRoundError';
  }
}

export interface PrRoundOptions {
  config: CouncilConfig;
  configPath: string;
  layout: DataLayout;
  ref: PrRef;
  api: GitHubApi;
  /** Where the mirror fetches from. Default: `https://github.com/<owner>/<repo>.git`, with gh as credential helper. */
  source?: ((ref: PrRef) => MirrorSource) | undefined;
  /** The environment and the `gh` the API calls run with; the default mirror source's credential helper gets the same (row 7). */
  env?: NodeJS.ProcessEnv | undefined;
  ghBin?: string | undefined;
  /** `--dry-run`: the round renders its post and never posts. A closed PR takes only a dry run. */
  dryRun: boolean;
  /** `--no-identity`: take a council round even when the identity path would apply. */
  identity?: boolean | undefined;
  facts?: readonly string[] | undefined;
  questions?: readonly string[] | undefined;
  nonce?: string | undefined;
}

export type PrRoundResult =
  | { kind: 'council'; prepared: PreparedRound; count: RoundCount; warnings: string[] }
  | { kind: 'identity'; roundId: number; roundNo: number; match: IdentityMatch; warnings: string[] };

/** The `[auto]` settings a pr round follows ("same rules as auto", plan 9.3), with their defaults when absent. */
export function autoOf(config: CouncilConfig): ReturnType<typeof autoSchema.parse> {
  return config.auto ?? autoSchema.parse({});
}

export function markerConfig(config: CouncilConfig): MarkerConfig {
  if (!config.github) throw new PrRoundError('pr mode needs a [github] table with your login (plan 5.2)');
  return { login: config.github.login, council_logins: config.github.council_logins, markers_also_count: config.github.markers_also_count };
}

/** Hand credits for this PR from the store (plan 3.6 step 4, 8.1). */
export function creditsOf(db: DatabaseSync, ref: PrRef): Credit[] {
  const rows = db.prepare('SELECT review_id, commit_id, submitted_at FROM credits WHERE repo = ? AND num = ? ORDER BY review_id').all(repoKeyOf(ref), ref.number) as Array<{
    review_id: number;
    commit_id: string;
    submitted_at: string;
  }>;
  return rows.map((r) => ({ reviewId: r.review_id, commitId: r.commit_id, submittedAt: r.submitted_at }));
}

/** The review ids this store posted on a target: their items come from the store (plan 3.5). */
export function postedReviewIds(db: DatabaseSync, targetId: number): Set<number> {
  const rows = db.prepare('SELECT review_id FROM rounds WHERE target_id = ? AND review_id IS NOT NULL').all(targetId) as Array<{ review_id: number }>;
  return new Set(rows.map((r) => r.review_id));
}

/** The PR's participants, lower case: the logins a posted body may mention (plan 3.7). */
export function participantsOf(pr: PrSnapshot, cfg: MarkerConfig): string[] {
  const all = [pr.author, cfg.login, ...cfg.council_logins, ...pr.requestedReviewers, ...pr.assignees];
  for (const r of pr.reviews) all.push(r.login);
  for (const c of pr.reviewComments) all.push(c.login);
  for (const c of pr.issueComments) all.push(c.login);
  return [...new Set(all.filter((l) => l !== 'ghost').map((l) => l.toLowerCase()))].sort();
}

/** PR.md (plan 5.3): title, body, the conversation and every review with a body, all as data. */
export function prDataOf(pr: PrSnapshot): PrData {
  const comments = [
    ...pr.issueComments.filter((c) => c.body.trim() !== '').map((c) => ({ author: c.login, at: c.createdAt, body: c.body })),
    ...pr.reviews
      .filter((r) => r.state !== 'PENDING' && r.body.trim() !== '')
      .map((r) => ({ author: `${r.login}, review ${r.id} (${r.state}) on ${r.commitId.slice(0, 7)}`, at: r.submittedAt, body: r.body })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return { title: pr.title, body: pr.body, comments };
}

/**
 * The earlier reviews as carried items: an R item is an ask the engine cannot grade, so it is carried as a MEDIUM
 * owed item (owed while open in rounds 2-3; from round 4 the adjudicator makes it owed only for a HIGH ask in it).
 * It is closed context once a round of this store closed it on the same text (plan 3.5).
 */
export function reviewItemsAsCarried(db: DatabaseSync, targetId: number, items: readonly ReviewItem[]): CarriedItem[] {
  const last = db.prepare(
    `SELECT earlier_items.status, earlier_items.body_sha256 FROM earlier_items JOIN rounds ON rounds.id = earlier_items.round_id
      WHERE rounds.target_id = ? AND rounds.status IN ('adjudicated', 'superseded') AND earlier_items.source_id = ? ORDER BY rounds.id DESC LIMIT 1`,
  );
  return items.map((i) => {
    const row = last.get(targetId, i.id) as { status: string; body_sha256: string | null } | undefined;
    return {
      id: i.id,
      severity: 'MEDIUM',
      kind: 'finding',
      origin: 'owed',
      text: i.text,
      closedContext: row?.status === 'closed' && row.body_sha256 === sha256(i.text),
      fromRound: 0,
      from: `${i.kind === 'council-review' ? 'council review' : 'change request'} by ${i.login}`,
    };
  });
}

/**
 * Earlier items of a PR round: the store's (owed rows, rulings, follow-ups of its rounds; a round superseded at its
 * post was still adjudicated, so its items carry), then the R items.
 */
function prNumbering(db: DatabaseSync, targetId: number, count: RoundCount, items: readonly ReviewItem[]): RoundNumbering {
  const rounds = db.prepare("SELECT id FROM rounds WHERE target_id = ? AND status IN ('adjudicated', 'superseded') ORDER BY id").all(targetId) as Array<{ id: number }>;
  const stored = carriedItems(db, rounds.map((r) => r.id));
  return { roundNo: count.roundNo, baseline: count.baseline, items: [...stored, ...reviewItemsAsCarried(db, targetId, items)] };
}

function prTarget(ref: PrRef, mirror: ShadowRepo, pr: PrSnapshot): ResolvedTarget {
  return {
    mode: 'pr',
    repoTop: mirror.gitDir,
    repoKey: repoKeyOf(ref),
    repoName: safeName(ref.repo),
    head: pr.headSha,
    headCommit: pr.headSha,
    snapshot: null,
    snapshotTree: null,
    base: pr.baseSha,
    branch: null,
    planPath: null,
    prNumber: ref.number,
    label: prLabel(ref),
    targetKey: `pr:${repoKeyOf(ref)}:${ref.number}`,
    context: [],
    warnings: [],
    foldPaths: null,
    revision: pr.headSha,
  };
}

/**
 * Reads the PR and prepares its round. Fails closed: any GitHub read that fails, a head or base the mirror cannot
 * fetch, or an untrusted author under `pr.interactive_adjudication = "trusted-only"` stops it before any round row
 * is written.
 */
export function preparePrRound(store: Store, o: PrRoundOptions): PrRoundResult {
  const { db } = store;
  const cfg = markerConfig(o.config);
  const auto = autoOf(o.config);
  const warnings: string[] = [];
  // Row 10: the round is read and later posted as github.login, so gh must be logged in as that account.
  const wrongLogin = loginMismatch(o.api, cfg.login);
  if (wrongLogin !== null) throw new PrRoundError(wrongLogin);
  const pr = readPr(o.api, o.ref);
  if (pr.state === 'closed' && !o.dryRun) throw new PrRoundError(`${prLabel(o.ref)} is ${pr.merged ? 'merged' : 'closed'}: a closed pull request takes only --dry-run`);
  const trusted = authorTrusted(pr);
  let untrusted: PrDetail['untrusted'] = null;
  if (!trusted) {
    // Plan 6.3: leg text on someone else's PR is attacker-influenced, and the interactive adjudicator is this session.
    if (o.config.pr.interactive_adjudication === 'trusted-only') {
      throw new PrRoundError(
        `${pr.author} has no write access to ${pr.baseRepo} (permission: ${pr.authorPermission ?? 'unknown'}), so this PR's text is untrusted. The restricted headless adjudicator (plan 6.4) is not built yet (P7); to adjudicate it in this session anyway, accepting that leg text reaches it, set pr.interactive_adjudication = "untrusted-too"`,
      );
    }
    untrusted = { policy: o.config.council.untrusted_seat_policy, interactive_adjudication: o.config.pr.interactive_adjudication };
    warnings.push(
      `${pr.author} has no write access (permission: ${pr.authorPermission ?? 'unknown'}): this session adjudicates untrusted text (pr.interactive_adjudication = "untrusted-too"), and seats below strong follow council.untrusted_seat_policy = "${untrusted.policy}"`,
    );
  }

  const mirror = ensureMirror(mirrorPath(join(dirname(o.layout.dbPath), 'mirrors'), o.ref));
  const source = o.source?.(o.ref) ?? defaultMirrorSource(o.ref, o.env ?? process.env, o.ghBin);
  fetchPr(mirror, source, o.ref, pr.baseRef, pr.headSha, pr.baseSha);
  const files = checkPrFiles(mirror, pr.baseSha, pr.headSha, pr.files);
  if (!files.checked) warnings.push(files.note);
  const headTree = treeOf(mirror, pr.headSha);
  if (headTree === null) throw new ForgeError(`the head ${pr.headSha.slice(0, 7)} has no tree in the mirror`);

  const target = prTarget(o.ref, mirror, pr);
  const targetId = upsertTarget(db, target);
  const count = countRounds({ ref: o.ref, head: pr.headSha, reviews: pr.reviews, credits: creditsOf(db, o.ref), cfg });
  const cr = userChangeRequest(pr.reviews, cfg, pr.headSha);
  const participants = participantsOf(pr, cfg);

  if (o.identity !== false && auto.identity_approval) {
    const found = findIdentity(o.api, pr, cfg.login, headTree);
    if (found.match !== null) return identityRound(store, o, pr, count, found.match, cr !== null, participants, warnings);
  }

  const items = reviewItems({ reviews: pr.reviews, comments: pr.reviewComments, count, cfg, ours: postedReviewIds(db, targetId) });
  let baselineFetch: PrDetail['baseline_fetch'] = null;
  if (count.baseline !== null) {
    if (commitExists(mirror, count.baseline)) baselineFetch = 'present';
    else baselineFetch = fetchExact(mirror, source, count.baseline, `refs/sabotage-council/pull/${o.ref.number}/baseline-${count.baseline}`) ? 'fetched' : 'unavailable';
  }
  const asks = cr !== null && !cr.onHead ? changeRequestAsks(cr.review, pr.reviewComments) : [];
  if (cr?.onHead === true) warnings.push(`your own change request (review ${cr.review.id}) stands on this head: the round needs a ruling (plan 3.8) and cannot approve`);

  const detail = (n: RoundNumbering): PrDetail => ({
    owner: o.ref.owner,
    repo: o.ref.repo,
    number: o.ref.number,
    author: pr.author,
    base_ref: pr.baseRef,
    base_sha: pr.baseSha,
    default_branch: pr.defaultBranch,
    head_sha: pr.headSha,
    state: pr.state,
    merged: pr.merged,
    author_permission: pr.authorPermission,
    trusted,
    count: { round_no: n.roundNo, count: count.count, baseline: count.baseline, head_counted: count.headCounted, events: count.events, ignored: count.ignored },
    user_change_request: cr === null ? null : { review_id: cr.review.id, on_head: cr.onHead },
    review_items: items.map((i) => i.id),
    reviews_seen: pr.reviews.map((r) => r.id),
    baseline_fetch: baselineFetch,
    files: { listed: pr.files.length, checked: files.checked, note: files.note },
    participants,
    untrusted,
  });
  const prepared = prepareRound(store, {
    config: o.config,
    configPath: o.configPath,
    layout: o.layout,
    target,
    facts: o.facts,
    questions: o.questions,
    nonce: o.nonce,
    pr: {
      numbering: (d, id) => prNumbering(d, id, count, items),
      prData: prDataOf(pr),
      humanAsks: asks,
      marker: (roundNo) => roundMarker(o.ref, roundNo, pr.headSha),
      detail,
      dryRun: o.dryRun,
    },
  });
  for (const i of count.ignored) insertEvent(db, 'marker-ignored', prepared.inputs.roundId, i);
  if (cr?.onHead === true) insertEvent(db, 'needs-ruling', prepared.inputs.roundId, { why: 'user-change-request', review_id: cr.review.id });
  return { kind: 'council', prepared, count, warnings };
}

/** The identity path (plan 3.10): a round row with no seats, held when the user's own change request stands. */
function identityRound(store: Store, o: PrRoundOptions, pr: PrSnapshot, count: RoundCount, match: IdentityMatch, userCr: boolean, participants: string[], warnings: string[]): PrRoundResult {
  const { db } = store;
  const target = { mode: 'pr' as const, repoKey: repoKeyOf(o.ref), planPath: null, branch: null, prNumber: o.ref.number };
  const targetId = upsertTarget(db, target);
  const marker = identityMarker(o.ref, pr.headSha);
  const r = db
    .prepare(
      `INSERT INTO rounds (target_id, round_no, mode, head_sha, base_sha, roster_json, started_at, status, kind, marker, dry_run, needs_ruling)
       VALUES (?, ?, 'pr', ?, ?, ?, ?, 'identity', 'identity', ?, ?, ?)`,
    )
    .run(targetId, count.roundNo, pr.headSha, pr.baseSha, JSON.stringify(rosterOf(o.config)), now(), marker, o.dryRun ? 1 : 0, userCr ? 1 : 0);
  const roundId = Number(r.lastInsertRowid);
  const detail = {
    match,
    pr: { owner: o.ref.owner, repo: o.ref.repo, number: o.ref.number, author: pr.author, base_ref: pr.baseRef, default_branch: pr.defaultBranch, head_sha: pr.headSha },
    reviews_seen: pr.reviews.map((x) => x.id),
    participants,
    user_change_request: userCr,
    round_count: { round_no: count.roundNo, count: count.count },
  };
  insertEvent(db, 'identity-prepared', roundId, detail);
  if (userCr) insertEvent(db, 'needs-ruling', roundId, { why: 'user-change-request' });
  const dir = roundDirOf(o.layout, roundId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'identity.json'), `${JSON.stringify({ round_id: roundId, marker, ...detail }, null, 2)}\n`, { flag: 'wx' });
  warnings.push(`identity path: this head's tree equals ${match.commitId.slice(0, 7)}, approved on #${match.number}; no seats run (plan 3.10)`);
  return { kind: 'identity', roundId, roundNo: count.roundNo, match, warnings };
}
