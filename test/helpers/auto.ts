import { join } from 'node:path';
import { adjudicate, adjudicationContext, validateAdjudicationText } from '../../src/adjudicate/index.js';
import { runPass, type AdjudicateStep, type PassOptions, type PassReport } from '../../src/auto/pass.js';
import type { Notice } from '../../src/auto/notify.js';
import { parseConfigText, type CouncilConfig } from '../../src/config/index.js';
import { roundSummary, type RoundSummary } from '../../src/engine/index.js';
import { ghApi } from '../../src/forge/github.js';
import { adjudicationFromSummary } from './adjudication.js';
import { API, FAKE_GH, fakeGh, filesFor, ghReview, pr2Routes, pushCommit, sourceRepo, type FakeGh, type Routes, type SourceRepo } from './github.js';
import { fakeAdapters, fakeHome, harness, ROSTER_TOML, type FakeCases, type Harness } from './round.js';

/*
 * The auto daemon's world for the state-machine tests (P8): the recorded PR #2 reopened with a new head D, reviewed
 * as `reviewer-x` (the recorded council's login allowlisted), found by a stubbed search; the fake legs; and an
 * adjudication step that stores a document built from the settled round (or the real headless adjudicator, where a
 * test says so). Every request the stub saw is in `gh.requests()`.
 */

export const PULL = `${API}/pulls/2`;
export const SEARCH = 'GET search/issues q=is:pr is:open draft:false review-requested:@me user:sabotage-dev';
export const LOGIN = 'reviewer-x';
export const REPO_KEY = 'github.com/sabotage-dev/sabotage-council';
type Json = Record<string, unknown>;

export const prItem = (number = 2, repo = 'sabotage-dev/sabotage-council', extra: Json = {}): Json => ({
  number,
  repository_url: `https://api.github.com/repos/${repo}`,
  user: { login: 'repo-owner' },
  draft: false,
  state: 'open',
  pull_request: {},
  ...extra,
});
export const searchOf = (...items: Json[]): Routes[string] => ({ json: { total_count: items.length, incomplete_results: false, items } });

export const json = (routes: Routes, key: string): Json => (routes[key] as { json: Json }).json;
export const jsonList = (routes: Routes, key: string): Json[] => (routes[key] as { json: Json[] }).json;

/** Moves the PR to a new head commit on top of `parent` (default the current head). */
export function moveTo(routes: Routes, src: SourceRepo, sha: string): void {
  routes[`GET ${PULL}/files`] = { json: filesFor(src, sha) };
  (json(routes, `GET ${PULL}`)['head'] as Json)['sha'] = sha;
  jsonList(routes, `GET ${PULL}/commits`).push({ sha });
  const pr = ((json(routes, 'graphql')['data'] as Json)['repository'] as Json)['pullRequest'] as Json;
  for (const n of (pr['commits'] as Json)['nodes'] as Json[]) (n['commit'] as Json)['oid'] = sha;
}

export type AdjKind = 'approve' | 'owed' | 'ruling' | 'hold' | 'fail';

/** A valid adjudication of a settled round, of one kind. */
export function docFor(summary: RoundSummary, kind: Exclude<AdjKind, 'fail'>): Json {
  if (kind === 'approve') return adjudicationFromSummary(summary, { outcome: 'follow-up', verdict: 'SHIP', approve: true });
  if (kind === 'hold') return adjudicationFromSummary(summary, { outcome: 'follow-up', verdict: 'SHIP', approve: false, needsRuling: true });
  const doc = adjudicationFromSummary(summary, { outcome: 'owed', verdict: 'NEEDS-WORK', approve: false }) as Json & { findings: Json[] };
  const f = doc.findings[0];
  if (f === undefined) throw new Error('the replayed legs raised no finding');
  f['severity'] = 'HIGH';
  if (kind === 'ruling') {
    f['outcome'] = 'ruling';
    doc['verdict'] = 'SHIP-WITH-FIXES';
    doc['needs_ruling'] = true;
    doc['blocker_call'] = 'A ruling is needed on the replayed finding.';
  }
  return doc;
}

export interface World {
  h: Harness;
  src: SourceRepo;
  routes: Routes;
  gh: FakeGh;
  d: string;
  config: CouncilConfig;
  legEnv: NodeJS.ProcessEnv;
  notices: Notice[];
  adj: { kind: AdjKind; calls: number };
  /** Writes the routes again after a test changed them (the stub reads routes.json on every call). */
  sync: () => void;
  pass: (over?: Partial<PassOptions>) => Promise<PassReport>;
  posts: () => Array<{ method: string; path: string; body: unknown }>;
  /** Makes GitHub list a review (the stub's reviews read). */
  addReview: (r: Json) => void;
}

export const adjStep =
  (w: Pick<World, 'adj'>): AdjudicateStep =>
  async (store, layout, roundId) => {
    w.adj.calls++;
    if (w.adj.kind === 'fail') return { outcome: 'failed', reason: 'the adjudicator run did not ratify: capacity (a test failure)' };
    const summary = roundSummary(store, layout, roundId);
    const text = JSON.stringify(docFor(summary, w.adj.kind));
    // Stored as an interactive adjudication would be (the replayed legs all raise one HIGH, which headless rules make a
    // ruling unless owed); the real headless path has its own test.
    const check = validateAdjudicationText(text, adjudicationContext(store, layout, roundId).ctx);
    if (!check.ok) throw new Error(`the test document is invalid: ${check.errors.join('; ')}`);
    const r = adjudicate(store, layout, roundId, text);
    return r.stored ? { outcome: 'adjudicated', reason: 'adjudicated' } : { outcome: 'failed', reason: 'rejected' };
  };

export async function world(o: { auto?: string; cases?: FakeCases; edit?: (routes: Routes, src: SourceRepo, d: string) => void } = {}): Promise<World> {
  const h = harness();
  const src = sourceRepo();
  const routes = pr2Routes(src.shas);
  const d = pushCommit(src, 'D', { 'src/step8.py': 'def step8(x):\n    return x + 8\n' });
  moveTo(routes, src, d);
  Object.assign(json(routes, `GET ${PULL}`), { state: 'open', merged: false });
  routes[`POST ${PULL}/reviews`] = { echoReview: { id: 990001, login: LOGIN } };
  routes['GET user'] = { json: { login: LOGIN } };
  routes[SEARCH] = searchOf(prItem(), prItem(9, 'work-org/secret-service', { user: { login: 'someone' } }));
  o.edit?.(routes, src, d);
  const gh = fakeGh(routes);
  const toml = `${ROSTER_TOML}\n[github]\nlogin = "${LOGIN}"\ncouncil_logins = ["repo-owner"]\n\n[adjudicator]\nmodel = "claude-opus-5-5"\n\n[auto]\nrepos_allow = ["sabotage-dev/*"]\n${o.auto ?? ''}\n`;
  const parsed = await parseConfigText(toml);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  const { env: legEnv } = fakeHome(o.cases ?? {});
  const notices: Notice[] = [];
  const w: World = {
    h,
    src,
    routes,
    gh,
    d,
    config: parsed.config,
    legEnv,
    notices,
    adj: { kind: 'approve', calls: 0 },
    sync: () => gh.setRoutes(routes),
    pass: (over = {}) =>
      runPass(h.store, {
        config: w.config,
        configPath: '/dev/null',
        layout: h.layout,
        api: ghApi({ bin: FAKE_GH, env: gh.env }),
        dryRun: false,
        adapters: fakeAdapters,
        env: w.legEnv,
        mirrorSource: () => ({ url: src.repo }),
        legPollMs: 20,
        legTimeoutMs: 20_000,
        adjudicate: adjStep(w),
        deliver: (n) => {
          notices.push(n);
          return { ok: true, via: 'test', detail: 'ok' };
        },
        caffeinate: null,
        ...over,
      }),
    posts: () => gh.requests().filter((r) => r.method !== 'GET' && r.key !== 'graphql'),
    addReview: (r) => {
      jsonList(routes, `GET ${PULL}/reviews`).push(r);
      gh.setRoutes(routes);
    },
  };
  return w;
}

/** The review the stub echoed for a POST, as GitHub would list it afterwards. */
export function landed(w: World, id = 990001, at = '2026-11-13T12:00:00Z'): Json {
  const post = w.posts().filter((p) => p.method === 'POST').at(-1);
  if (post === undefined) throw new Error('no POST');
  const b = post.body as { commit_id: string; event: string; body: string };
  const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[b.event] ?? 'COMMENTED';
  return ghReview(id, LOGIN, state, b.commit_id, at, b.body);
}

export const ledgerRows = (h: Harness): Array<Record<string, unknown>> => h.store.db.prepare('SELECT * FROM ledger ORDER BY rowid').all() as Array<Record<string, unknown>>;
export const roundsCount = (h: Harness): number => (h.store.db.prepare('SELECT count(*) AS n FROM rounds').get() as { n: number }).n;
export { join, fakeAdapters, fakeHome, ghReview, pushCommit };
