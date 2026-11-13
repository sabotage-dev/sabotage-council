import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adjudicate } from '../src/adjudicate/index.js';
import { getEvents, getLegs, getRound, roundSummary, runLegs, type RoundSummary } from '../src/engine/index.js';
import { postRound } from '../src/engine/post.js';
import { preparePrRound, type PrRoundOptions } from '../src/engine/pr.js';
import { ghApi } from '../src/forge/github.js';
import { checkPrFiles } from '../src/forge/mirror.js';
import { PR_FILES_MAX } from '../src/forge/pr.js';
import { parseConfigText, type CouncilConfig } from '../src/config/index.js';
import { cleanScratchAfterAll } from './helpers/fixtures.js';
import { FAKE_GH, fakeGh, filesFor, pr2Routes, pushCommit, sourceRepo, type FakeGh, type Routes, type SourceRepo } from './helpers/github.js';
import { git } from './helpers/git-fixture.js';
import { fakeAdapters, fakeHome, harness, ROSTER_TOML, type FakeCases, type Harness } from './helpers/round.js';
import { adjudicationFromSummary, type AdjOptions } from './helpers/adjudication.js';

cleanScratchAfterAll();

const REF = { owner: 'sabotage-dev', repo: 'sabotage-council', number: 2 };

async function config(extra = '[github]\nlogin = "repo-owner"\n'): Promise<CouncilConfig> {
  const r = await parseConfigText(`${ROSTER_TOML}\n${extra}`);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.config;
}

interface World {
  h: Harness;
  src: SourceRepo;
  gh: FakeGh;
  options: (o?: Partial<PrRoundOptions>) => PrRoundOptions;
}

async function world(edit: (routes: Routes, src: SourceRepo) => void = () => undefined, cfg?: CouncilConfig): Promise<World> {
  const h = harness();
  const src = sourceRepo();
  const routes = pr2Routes(src.shas);
  edit(routes, src);
  const gh = fakeGh(routes);
  const c = cfg ?? (await config());
  return {
    h,
    src,
    gh,
    options: (o = {}) => ({
      config: c,
      configPath: '/dev/null',
      layout: h.layout,
      ref: REF,
      api: ghApi({ bin: FAKE_GH, env: gh.env }),
      source: () => ({ url: src.repo }),
      dryRun: true,
      nonce: '0123456789ab',
      ...o,
    }),
  };
}

describe('pr rounds: the recorded PR #2 replayed', () => {
  it('counts the three council reviews, re-runs round 3 on the reviewed head as a delta from round 2, and carries round 2 as an item', async () => {
    const w = await world();
    const r = preparePrRound(w.h.store, w.options());
    expect(r.kind).toBe('council');
    if (r.kind !== 'council') return;
    const i = r.prepared.inputs;
    expect(i).toMatchObject({ mode: 'pr', roundNo: 3, rule: 'serious', scope: 'delta', baseline: w.src.shas['C6'], head: w.src.shas['C7'], label: 'sabotage-dev/sabotage-council#2' });
    expect(r.count).toMatchObject({ count: 3, headCounted: true, baseline: w.src.shas['C6'] });
    expect(i.earlierItems.map((x) => x.id)).toEqual(['R5880077789']);
    const round = getRound(w.h.store.db, i.roundId)!;
    expect(round).toMatchObject({ kind: 'council', dry_run: 1, marker: `sabotage-council round 3 on sabotage-dev/sabotage-council#2 at ${w.src.shas['C7']!.slice(0, 7)}` });
    const brief = readFileSync(i.briefFile, 'utf8');
    expect(brief).toContain('TARGET: sabotage-dev/sabotage-council#2');
    expect(brief).toContain('only the delta, FOLD.diff');
    const root = r.prepared.inputs.root;
    expect(readFileSync(join(root, 'PR.md'), 'utf8')).toMatch(/^DATA: Title: build: P0 scaffold/);
    expect(readFileSync(join(root, 'PREVIOUS-REVIEWS.md'), 'utf8')).toContain('DATA: Item R5880077789 (from council review by repo-owner):');
    const fold = readFileSync(join(root, 'FOLD.diff'), 'utf8');
    expect([...fold.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1])).toEqual(['src/config/rules.ts', 'src/config/validate.ts', 'test/config.test.ts']);
    expect(existsSync(join(root, 'sabotage-council', 'src', 'config', 'rules.ts'))).toBe(true);
    expect((getEvents(w.h.store.db, i.roundId)[0]?.detail as { pr: { files: unknown } }).pr.files).toEqual({ listed: 30, checked: true, note: '30 changed file(s), as GitHub lists them' });
    const summary = roundSummary(w.h.store, w.h.layout, i.roundId);
    expect(summary.pr).toMatchObject({ kind: 'council', dry_run: true, author: 'repo-owner', trusted: true });
    expect(getEvents(w.h.store.db, i.roundId).map((e) => e.kind)).toEqual(['round-prepared']);
  });
});

const API_PULL = 'repos/sabotage-dev/sabotage-council/pulls/2';
type Json = Record<string, unknown>;
const json = (routes: Routes, key: string): Json => (routes[key] as { json: Json }).json;
const jsonList = (routes: Routes, key: string): Json[] => (routes[key] as { json: Json[] }).json;

/** Moves the PR's head to `sha` in the recorded JSON (pull, commits, CI, and the changed files when `src` has it). */
function moveHead(routes: Routes, sha: string, src?: SourceRepo): void {
  if (src !== undefined) routes[`GET ${API_PULL}/files`] = { json: filesFor(src, sha) };
  (json(routes, `GET ${API_PULL}`)['head'] as Json)['sha'] = sha;
  jsonList(routes, `GET ${API_PULL}/commits`).push({ sha });
  const pr = ((json(routes, 'graphql')['data'] as Json)['repository'] as Json)['pullRequest'] as Json;
  for (const n of (pr['commits'] as Json)['nodes'] as Json[]) (n['commit'] as Json)['oid'] = sha;
}

const reopen = (routes: Routes): void => {
  Object.assign(json(routes, `GET ${API_PULL}`), { state: 'open', merged: false });
};

describe('pr rounds: preparation rules', () => {
  it('fails closed when a GitHub read fails: no round row, nothing built', async () => {
    const w = await world((r) => {
      r[`GET ${API_PULL}/reviews`] = { fail: 'gh: Server Error (HTTP 502)' };
    });
    expect(() => preparePrRound(w.h.store, w.options())).toThrow(/GET repos\/sabotage-dev\/sabotage-council\/pulls\/2\/reviews failed: gh: Server Error/);
    expect(w.h.store.db.prepare('SELECT count(*) AS n FROM rounds').get()).toMatchObject({ n: 0 });
  });

  it("fails closed when GitHub's changed files differ from the fetched base and head", async () => {
    const w = await world((r) => {
      jsonList(r, `GET ${API_PULL}/files`).push({ filename: 'src/elsewhere.ts', status: 'added' });
    });
    expect(() => preparePrRound(w.h.store, w.options())).toThrow(/GitHub's changed files differ from the fetched base and head: GitHub lists "src\/elsewhere.ts"/);
    expect(w.h.store.db.prepare('SELECT count(*) AS n FROM rounds').get()).toMatchObject({ n: 0 });
    const renamed = await world((r) => {
      const files = jsonList(r, `GET ${API_PULL}/files`);
      files.splice(files.findIndex((f) => f['filename'] === 'test/doctor.test.ts'), 1);
    });
    expect(() => preparePrRound(renamed.h.store, renamed.options())).toThrow(/the fetched commits also change "test\/doctor.test.ts"/);
  });

  it('refuses a closed PR without --dry-run, and a PR whose head or base the mirror cannot fetch', async () => {
    const w = await world();
    expect(() => preparePrRound(w.h.store, w.options({ dryRun: false }))).toThrow(/is merged: a closed pull request takes only --dry-run/);
    const gone = await world((r) => moveHead(r, 'e'.repeat(40)));
    expect(() => preparePrRound(gone.h.store, gone.options())).toThrow(/the head eeeeeee of sabotage-dev\/sabotage-council#2 could not be fetched/);
  });

  it('refuses an author without write access under trusted-only, and records the untrusted policy under untrusted-too', async () => {
    const read = (r: Routes): void => {
      r['GET repos/sabotage-dev/sabotage-council/collaborators/repo-owner/permission'] = { json: { permission: 'read' } };
    };
    const w = await world(read);
    expect(() => preparePrRound(w.h.store, w.options())).toThrow(/has no write access .* set pr.interactive_adjudication = "untrusted-too"/);
    // A permission GitHub will not give is unknown, so untrusted.
    const hidden = await world((r) => {
      r['GET repos/sabotage-dev/sabotage-council/collaborators/repo-owner/permission'] = { fail: 'gh: Not Found (HTTP 404)' };
    });
    expect(() => preparePrRound(hidden.h.store, hidden.options())).toThrow(/permission: unknown/);
    const too = await world(read, await config('[github]\nlogin = "repo-owner"\n[pr]\ninteractive_adjudication = "untrusted-too"\n'));
    const r = preparePrRound(too.h.store, too.options());
    expect(r.warnings.join('\n')).toContain('council.untrusted_seat_policy = "fallback"');
    if (r.kind !== 'council') throw new Error('expected a council round');
    expect(roundSummary(too.h.store, too.h.layout, r.prepared.inputs.roundId).pr?.trusted).toBe(false);
  });

  it('a new head after three rounds is round 4, HIGH only, a delta from round 3, carrying round 3 as an item', async () => {
    const w = await world((r, src) => {
      reopen(r);
      moveHead(r, pushCommit(src, 'D', { 'src/step8.py': 'x = 8\n' }), src);
    });
    const r = preparePrRound(w.h.store, w.options({ dryRun: false }));
    if (r.kind !== 'council') throw new Error('expected a council round');
    expect(r.prepared.inputs).toMatchObject({ roundNo: 4, rule: 'high-only', scope: 'delta', baseline: w.src.shas['C7'] });
    expect(r.prepared.inputs.earlierItems.map((i) => i.id)).toEqual(['R5880199419']);
    expect(readFileSync(r.prepared.inputs.briefFile, 'utf8')).toContain('From round 4 only HIGH blocks');
  });

  it('falls back to a full review on a rebase, listing the changed files, and keeps the round rule (D17)', async () => {
    const w = await world((r, src) => {
      reopen(r);
      moveHead(r, pushCommit(src, 'R', { 'src/rebased.py': 'x = 1\n' }, src.shas['C5']), src);
    });
    const r = preparePrRound(w.h.store, w.options({ dryRun: false }));
    if (r.kind !== 'council') throw new Error('expected a council round');
    expect(r.prepared.inputs).toMatchObject({ roundNo: 4, rule: 'high-only', scope: 'fallback', baseline: w.src.shas['C7'] });
    expect(r.prepared.inputs.fullRoundReason).toContain('is not an ancestor of this head (force-push or rebase)');
    const brief = readFileSync(r.prepared.inputs.briefFile, 'utf8');
    expect(brief).toContain('DATA: "sabotage-council/src/rebased.py"');
    expect(brief).toContain('This round is a full review, but this rule still applies (D17).');
  });

  it('fetches a head the pull ref has moved past, by its exact sha', async () => {
    const w = await world((r, src) => {
      reopen(r);
      // GitHub's API names head H, but refs/pull/2/head already points elsewhere (it moved after the read).
      const h = pushCommit(src, 'H', { 'src/step8.py': 'x = 8\n' });
      moveHead(r, h, src);
      git(src.repo, ['update-ref', 'refs/pull/2/head', src.shas['C7']!]);
    });
    const r = preparePrRound(w.h.store, w.options({ dryRun: false }));
    if (r.kind !== 'council') throw new Error('expected a council round');
    expect(r.prepared.inputs.head).toBe(w.src.shas['H']);
  });

  it('a missing baseline is fetched exactly first, and when it stays missing the brief says "changed files unknown"', async () => {
    const w = await world();
    // A credit on a head GitHub no longer has, submitted after round 3: it is the newest counted head.
    w.h.store.db
      .prepare("INSERT INTO credits (repo, num, review_id, commit_id, submitted_at, credited_by, credited_at) VALUES ('github.com/sabotage-dev/sabotage-council', 2, 1, ?, '2026-11-12T19:00:00Z', 'repo-owner', 'x')")
      .run('e'.repeat(40));
    const r = preparePrRound(w.h.store, w.options());
    if (r.kind !== 'council') throw new Error('expected a council round');
    expect(r.prepared.inputs).toMatchObject({ roundNo: 4, scope: 'fallback', baseline: 'e'.repeat(40) });
    expect(readFileSync(r.prepared.inputs.briefFile, 'utf8')).toContain('Files that differ from the baseline: changed files unknown (baseline unavailable).');
    expect(roundSummary(w.h.store, w.h.layout, r.prepared.inputs.roundId).pr?.count).toMatchObject({ baseline: 'e'.repeat(40) });
    const detail = getEvents(w.h.store.db, r.prepared.inputs.roundId).find((e) => e.kind === 'round-prepared')?.detail as { pr: { baseline_fetch: string } };
    expect(detail.pr.baseline_fetch).toBe('unavailable');
  });

  it('fetches a baseline the PR refs no longer reach, by its exact sha', async () => {
    const w = await world((r, src) => {
      const old = pushCommit(src, 'X', { 'src/old.py': 'x = 0\n' }, src.shas['C6']);
      git(src.repo, ['update-ref', 'refs/pull/2/head', src.shas['C7']!]);
      jsonList(r, `GET ${API_PULL}/reviews`).push({ id: 7001, user: { login: 'repo-owner' }, state: 'COMMENTED', commit_id: old, submitted_at: '2026-11-12T19:00:00Z', body: `sabotage-council round 4 on sabotage-dev/sabotage-council#2 at ${old.slice(0, 7)}` });
    });
    const r = preparePrRound(w.h.store, w.options());
    if (r.kind !== 'council') throw new Error('expected a council round');
    const detail = getEvents(w.h.store.db, r.prepared.inputs.roundId).find((e) => e.kind === 'round-prepared')?.detail as { pr: { baseline_fetch: string } };
    expect(detail.pr.baseline_fetch).toBe('fetched');
    expect(r.prepared.inputs).toMatchObject({ roundNo: 4, baseline: w.src.shas['X'], scope: 'fallback' });
    expect(r.prepared.inputs.fullRoundReason).toContain('not an ancestor');
  });

  it('an empty fold (the same tree as the baseline) is a full review that keeps its number', async () => {
    const w = await world((r, src) => {
      reopen(r);
      git(src.repo, ['checkout', '--quiet', '--detach', src.shas['C7']!]);
      git(src.repo, ['commit', '--quiet', '--allow-empty', '-m', 'empty']);
      const sha = git(src.repo, ['rev-parse', 'HEAD']);
      git(src.repo, ['update-ref', 'refs/pull/2/head', sha]);
      git(src.repo, ['checkout', '--quiet', 'main']);
      moveHead(r, sha, src);
    });
    const r = preparePrRound(w.h.store, w.options({ dryRun: false }));
    if (r.kind !== 'council') throw new Error('expected a council round');
    expect(r.prepared.inputs).toMatchObject({ roundNo: 4, scope: 'fallback' });
    expect(readFileSync(r.prepared.inputs.briefFile, 'utf8')).toContain('Files that differ from the baseline: none; the content equals what was reviewed.');
  });

  it("puts the user's own change request on an earlier head into the brief as asks, and holds on one on this head", async () => {
    const earlier = await world((r, src) => {
      jsonList(r, `GET ${API_PULL}/reviews`).push({ id: 8001, user: { login: 'repo-owner' }, state: 'CHANGES_REQUESTED', commit_id: src.shas['C6'], submitted_at: '2026-11-12T18:45:00Z', body: 'Please name the steps.' });
      r[`GET ${API_PULL}/comments`] = { json: [{ id: 1, pull_request_review_id: 8001, user: { login: 'repo-owner' }, path: 'src/step6.py', line: 1, body: 'This one too.' }] };
    });
    const a = preparePrRound(earlier.h.store, earlier.options());
    if (a.kind !== 'council') throw new Error('expected a council round');
    expect(a.prepared.inputs.humanAsks).toEqual(['Please name the steps.', 'src/step6.py:1: This one too.']);
    const brief = readFileSync(a.prepared.inputs.briefFile, 'utf8');
    expect(brief).toContain("## Your reviewer's open change request");
    expect(brief).toContain('H2:\nDATA: src/step6.py:1: This one too.');

    const onHead = await world((r, src) => {
      jsonList(r, `GET ${API_PULL}/reviews`).push({ id: 8002, user: { login: 'repo-owner' }, state: 'CHANGES_REQUESTED', commit_id: src.shas['C7'], submitted_at: '2026-11-12T19:00:00Z', body: 'Not yet.' });
    });
    const b = preparePrRound(onHead.h.store, onHead.options());
    if (b.kind !== 'council') throw new Error('expected a council round');
    expect(b.prepared.inputs.humanAsks).toEqual([]);
    expect(b.warnings.join('\n')).toContain('stands on this head: the round needs a ruling');
    expect(getEvents(onHead.h.store.db, b.prepared.inputs.roundId).map((e) => e.kind)).toContain('needs-ruling');
  });

  it('takes the identity path when another PR approved this tree, and never advances the round count with it', async () => {
    const approvedElsewhere = (r: Routes, src: SourceRepo): void => {
      r['GET search/issues'] = { json: { items: [{ number: 2 }, { number: 9 }] } };
      r['GET repos/sabotage-dev/sabotage-council/pulls/9/reviews'] = { json: [{ id: 9101, user: { login: 'repo-owner' }, state: 'APPROVED', commit_id: src.shas['C6'], submitted_at: 'x', body: 'ok' }] };
      const tree = git(src.repo, ['rev-parse', `${src.shas['C7']!}^{tree}`]);
      r[`GET repos/sabotage-dev/sabotage-council/git/commits/${src.shas['C6']!}`] = { json: { tree: { sha: tree } } };
    };
    const w = await world(approvedElsewhere);
    const r = preparePrRound(w.h.store, w.options());
    expect(r).toMatchObject({ kind: 'identity', roundNo: 3, match: { number: 9, reviewId: 9101, commitId: w.src.shas['C6'] } });
    if (r.kind !== 'identity') return;
    const round = getRound(w.h.store.db, r.roundId)!;
    expect(round).toMatchObject({ kind: 'identity', status: 'identity', marker: `sabotage-council identity approval on sabotage-dev/sabotage-council#2 at ${w.src.shas['C7']!.slice(0, 7)}` });
    expect(roundSummary(w.h.store, w.h.layout, r.roundId)).toMatchObject({ scope: 'identity', legs: [], pr: { kind: 'identity', identity: { number: 9 } } });
    // --no-identity takes a council round instead.
    const council = preparePrRound(w.h.store, w.options({ identity: false }));
    expect(council.kind).toBe('council');
    // A base that is not the default branch never takes the identity path, even with the same approval to find.
    const offMain = await world((rr, src) => {
      approvedElsewhere(rr, src);
      Object.assign((json(rr, `GET ${API_PULL}`)['base'] as Json), { ref: 'release' });
    });
    git(offMain.src.repo, ['branch', 'release', offMain.src.shas['BASE']!]);
    expect(preparePrRound(offMain.h.store, offMain.options()).kind).toBe('council');
  });
});

/** Prepares, runs and (optionally) adjudicates a pr round through the fake legs. */
async function councilRound(
  w: World,
  o: Partial<PrRoundOptions> = {},
  adj?: AdjOptions,
  cases: FakeCases = {},
): Promise<{ id: number; summary: RoundSummary; adjudicated: ReturnType<typeof adjudicate> | null }> {
  const r = preparePrRound(w.h.store, w.options(o));
  if (r.kind !== 'council') throw new Error('expected a council round');
  const id = r.prepared.inputs.roundId;
  const { env } = fakeHome(cases);
  await runLegs(w.h.store, w.h.layout, id, { adapters: fakeAdapters, env, pollMs: 20, legTimeoutMs: 20_000 });
  const summary = roundSummary(w.h.store, w.h.layout, id);
  const adjudicated = adj === undefined ? null : adjudicate(w.h.store, w.h.layout, id, JSON.stringify(adjudicationFromSummary(summary, adj)));
  return { id, summary, adjudicated };
}

const post = (w: World, id: number, mode: 'dry-run' | 'post') => postRound(w.h.store, { config: w.options().config, layout: w.h.layout, api: w.options().api, roundId: id, mode });

describe('pr rounds: holds, asks and the post step', () => {
  it("the user's change request on this head forces needs_ruling, and the post is a COMMENT with the ruling section", async () => {
    const w = await world((r, src) => {
      jsonList(r, `GET ${API_PULL}/reviews`).push({ id: 8002, user: { login: 'repo-owner' }, state: 'CHANGES_REQUESTED', commit_id: src.shas['C7'], submitted_at: '2026-11-12T19:00:00Z', body: 'Not yet.' });
    });
    const { id, adjudicated } = await councilRound(w, {}, { outcome: 'refuted', verdict: 'SHIP', approve: false });
    expect(adjudicated?.stored).toBe(false);
    expect(adjudicated?.outcome.ok === false && adjudicated.outcome.errors).toContain('[human-asks] your own change request (review 8002) stands on this head, so needs_ruling must be true (plan 3.8)');
    const summary = roundSummary(w.h.store, w.h.layout, id);
    const ok = adjudicate(w.h.store, w.h.layout, id, JSON.stringify(adjudicationFromSummary(summary, { outcome: 'refuted', verdict: 'SHIP', approve: false, needsRuling: true })));
    expect(ok.stored).toBe(true);
    const p = post(w, id, 'dry-run');
    // The user is the author here, so row 1 matches first; the ruling section still rides along (N10).
    expect([p.event, p.row]).toEqual(['COMMENT', 1]);
    expect(p.body).toContain('## Ruling needed');
    expect(p.body).toContain('- Your own change request (review 8002) stands on this head (plan 3.8).');
  }, 60_000);

  it('asks from an earlier-head change request need one human_ask row each; an open ask is owed', async () => {
    const w = await world((r, src) => {
      jsonList(r, `GET ${API_PULL}/reviews`).push({ id: 8001, user: { login: 'repo-owner' }, state: 'CHANGES_REQUESTED', commit_id: src.shas['C6'], submitted_at: '2026-11-12T18:45:00Z', body: 'Please name the steps.' });
    });
    const { id } = await councilRound(w);
    const summary = roundSummary(w.h.store, w.h.layout, id);
    const missing = adjudicate(w.h.store, w.h.layout, id, JSON.stringify(adjudicationFromSummary(summary, { outcome: 'refuted', verdict: 'SHIP', approve: false })), { check: true });
    expect(missing.outcome.ok === false && missing.outcome.errors).toContain('[human-asks] ask H1 has no human_asks row');
    const stored = adjudicate(w.h.store, w.h.layout, id, JSON.stringify(adjudicationFromSummary(summary, { outcome: 'refuted', verdict: 'SHIP-WITH-FIXES', approve: false, asks: ['open'] })));
    expect(stored.outcome.ok && stored.outcome.effective).toMatchObject({ verdict: 'SHIP-WITH-FIXES', owed: 1 });
    const p = post(w, id, 'dry-run');
    expect(p.body).toContain('- H1: open.');
    expect(p.body).toMatch(/\| 1 \| \(no file\) \| MEDIUM: ask H1 \| this \| yes \|/);
  }, 60_000);

  it('an interrupted post adopts the review that landed, and refuses to re-post a body that changed', async () => {
    const open = (r: Routes, src: SourceRepo): void => {
      reopen(r);
      moveHead(r, src.shas['D'] ?? pushCommit(src, 'D', { 'src/step8.py': 'x = 8\n' }), src);
    };
    const w = await world(open);
    const { id } = await councilRound(w, { dryRun: false }, { outcome: 'owed', verdict: 'NEEDS-WORK', approve: false });
    const marker = getRound(w.h.store.db, id)!.marker!;
    w.h.store.db.prepare("INSERT INTO events (ts, kind, round_id, detail_json) VALUES ('x', 'posting', ?, ?)").run(id, JSON.stringify({ body_sha256: 'f'.repeat(64) }));
    const changed = post(w, id, 'post');
    expect(changed.outcome).toBe('refused');
    expect(changed.problems.join()).toContain('interrupted');
    const routes = pr2Routes(w.src.shas);
    open(routes, w.src);
    jsonList(routes, `GET ${API_PULL}/reviews`).push({ id: 4242, user: { login: 'repo-owner' }, state: 'COMMENTED', commit_id: w.src.shas['D'], submitted_at: '2026-11-13T00:00:00Z', body: `${marker}\n\nbody` });
    w.gh.setRoutes(routes);
    const adopted = post(w, id, 'post');
    expect(adopted).toMatchObject({ outcome: 'already-posted', reviewId: 4242, event: 'COMMENT' });
    expect(getRound(w.h.store.db, id)).toMatchObject({ review_id: 4242, event_posted: 'COMMENT' });
    expect(w.gh.requests().filter((q) => q.method === 'POST')).toEqual([]);
  }, 60_000);

  it('an identity round renders an APPROVE with the identity marker, held when the live re-check finds the approval dismissed', async () => {
    const identityRoutes = (r: Routes, src: SourceRepo, state: string): void => {
      Object.assign(json(r, `GET ${API_PULL}`), { state: 'open', merged: false, user: { login: 'someone' } });
      r['GET repos/sabotage-dev/sabotage-council/collaborators/someone/permission'] = { json: { permission: 'write' } };
      r['GET search/issues'] = { json: { items: [{ number: 9 }] } };
      r['GET repos/sabotage-dev/sabotage-council/pulls/9/reviews'] = { json: [{ id: 9101, user: { login: 'repo-owner' }, state: 'APPROVED', commit_id: src.shas['C6'], submitted_at: 'x', body: 'ok' }] };
      const tree = git(src.repo, ['rev-parse', `${src.shas['C7']!}^{tree}`]);
      r[`GET repos/sabotage-dev/sabotage-council/git/commits/${src.shas['C6']!}`] = { json: { tree: { sha: tree } } };
      r[`GET repos/sabotage-dev/sabotage-council/git/commits/${src.shas['C7']!}`] = { json: { tree: { sha: tree } } };
      r['GET repos/sabotage-dev/sabotage-council/pulls/9/reviews/9101'] = { json: { id: 9101, user: { login: 'repo-owner' }, state, commit_id: src.shas['C6'], submitted_at: 'x', body: 'ok' } };
    };
    const w = await world((r, src) => identityRoutes(r, src, 'APPROVED'));
    const r = preparePrRound(w.h.store, w.options({ dryRun: false }));
    if (r.kind !== 'identity') throw new Error('expected the identity path');
    const ok = post(w, r.roundId, 'dry-run');
    expect([ok.outcome, ok.event, ok.row]).toEqual(['rendered', 'APPROVE', 3]);
    expect(ok.body?.split('\n')[0]).toBe(`sabotage-council identity approval on sabotage-dev/sabotage-council#2 at ${w.src.shas['C7']!.slice(0, 7)}`);
    const routes = pr2Routes(w.src.shas);
    identityRoutes(routes, w.src, 'DISMISSED');
    w.gh.setRoutes(routes);
    const held = post(w, r.roundId, 'dry-run');
    expect([held.event, held.row]).toEqual(['COMMENT', 4]);
    expect(held.body).toContain('Approval held: identity, the live re-check failed: the approval on #9 is now DISMISSED.');
    // A hold-listed repository, red CI and the off switch hold it too.
    identityRoutes(routes, w.src, 'APPROVED');
    w.gh.setRoutes(routes);
    const hold = await config('[github]\nlogin = "repo-owner"\n[auto]\nrepos_hold = ["sabotage-dev/*"]\n');
    expect(postRound(w.h.store, { config: hold, layout: w.h.layout, api: w.options().api, roundId: r.roundId, mode: 'dry-run' }).row).toBe(4);
    const pr = ((json(routes, 'graphql')['data'] as Json)['repository'] as Json)['pullRequest'] as Json;
    const node = (((pr['commits'] as Json)['nodes'] as Json[])[0]!['commit'] as Json)['statusCheckRollup'] as Json;
    (((node['contexts'] as Json)['nodes'] as Json[])[0] as Json)['conclusion'] = 'FAILURE';
    w.gh.setRoutes(routes);
    const red = await config('[github]\nlogin = "repo-owner"\n[auto]\nci_gate = "all"\n');
    const redPost = postRound(w.h.store, { config: red, layout: w.h.layout, api: w.options().api, roundId: r.roundId, mode: 'dry-run' });
    expect([redPost.event, redPost.row]).toEqual(['COMMENT', 4]);
    const off = await world((rr, src) => identityRoutes(rr, src, 'APPROVED'), await config('[github]\nlogin = "repo-owner"\n[auto]\nidentity_approval = false\n'));
    expect(preparePrRound(off.h.store, off.options({ dryRun: false })).kind).toBe('council');
  }, 60_000);
});

describe('pr rounds: the untrusted seat policy (plan 5.2)', () => {
  async function untrusted(policy: string): Promise<CouncilConfig> {
    const r = await parseConfigText(`${ROSTER_TOML.replace('leg_timeout_minutes = 1', `leg_timeout_minutes = 1\nuntrusted_seat_policy = "${policy}"`)}\n[github]\nlogin = "repo-owner"\n[pr]\ninteractive_adjudication = "untrusted-too"\n`);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return r.config;
  }
  const readOnly = (r: Routes): void => {
    r['GET repos/sabotage-dev/sabotage-council/collaborators/repo-owner/permission'] = { json: { permission: 'read' } };
  };
  const legsOf = (w: World, id: number): string[][] => getLegs(w.h.store.db, id).map((l) => [l.seat_id, l.role, l.backend, l.status]);

  it('fallback: a seat below strong runs its strong fallback; skip: it is out; allow: it runs, acknowledged', async () => {
    const fb = await world(readOnly, await untrusted('fallback'));
    const a = await councilRound(fb);
    expect(legsOf(fb, a.id)).toEqual([
      ['a', 'fallback', 'claude', 'PASS'],
      ['b', 'primary', 'claude', 'PASS'],
      ['c', 'primary', 'claude', 'PASS'],
    ]);
    expect(getEvents(fb.h.store.db, a.id).map((e) => e.kind)).toContain('untrusted-fallback');

    const sk = await world(readOnly, await untrusted('skip'));
    const b = await councilRound(sk);
    expect(legsOf(sk, b.id).map((l) => l[0])).toEqual(['b', 'c']);
    expect(getEvents(sk.h.store.db, b.id).find((e) => e.kind === 'seat-out')?.detail).toMatchObject({ seat: 'a', why: expect.stringContaining('not strong') as unknown });

    const al = await world(readOnly, await untrusted('allow'));
    const c = await councilRound(al);
    expect(legsOf(al, c.id).map((l) => l[0])).toEqual(['a', 'b', 'c']);
    expect(getEvents(al.h.store.db, c.id).find((e) => e.kind === 'untrusted-allow')?.detail).toMatchObject({ seat: 'a', enforcement: 'sandboxed-exec' });

    // fallback: a fallback that is not strong either is not taken. With claude on an untested version every claude
    // occupant is below strong, so no seat has a strong leg: every seat is out and the round fails visibly.
    const none = await world(readOnly, await untrusted('fallback'));
    const n = await councilRound(none, {}, undefined, { claudeTop: { version: '2.1.999' } });
    expect(legsOf(none, n.id)).toEqual([]);
    expect(getRound(none.h.store.db, n.id)?.status).toBe('failed');
    expect(getEvents(none.h.store.db, n.id).filter((e) => e.kind === 'seat-out').map((e) => (e.detail as { seat: string }).seat)).toEqual(['a', 'b', 'c']);

    // A trusted author's round never applies the policy.
    const trusted = await world(undefined, await untrusted('skip'));
    const t = await councilRound(trusted);
    expect(legsOf(trusted, t.id).map((l) => l[0])).toEqual(['a', 'b', 'c']);
  }, 120_000);
});

describe('pr rounds: a superseded round', () => {
  it('posts nothing when the head moved, and its owed rows still carry into the next round', async () => {
    const open = (r: Routes, src: SourceRepo): void => {
      reopen(r);
      moveHead(r, src.shas['D'] ?? pushCommit(src, 'D', { 'src/step8.py': 'x = 8\n' }), src);
    };
    const w = await world(open);
    const { id } = await councilRound(w, { dryRun: false }, { outcome: 'owed', verdict: 'NEEDS-WORK', approve: false });
    const owedId = (w.h.store.db.prepare("SELECT id FROM findings WHERE round_id = ? AND outcome = 'owed'").get(id) as { id: string }).id;
    const routes = pr2Routes(w.src.shas);
    open(routes, w.src);
    const e = pushCommit(w.src, 'E', { 'src/step9.py': 'x = 9\n' }, w.src.shas['D']);
    moveHead(routes, e, w.src);
    w.gh.setRoutes(routes);
    const p = post(w, id, 'post');
    expect(p.outcome).toBe('superseded');
    expect(w.gh.requests().filter((q) => q.method === 'POST')).toEqual([]);
    expect(getRound(w.h.store.db, id)?.status).toBe('superseded');
    expect(roundSummary(w.h.store, w.h.layout, id).adjudication).toMatchObject({ verdict: 'NEEDS-WORK', owed: 1 });
    const next = preparePrRound(w.h.store, w.options({ dryRun: false }));
    if (next.kind !== 'council') throw new Error('expected a council round');
    // The superseded round posted nothing, so GitHub still counts three heads: E is round 4 too.
    expect(next.prepared.inputs.roundNo).toBe(4);
    expect(next.prepared.inputs.earlierItems.map((i) => i.id)).toEqual([owedId, 'R5880199419']);
  }, 60_000);
});

describe("the changed-file cross-check (GitHub's list against the fetched commits)", () => {
  it('counts a rename as its old and new paths, and skips a list at GitHub\'s 3,000-file limit', () => {
    const src = sourceRepo();
    git(src.repo, ['checkout', '--quiet', '--detach', src.shas['C7']!]);
    // LICENSE is in the base: renaming it shows on GitHub as one renamed entry, and in git (no renames) as two paths.
    git(src.repo, ['mv', 'LICENSE', 'LICENSE.txt']);
    git(src.repo, ['commit', '--quiet', '-m', 'rename']);
    const head = git(src.repo, ['rev-parse', 'HEAD']);
    git(src.repo, ['checkout', '--quiet', 'main']);
    const mirror = { gitDir: join(src.repo, '.git'), source: src.repo };
    const listed = filesFor(src, src.shas['C7']!).map((f) => ({ path: f.filename, previous: null as string | null }));
    expect(checkPrFiles(mirror, src.shas['BASE']!, head, [...listed, { path: 'LICENSE.txt', previous: 'LICENSE' }])).toMatchObject({ checked: true });
    expect(() => checkPrFiles(mirror, src.shas['BASE']!, head, [...listed, { path: 'LICENSE.txt', previous: null }])).toThrow(/the fetched commits also change "LICENSE"/);
    const many = Array.from({ length: PR_FILES_MAX }, (_, i) => ({ path: `f${i}`, previous: null }));
    expect(checkPrFiles(mirror, src.shas['BASE']!, head, many)).toEqual({ checked: false, note: `GitHub lists ${PR_FILES_MAX} files, its limit: the list was not cross-checked` });
  });
});
