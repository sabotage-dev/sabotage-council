import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import { layoutOf, type StorePaths } from '../src/cli/round.js';
import { getEvents, getRound, runWorker, type RoundSummary } from '../src/engine/index.js';
import { openStore } from '../src/store/index.js';
import { fakeRegistry } from './fake-registry.js';
import { adjudicationFromSummary, type AdjOptions } from './helpers/adjudication.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { API, FAKE_GH, fakeGh, filesFor, ghReview, pr2Routes, pushCommit, sourceRepo, type FakeGh, type Routes, type SourceRepo } from './helpers/github.js';
import { fakeAdapters, fakeHome, ROSTER_TOML } from './helpers/round.js';

/*
 * The fake-GitHub end to end (P6 acceptance 2): the real CLI, a stub `gh` replaying the recorded PR #2 JSON, a local
 * stand-in remote for the mirror, the fake-CLI legs, `adjudicate`, and `post` in --dry-run and in a faked --post,
 * with every request the stub saw checked.
 */

cleanScratchAfterAll();

const REGISTRY = fakeRegistry({
  codex: [{ id: 'gpt-6.1-sol', family: 'openai' }],
  claude: [
    { id: 'claude-sonnet-5-5', family: 'anthropic' },
    { id: 'claude-haiku-5-5', family: 'anthropic' },
    { id: 'claude-opus-5-5', family: 'anthropic' },
  ],
});
const PULL = `${API}/pulls/2`;
type Json = Record<string, unknown>;

interface Cli {
  run: (...args: string[]) => Promise<{ code: number; lines: string[] }>;
  paths: StorePaths;
  workers: Array<Promise<unknown>>;
  gh: FakeGh;
  src: SourceRepo;
}

function cli(routes: Routes, src: SourceRepo, github = '[github]\nlogin = "repo-owner"\n'): Cli {
  const dir = scratch('sc-pr-cli-');
  const configPath = join(dir, 'config.toml');
  writeFileSync(configPath, `${ROSTER_TOML}\n${github}`);
  const paths: StorePaths = { configPath, dbPath: join(dir, 'data', 'council.db'), rootsPath: join(dir, 'roots') };
  const { env: legEnv } = fakeHome({});
  const gh = fakeGh(routes);
  const workers: Array<Promise<unknown>> = [];
  const inProcess = (roundId: number, p: StorePaths): void => {
    const store = openStore(p.dbPath);
    workers.push(runWorker(store, layoutOf(p), roundId, { adapters: fakeAdapters, env: legEnv, pollMs: 20, legTimeoutMs: 20_000 }).finally(() => store.close()));
  };
  const run = async (...args: string[]): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    let code = 0;
    const io: ProgramIo = {
      write: (l) => lines.push(l),
      env: { HOME: dir, ...gh.env },
      setExitCode: (c) => (code = c),
      adapters: fakeAdapters,
      registry: REGISTRY,
      cwd: dir,
      startWorker: inProcess,
      waitPollMs: 20,
      ghBin: FAKE_GH,
      mirrorSource: () => ({ url: src.repo }),
    };
    await buildProgram(io).exitOverride().parseAsync(['node', 'sabotage-council', ...args, '--config', paths.configPath, '--db', paths.dbPath, '--roots', paths.rootsPath]);
    return { code, lines };
  };
  return { run, paths, workers, gh, src };
}

/** Starts a pr round, waits for its legs, adjudicates it; returns the round id and the summary. */
async function roundThrough(c: Cli, startArgs: string[], adj: AdjOptions): Promise<{ id: number; summary: RoundSummary }> {
  const started = await c.run('round', 'start', 'pr', 'sabotage-dev/sabotage-council#2', ...startArgs, '--json');
  expect(started.code, started.lines.join('\n')).toBe(0);
  const id = (JSON.parse(started.lines.at(-1)!) as { round_id: number }).round_id;
  const waited = await c.run('round', 'wait', String(id));
  expect(waited.code).toBe(0);
  const summary = JSON.parse(waited.lines.join('\n')) as RoundSummary;
  const file = join(summary.round_dir, 'ADJUDICATION.draft.json');
  writeFileSync(file, JSON.stringify(adjudicationFromSummary(summary, adj)));
  const stored = await c.run('adjudicate', String(id), file);
  expect(stored.code, stored.lines.join('\n')).toBe(0);
  return { id, summary };
}

const json = (routes: Routes, key: string): Json => (routes[key] as { json: Json }).json;
const jsonList = (routes: Routes, key: string): Json[] => (routes[key] as { json: Json[] }).json;

/** PR #2 reopened with a new head D on it, reviewed as `reviewer-x` with the recorded council's login allowlisted. */
function openWithNewHead(): { routes: Routes; src: SourceRepo; d: string } {
  const src = sourceRepo();
  const routes = pr2Routes(src.shas);
  const d = pushCommit(src, 'D', { 'src/step8.py': 'def step8(x):\n    return x + 8\n' });
  routes[`GET ${PULL}/files`] = { json: filesFor(src, d) };
  Object.assign(json(routes, `GET ${PULL}`), { state: 'open', merged: false });
  (json(routes, `GET ${PULL}`)['head'] as Json)['sha'] = d;
  jsonList(routes, `GET ${PULL}/commits`).push({ sha: d });
  const pr = ((json(routes, 'graphql')['data'] as Json)['repository'] as Json)['pullRequest'] as Json;
  for (const n of (pr['commits'] as Json)['nodes'] as Json[]) (n['commit'] as Json)['oid'] = d;
  routes[`POST ${PULL}/reviews`] = { echoReview: { id: 990001, login: 'reviewer-x' } };
  return { routes, src, d };
}
const REVIEWER = '[github]\nlogin = "reviewer-x"\ncouncil_logins = ["repo-owner"]\n';
const posts = (gh: FakeGh) => gh.requests().filter((r) => r.method !== 'GET' && r.key !== 'graphql');

describe('pr mode end to end through a stub gh (recorded PR #2)', () => {
  it('as recorded: round 3 again on the reviewed head, adjudicated, rendered as a COMMENT (the author row); --post is refused', async () => {
    const src = sourceRepo();
    const c = cli(pr2Routes(src.shas), src);
    const { id, summary } = await roundThrough(c, ['--dry-run'], { outcome: 'owed', verdict: 'NEEDS-WORK', approve: false });
    expect(summary).toMatchObject({ round_no: 3, rule: 'serious', scope: 'delta', baseline_sha: src.shas['C6'], quorum: { label: 'council', ratified: 3 } });
    expect(summary.earlier_items.map((i) => i.id)).toEqual(['R5880077789']);
    expect(summary.pr).toMatchObject({ kind: 'council', dry_run: true, next: `sabotage-council adjudicate ${id} <ADJUDICATION.json>` });
    const shown = JSON.parse((await c.run('round', 'show', String(id), '--json')).lines.join('\n')) as RoundSummary;
    expect(shown.pr).toMatchObject({ next: `sabotage-council post ${id} --dry-run`, event_posted: null });
    const text = (await c.run('round', 'show', String(id))).lines;
    expect(text).toContain(`pr: council round, dry run (never posts); marker "sabotage-council round 3 on sabotage-dev/sabotage-council#2 at ${src.shas['C7']!.slice(0, 7)}"`);
    expect(text).toContain(`posted: nothing yet; next: sabotage-council post ${id} --dry-run`);

    const reads = c.gh.requests().map((r) => r.key);
    expect(reads).toEqual(
      expect.arrayContaining([`GET ${PULL}`, `GET ${PULL}/reviews`, `GET ${PULL}/comments`, `GET ${API}/issues/2/comments`, `GET ${PULL}/commits`, `GET ${API}/collaborators/repo-owner/permission`, 'GET search/issues']),
    );
    const dry = await c.run('post', String(id), '--dry-run');
    expect(dry.code, dry.lines.join('\n')).toBe(0);
    const marker = `sabotage-council round 3 on sabotage-dev/sabotage-council#2 at ${src.shas['C7']!.slice(0, 7)}`;
    expect(dry.lines[0]).toBe(`round ${id} dry run (nothing posted): rendered, event COMMENT (row 1), commit_id ${src.shas['C7']!}`);
    const body = dry.lines.slice(dry.lines.indexOf('----- body -----') + 1, dry.lines.indexOf('----- end -----')).join('\n');
    expect(body.split('\n')[0]).toBe(marker);
    expect(body).toContain('**Verdict: NEEDS-WORK, 1 owed.** Posted as a comment: you are the author of this pull request');
    expect(body).toContain('- R5880077789: closed.');
    expect(body).not.toContain(summary.nonce!);
    expect(readFileSync(join(summary.round_dir, 'REVIEW.dry-run.md'), 'utf8')).toBe(`${body}\n`);
    expect(posts(c.gh)).toEqual([]);

    const refused = await c.run('post', String(id), '--post');
    expect(refused.code).toBe(1);
    expect(refused.lines.join('\n')).toContain('was started with --dry-run: it can render its post but never post');
    const both = await c.run('post', String(id));
    expect(both.lines).toEqual(['error: give exactly one of --dry-run or --post']);
    expect(posts(c.gh)).toEqual([]);
    const store = openStore(c.paths.dbPath);
    try {
      expect(getRound(store.db, id)).toMatchObject({ event_posted: null, review_id: null, dry_run: 1, status: 'adjudicated' });
      expect(getEvents(store.db, id).map((e) => e.kind)).toEqual(expect.arrayContaining(['round-prepared', 'legs-settled', 'adjudicated', 'post-dry-run', 'post-refused']));
    } finally {
      store.close();
    }
  }, 60_000);

  it('faked --post: a new head is round 4, approved on the reviewed head with the exact body; a second --post posts nothing', async () => {
    const { routes, src, d } = openWithNewHead();
    const c = cli(routes, src, REVIEWER);
    const { id, summary } = await roundThrough(c, [], { outcome: 'refuted', verdict: 'SHIP', approve: true });
    expect(summary).toMatchObject({ round_no: 4, rule: 'high-only', scope: 'delta', baseline_sha: src.shas['C7'] });
    expect(summary.earlier_items.map((i) => i.id)).toEqual(['R5880199419']);

    const dry = await c.run('post', String(id), '--dry-run', '--json');
    const preview = JSON.parse(dry.lines.join('\n')) as { event: string; row: number; body: string; outcome: string };
    expect(preview).toMatchObject({ outcome: 'rendered', event: 'APPROVE', row: 5 });
    expect(posts(c.gh)).toEqual([]);

    const posted = await c.run('post', String(id), '--post');
    expect(posted.code, posted.lines.join('\n')).toBe(0);
    const writes = posts(c.gh);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'POST', path: `${PULL}/reviews`, body: { commit_id: d, event: 'APPROVE', body: preview.body } });
    const body = (writes[0]!.body as { body: string }).body;
    expect(body.split('\n')[0]).toBe(`sabotage-council round 4 on sabotage-dev/sabotage-council#2 at ${d.slice(0, 7)}`);
    expect(body).toContain('**Verdict: SHIP, 0 owed.** Approved.');
    expect(body).toContain('CI: green (no required checks on this head).');
    const store = openStore(c.paths.dbPath);
    try {
      expect(getRound(store.db, id)).toMatchObject({
        event_posted: 'APPROVE',
        review_id: 990001,
        posted_commit_id: d,
        posted_body_sha256: createHash('sha256').update(body).digest('hex'),
      });
    } finally {
      store.close();
    }
    const again = await c.run('post', String(id), '--post');
    expect(again.lines[0]).toContain('already-posted');
    expect(posts(c.gh)).toHaveLength(1);
  }, 60_000);

  it('a CI read that fails is "CI unknown": the approval is held as a COMMENT (row 8), never posted as an APPROVE', async () => {
    const { routes, src } = openWithNewHead();
    const c = cli(routes, src, REVIEWER);
    const { id } = await roundThrough(c, [], { outcome: 'refuted', verdict: 'SHIP', approve: true });
    c.gh.setRoutes({ ...routes, graphql: { fail: 'gh: Something went wrong (HTTP 502)' } });
    const r = await c.run('post', String(id), '--dry-run', '--json');
    const out = JSON.parse(r.lines.join('\n')) as { event: string; row: number; body: string; ci: { state: string } };
    expect([out.event, out.row, out.ci.state]).toEqual(['COMMENT', 8, 'unknown']);
    expect(out.body).toContain('Approval held: CI unknown: CI could not be read: GraphQL query failed');
  }, 60_000);

  it('faked --post: a PR closed after the round started takes no post', async () => {
    const { routes, src } = openWithNewHead();
    const c = cli(routes, src, REVIEWER);
    const { id } = await roundThrough(c, [], { outcome: 'refuted', verdict: 'SHIP', approve: true });
    const closed = structuredClone(json(routes, `GET ${PULL}`));
    Object.assign(closed, { state: 'closed', merged: true });
    c.gh.setRoutes({ ...routes, [`GET ${PULL}`]: { json: closed } });
    const r = await c.run('post', String(id), '--post');
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('sabotage-dev/sabotage-council#2 is closed: nothing posts');
    expect(posts(c.gh)).toEqual([]);
    // A dry run still renders it.
    expect((await c.run('post', String(id), '--dry-run')).code).toBe(0);
  }, 60_000);

  it('faked --post: the head moved before the post, so the round is superseded and nothing posts', async () => {
    const { routes, src } = openWithNewHead();
    const c = cli(routes, src, REVIEWER);
    const moved = structuredClone(json(routes, `GET ${PULL}`));
    (moved['head'] as Json)['sha'] = 'f'.repeat(40);
    const { id } = await roundThrough(c, [], { outcome: 'refuted', verdict: 'SHIP', approve: true });
    c.gh.setRoutes({ ...routes, [`GET ${PULL}`]: { json: moved } });
    const r = await c.run('post', String(id), '--post');
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('the head moved from');
    expect(posts(c.gh)).toEqual([]);
    const store = openStore(c.paths.dbPath);
    try {
      expect(getRound(store.db, id)?.status).toBe('superseded');
    } finally {
      store.close();
    }
  }, 60_000);

  it('faked --post: a review that lands during the approval gets our approval dismissed (the approval race)', async () => {
    const { routes, src, d } = openWithNewHead();
    const c = cli(routes, src, REVIEWER);
    const { id } = await roundThrough(c, [], { outcome: 'refuted', verdict: 'SHIP', approve: true });
    const before = jsonList(routes, `GET ${PULL}/reviews`);
    const after = [...before, ghReview(990002, 'alice', 'CHANGES_REQUESTED', d, '2026-11-13T12:00:01Z', 'Wait, step 8 is wrong.')];
    c.gh.setRoutes({ ...routes, [`GET ${PULL}/reviews`]: { seq: [{ json: before }, { json: after }] }, [`PUT ${PULL}/reviews/990001/dismissals`]: { json: {} } });
    const r = await c.run('post', String(id), '--post');
    expect(r.code, r.lines.join('\n')).toBe(0);
    expect(r.lines.join('\n')).toContain('approval dismissed: sabotage-council: approval withdrawn: a review landed while the approval was posted (alice CHANGES_REQUESTED).');
    expect(posts(c.gh).map((w) => [w.method, w.path])).toEqual([
      ['POST', `${PULL}/reviews`],
      ['PUT', `${PULL}/reviews/990001/dismissals`],
    ]);
    expect(posts(c.gh)[1]?.body).toMatchObject({ event: 'DISMISS' });
  }, 60_000);

  it("faked --post: a COMMENT with nothing owed dismisses our own stale REQUEST_CHANGES, never a human's (N11)", async () => {
    const { routes, src, d } = openWithNewHead();
    const ours = ghReview(7101, 'reviewer-x', 'CHANGES_REQUESTED', src.shas['C7']!, '2026-11-12T19:00:00Z', `sabotage-council round 3 on sabotage-dev/sabotage-council#2 at ${src.shas['C7']!.slice(0, 7)}\n\n**Verdict: NEEDS-WORK, 1 owed.**`);
    const human = ghReview(7102, 'alice', 'CHANGES_REQUESTED', src.shas['C7']!, '2026-11-12T19:01:00Z', 'Please rename step 7.');
    // The user's own unmarked change request, on an earlier head: its ask is answered (closed), and it is a human's,
    // so it is never dismissed either.
    const mine = ghReview(7104, 'reviewer-x', 'CHANGES_REQUESTED', src.shas['C6']!, '2026-11-12T18:45:00Z', 'Rename the steps.');
    jsonList(routes, `GET ${PULL}/reviews`).push(ours, human, mine);
    // CI pending: a hold, so a COMMENT (row 8), with nothing owed.
    const pr = ((json(routes, 'graphql')['data'] as Json)['repository'] as Json)['pullRequest'] as Json;
    const rollup = (((pr['commits'] as Json)['nodes'] as Json[])[0]!['commit'] as Json)['statusCheckRollup'] as Json;
    (((rollup['contexts'] as Json)['nodes'] as Json[])[0] as Json)['status'] = 'IN_PROGRESS';
    routes[`GET ${API}/branches/main`] = { json: { name: 'main', protection: { required_status_checks: { contexts: ['ubuntu-latest / Node 22'], checks: [] } } } };
    routes[`PUT ${PULL}/reviews/7101/dismissals`] = { json: {} };
    const c = cli(routes, src, REVIEWER);
    const { id, summary } = await roundThrough(c, [], { outcome: 'refuted', verdict: 'SHIP', approve: true, asks: ['closed'] });
    // Both council reviews at the baseline (neither posted by this store) and Alice's change request are earlier items.
    expect(summary.earlier_items.map((i) => i.id).sort()).toEqual(['R5880199419', 'R7101', 'R7102']);
    const dry = await c.run('post', String(id), '--dry-run');
    expect(dry.lines[0]).toContain('event COMMENT (row 8)');
    expect(dry.lines).toContain('would dismiss our review 7101: would be dismissed: superseded by this round, nothing owed');
    const r = await c.run('post', String(id), '--post');
    expect(r.code, r.lines.join('\n')).toBe(0);
    expect(posts(c.gh).map((w) => [w.method, w.path])).toEqual([
      ['POST', `${PULL}/reviews`],
      ['PUT', `${PULL}/reviews/7101/dismissals`],
    ]);
    expect((posts(c.gh)[0]?.body as { body: string; event: string }).event).toBe('COMMENT');
    expect((posts(c.gh)[0]?.body as { body: string }).body).toContain('Approval held: CI pending: ubuntu-latest / Node 22.');
    void d;
  }, 60_000);

  it('N11: a ruling COMMENT never dismisses our stale REQUEST_CHANGES', async () => {
    const { routes, src, d } = openWithNewHead();
    const ours = ghReview(7101, 'reviewer-x', 'CHANGES_REQUESTED', src.shas['C7']!, '2026-11-12T19:00:00Z', `sabotage-council round 3 on sabotage-dev/sabotage-council#2 at ${src.shas['C7']!.slice(0, 7)}`);
    // The user's own unmarked change request on this head: a hold, so the round needs a ruling (row 2).
    const hold = ghReview(7103, 'reviewer-x', 'CHANGES_REQUESTED', d, '2026-11-12T19:05:00Z', 'Not this way.');
    (routes[`GET ${PULL}/reviews`] as { json: Json[] }).json.push(ours, hold);
    const c = cli(routes, src, REVIEWER);
    await roundThrough(c, [], { outcome: 'refuted', verdict: 'SHIP', approve: false, needsRuling: true });
    const r = await c.run('post', '1', '--dry-run');
    expect(r.lines[0]).toContain('event COMMENT (row 2)');
    expect(r.lines.join('\n')).not.toContain('would dismiss');
    expect(r.lines.join('\n')).toContain('## Ruling needed');
  }, 60_000);

  it('credit: a vouched-for unmarked review counts at its own head and time (plan 3.6 step 4)', async () => {
    const src = sourceRepo();
    const routes = pr2Routes(src.shas);
    // An unmarked review by a council login on C5, submitted between rounds 1 and 2: not counted until credited.
    const unmarked = ghReview(6001, 'repo-owner', 'COMMENTED', src.shas['C5']!, '2026-11-12T18:20:00Z', 'Reviewed by hand; nothing owed.');
    (routes[`GET ${PULL}/reviews`] as { json: Json[] }).json.push(unmarked);
    routes[`GET ${PULL}/reviews/6001`] = { json: unmarked };
    const c = cli(routes, src);
    const before = await c.run('round', 'start', 'pr', 'sabotage-dev/sabotage-council#2', '--dry-run', '--json');
    expect((JSON.parse(before.lines.at(-1)!) as { round_no: number }).round_no).toBe(3);
    const credited = await c.run('credit', 'sabotage-dev/sabotage-council#2', '6001', '--note', 'hand review');
    expect(credited.lines).toEqual([`credited review 6001 on sabotage-dev/sabotage-council#2: head ${src.shas['C5']!.slice(0, 7)}, submitted 2026-11-12T18:20:00Z`]);
    const after = await c.run('round', 'start', 'pr', 'sabotage-dev/sabotage-council#2', '--dry-run', '--json');
    // Four counted heads in time order: C4 (round 1 marker), C5 (the credit), C6 (round 2 marker: 3 heads, max(3, 2)),
    // C7 (round 3 marker: 4 heads, max(4, 3)). C7 has an event, so it is round 4.
    expect(JSON.parse(after.lines.at(-1)!)).toMatchObject({ round_no: 4, counted: { count: 4, head_counted: true, events: 4 } });
    const store = openStore(c.paths.dbPath);
    try {
      expect(store.db.prepare('SELECT review_id, commit_id, submitted_at, credited_by, note FROM credits').all().map((r) => ({ ...r }))).toEqual([
        { review_id: 6001, commit_id: src.shas['C5'], submitted_at: '2026-11-12T18:20:00Z', credited_by: 'repo-owner', note: 'hand review' },
      ]);
    } finally {
      store.close();
    }
    await Promise.all(c.workers);
  }, 60_000);

  it('credit Sabotage-Dev/Sabotage-Council#2 is counted by round start pr sabotage-dev/sabotage-council#2: one key per repository', async () => {
    const src = sourceRepo();
    const routes = pr2Routes(src.shas);
    const unmarked = ghReview(6001, 'repo-owner', 'COMMENTED', src.shas['C5']!, '2026-11-12T18:20:00Z', 'Reviewed by hand; nothing owed.');
    (routes[`GET ${PULL}/reviews`] as { json: Json[] }).json.push(unmarked);
    // GitHub answers either spelling; the stub's routes are exact, so the credit's spelling gets its own route.
    routes['GET repos/Sabotage-Dev/Sabotage-Council/pulls/2/reviews/6001'] = { json: unmarked };
    const c = cli(routes, src);
    const credited = await c.run('credit', 'Sabotage-Dev/Sabotage-Council#2', '6001');
    expect(credited.code, credited.lines.join('\n')).toBe(0);
    const after = await c.run('round', 'start', 'pr', 'sabotage-dev/sabotage-council#2', '--dry-run', '--json');
    expect(JSON.parse(after.lines.at(-1)!)).toMatchObject({ round_no: 4, counted: { count: 4, events: 4 } });
    const store = openStore(c.paths.dbPath);
    try {
      expect(store.db.prepare('SELECT repo FROM credits').all().map((r) => ({ ...r }))).toEqual([{ repo: 'github.com/sabotage-dev/sabotage-council' }]);
      expect(store.db.prepare("SELECT repo FROM targets WHERE kind = 'pr'").all().map((r) => ({ ...r }))).toEqual([{ repo: 'github.com/sabotage-dev/sabotage-council' }]);
    } finally {
      store.close();
    }
    await Promise.all(c.workers);
  }, 60_000);

  it('fails closed on a GitHub read that fails: round start exits 1 and stores no round', async () => {
    const src = sourceRepo();
    const routes = pr2Routes(src.shas);
    routes[`GET ${PULL}/commits`] = { fail: 'gh: Bad credentials (HTTP 401)' };
    const c = cli(routes, src);
    const r = await c.run('round', 'start', 'pr', 'sabotage-dev/sabotage-council#2', '--dry-run');
    expect(r.code).toBe(1);
    expect(r.lines.at(-1)).toContain('Bad credentials (HTTP 401)');
    const store = openStore(c.paths.dbPath);
    try {
      expect(store.db.prepare('SELECT count(*) AS n FROM rounds').get()).toMatchObject({ n: 0 });
    } finally {
      store.close();
    }
  });
});
