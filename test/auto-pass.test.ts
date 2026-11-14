import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAIM_STALE_MS } from '../src/auto/ledger.js';
import { autoDir, BUSY_NOTIFY_AFTER, lastReport, recordsSha } from '../src/auto/pass.js';
import { API, type Routes } from './helpers/github.js';
import { mkdirSync } from 'node:fs';
import { scratch } from './helpers/fixtures.js';
import { getEvents, getLegs, getRound, roundDirOf } from '../src/engine/index.js';
import { codexCase, claudeCase, fakeHome, OCC } from './helpers/round.js';
import { cleanScratchAfterAll } from './helpers/fixtures.js';
import { ghReview, json, landed, ledgerRows, LOGIN, moveTo, PULL, prItem, pushCommit, REPO_KEY, roundsCount, SEARCH, searchOf, world, type World } from './helpers/auto.js';

/*
 * The auto daemon's state machine (P8 acceptance 1): every case runs real passes over the stub gh (the recorded PR #2
 * reopened with a new head), the fake-CLI legs and a stored adjudication, and checks the ledger, the rounds and every
 * request the stub saw.
 */

cleanScratchAfterAll();

const row = (w: World): Record<string, unknown> => ledgerRows(w.h).find((r) => r['head'] === w.d)!;
const posts = (w: World, method = 'POST'): number => w.posts().filter((p) => p.method === method).length;

/** A second requested PR (#3, same repository, no reviews) after #2 in the search: only its pull and reviews read. */
function secondPr(routes: Routes): void {
  routes[SEARCH] = searchOf(prItem(2), prItem(3));
  routes[`GET ${API}/pulls/3`] = { json: { ...json(routes, `GET ${PULL}`), number: 3 } };
  routes[`GET ${API}/pulls/3/reviews`] = { json: [] };
}

function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}

/** Pushes a new head E on the PR and points the stub at it; later POSTs echo `nextId`. */
function pushE(w: World, nextId = 990002): string {
  const e = pushCommit(w.src, 'E', { 'src/step9.py': 'def step9(x):\n    return x + 9\n' }, w.d);
  moveTo(w.routes, w.src, e);
  w.routes[`POST ${PULL}/reviews`] = { echoReview: { id: nextId, login: LOGIN } };
  w.sync();
  return e;
}

describe('auto pass: queue, round, adjudication, one review (plan 9.4)', { timeout: 120_000 }, () => {
  it('reviews a requested PR once: one round, one APPROVE on the head; a work repository result is never read or queued', async () => {
    const w = await world();
    const r = await w.pass();
    expect(r.outcome, JSON.stringify(r.errors)).toBe('done');
    expect(r.dropped).toBe(1);
    expect(r.queries).toEqual(['is:pr is:open draft:false review-requested:@me user:sabotage-dev']);
    const rows = ledgerRows(w.h);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo: REPO_KEY, num: 2, head: w.d, state: 'approved', attempts: 1, round_no: 4, event: 'APPROVE', review_id: 990001, dry_run: 0 });
    const sent = w.posts();
    expect(sent.map((p) => `${p.method} ${p.path}`)).toEqual(['POST repos/sabotage-dev/sabotage-council/pulls/2/reviews']);
    expect(sent[0]?.body).toMatchObject({ commit_id: w.d, event: 'APPROVE' });
    expect(w.gh.requests().filter((q) => q.path.includes('work-org'))).toEqual([]);
    const round = getRound(w.h.store.db, rows[0]!['round_id'] as number)!;
    expect(round).toMatchObject({ mode: 'pr', round_no: 4, status: 'adjudicated', event_posted: 'APPROVE', review_id: 990001, dry_run: 0 });
    expect(r.rounds_last_24h).toBe(1);
    expect(w.notices).toEqual([]);
    // A second pass on the same head does nothing: the row is approved.
    w.routes[SEARCH] = searchOf(prItem());
    w.addReview(landed(w));
    const again = await w.pass();
    expect(again.candidates.find((c) => c.pr === 'sabotage-dev/sabotage-council#2')).toMatchObject({ action: 'done' });
    expect(roundsCount(w.h)).toBe(1);
    expect(posts(w)).toBe(1);
  });

  it('reviews an author without write access with the headless adjudicator: no refusal, the untrusted seat policy applied', async () => {
    const w = await world({
      edit: (routes) => {
        routes['GET repos/sabotage-dev/sabotage-council/collaborators/repo-owner/permission'] = { json: { permission: 'read' } };
      },
    });
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved' });
    const prepared = getEvents(w.h.store.db, row(w)['round_id'] as number).find((e) => e.kind === 'round-prepared')?.detail as { pr: { trusted: boolean; untrusted: unknown } };
    expect(prepared.pr).toMatchObject({ trusted: false, untrusted: { policy: 'fallback', interactive_adjudication: 'headless' } });
  });

  it('skips drafts, your own PRs and repos_skip without reading them', async () => {
    const w = await world({
      auto: 'repos_skip = ["sabotage-dev/private-*"]\n',
      edit: (routes) => {
        routes[SEARCH] = searchOf(prItem(5, 'sabotage-dev/sabotage-council', { draft: true }), prItem(6, 'sabotage-dev/sabotage-council', { user: { login: LOGIN } }), prItem(7, 'sabotage-dev/private-notes'));
      },
    });
    const r = await w.pass();
    expect(r.outcome).toBe('done');
    expect(r.dropped).toBe(1);
    expect(r.candidates.map((c) => `${c.pr} ${c.action}: ${c.why}`)).toEqual(['sabotage-dev/sabotage-council#5 skipped: a draft', 'sabotage-dev/sabotage-council#6 skipped: your own PR']);
    expect(w.gh.requests().map((q) => q.key)).toEqual(['GET user', 'GET search/issues']);
    expect(ledgerRows(w.h)).toEqual([]);
  });

  it('continues after our own REQUEST_CHANGES: the request cleared, a new head gets a delta round', async () => {
    const w = await world();
    w.adj.kind = 'owed';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'posted', event: 'REQUEST_CHANGES', round_no: 4 });
    // GitHub: the review request cleared with our review; our change request is listed.
    w.routes[SEARCH] = searchOf();
    w.addReview(landed(w));
    const idle = await w.pass();
    expect(idle.candidates).toEqual([{ pr: 'sabotage-dev/sabotage-council#2', head: w.d, source: 'continuation', action: 'done', why: 'the ledger row is posted' }]);
    expect(roundsCount(w.h)).toBe(1);
    const e = pushE(w);
    w.adj.kind = 'approve';
    const r = await w.pass();
    expect(r.candidates.find((c) => c.head === e)).toMatchObject({ source: 'continuation', action: 'queued' });
    const rowE = ledgerRows(w.h).find((x) => x['head'] === e)!;
    expect(rowE).toMatchObject({ state: 'approved', round_no: 5, review_id: 990002 });
    expect(getRound(w.h.store.db, rowE['round_id'] as number)).toMatchObject({ round_no: 5, baseline_sha: w.d });
    expect(posts(w)).toBe(2);
  });

  it('stops continuing after our APPROVE, and continues again once that approval is dismissed', async () => {
    const w = await world();
    await w.pass();
    w.routes[SEARCH] = searchOf();
    const ours = landed(w);
    w.addReview(ours);
    const e = pushE(w);
    const r = await w.pass();
    expect(r.candidates.find((c) => c.head === e)).toMatchObject({ action: 'skipped', why: 'our latest review is APPROVED: not continuing' });
    expect(roundsCount(w.h)).toBe(1);
    ours['state'] = 'DISMISSED';
    w.sync();
    const again = await w.pass();
    expect(again.candidates.find((c) => c.head === e)).toMatchObject({ action: 'queued' });
    expect(ledgerRows(w.h).find((x) => x['head'] === e)).toMatchObject({ state: 'approved', round_no: 5 });
  });

  it('a crash between the POST and the review read: the next pass adopts the review that landed, no second POST', async () => {
    const w = await world();
    let crash = true;
    const r1 = await w.pass({
      hooks: {
        afterPost: () => {
          if (crash) {
            crash = false;
            throw new Error('the daemon died right after the POST');
          }
        },
      },
    });
    expect(r1.errors.join(' ')).toMatch(/interrupted while posting/);
    expect(row(w)).toMatchObject({ state: 'posting', event: 'APPROVE', review_id: null });
    expect(row(w)['records_sha']).toMatch(/^[0-9a-f]{64}$/);
    expect(posts(w)).toBe(1);
    w.addReview(landed(w));
    const r2 = await w.pass();
    expect(r2.outcome).toBe('done');
    expect(row(w)).toMatchObject({ state: 'approved', review_id: 990001 });
    expect(posts(w)).toBe(1);
    expect(getEvents(w.h.store.db, row(w)['round_id'] as number).map((e) => e.kind)).toContain('post-adopted');
  });

  it('a crash before the POST: nothing landed, the stored review posts once while the records still hash to records_sha', async () => {
    const w = await world();
    let crash = true;
    await w.pass({ hooks: { afterPostClaim: () => (crash ? ((crash = false), (() => { throw new Error('died before the POST'); })()) : undefined) } });
    expect(row(w)).toMatchObject({ state: 'posting', event: 'APPROVE' });
    expect(posts(w)).toBe(0);
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', review_id: 990001 });
    expect(posts(w)).toBe(1);
    expect(getEvents(w.h.store.db, row(w)['round_id'] as number).map((e) => e.kind)).toContain('post-reconcile');
  });

  it('a crash before the POST with the records changed since: the row fails visibly and nothing posts', async () => {
    const w = await world();
    let crash = true;
    await w.pass({ hooks: { afterPostClaim: () => (crash ? ((crash = false), (() => { throw new Error('died before the POST'); })()) : undefined) } });
    const roundId = row(w)['round_id'] as number;
    const leg = getLegs(w.h.store.db, roundId).find((l) => l.status === 'PASS')!;
    const answer = join(roundDirOf(w.h.layout, roundId), 'legs', `${leg.seat_id}-${leg.role}-${leg.attempt}`, 'answer.md');
    writeFileSync(answer, `${readFileSync(answer, 'utf8')}\nedited after the post began\n`);
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'failed', attempts: 2 });
    expect(String(row(w)['reason'])).toMatch(/records changed since the post began/);
    expect(posts(w)).toBe(0);
    expect(w.notices.map((n) => n.kind)).toEqual(['failure']);
  });

  it('the PR closes between the render and the POST: nothing posts and the row is skipped, not left posting', async () => {
    const w = await world();
    await w.pass({
      hooks: {
        afterPostClaim: () => {
          Object.assign(json(w.routes, `GET ${PULL}`), { state: 'closed', merged: true });
          w.sync();
        },
      },
    });
    expect(row(w)).toMatchObject({ state: 'skipped', records_sha: null, event: null });
    expect(String(row(w)['reason'])).toMatch(/the PR closed before the post/);
    expect(posts(w)).toBe(0);
    expect(w.notices).toEqual([]);
  });

  it('one review per head across stores: a review with this round marker that lands before the POST is never doubled (P8 round 1 row 2)', async () => {
    // Another store on the same account posts its own review of this round first: the row is skipped, nothing posts.
    const other = await world();
    await other.pass({
      hooks: {
        beforePostRead: (roundId) => {
          const marker = getRound(other.h.store.db, roundId)!.marker!;
          other.addReview(ghReview(7001, LOGIN, 'COMMENTED', other.d, '2026-11-13T12:00:00Z', `${marker}\n\nAnother store's review of this head.`));
        },
      },
    });
    expect(row(other)).toMatchObject({ state: 'skipped', records_sha: null, event: null });
    expect(String(row(other)['reason'])).toMatch(/^the head already has our review: a review by reviewer-x with this round's marker is already on this head \(review 7001, COMMENTED\)/);
    expect(posts(other)).toBe(0);
    expect(other.notices).toEqual([]);
    // The very review this post would send is already there (posted by hand): adopted, with its guards, no second POST.
    const same = await world();
    await same.pass({
      hooks: {
        beforePostRead: (roundId) => {
          const body = readFileSync(join(roundDirOf(same.h.layout, roundId), 'AUTO-POST.md'), 'utf8');
          same.addReview(ghReview(7002, LOGIN, 'APPROVED', same.d, '2026-11-13T12:00:00Z', body));
        },
      },
    });
    expect(row(same)).toMatchObject({ state: 'approved', review_id: 7002, event: 'APPROVE' });
    expect(posts(same)).toBe(0);
    const roundId = row(same)['round_id'] as number;
    expect(getRound(same.h.store.db, roundId)).toMatchObject({ event_posted: 'APPROVE', review_id: 7002 });
    expect(getEvents(same.h.store.db, roundId).find((e) => e.kind === 'post-adopted')?.detail).toMatchObject({ review_id: 7002, preexisting: true });
    expect(getEvents(same.h.store.db, roundId).filter((e) => e.kind === 'guard').map((e) => (e.detail as { outcome: string }).outcome)).toEqual(['kept: no review landed meanwhile and the head held']);
  });

  it('a PR made a draft after the claim posts nothing and waits; a resumed row reads the PR first (P8 round 1 row 3)', async () => {
    const w = await world();
    const draft = (on: boolean): void => {
      Object.assign(json(w.routes, `GET ${PULL}`), { draft: on });
      w.sync();
    };
    // Made a draft right before the POST: nothing posts, and the row waits for it (not a failed attempt).
    await w.pass({ hooks: { beforePostRead: () => draft(true) } });
    expect(posts(w)).toBe(0);
    expect(row(w)).toMatchObject({ state: 'running', attempts: 1, records_sha: null, claim_owner: null });
    expect(String(row(w)['reason'])).toMatch(/^the PR is a draft: the review posts once it is ready/);
    // Still a draft: the resume reads the PR first and leaves the row alone.
    const waiting = await w.pass();
    expect(waiting.candidates.filter((c) => c.source === 'resume')).toEqual([{ pr: 'sabotage-dev/sabotage-council#2', head: w.d, source: 'resume', action: 'skipped', why: 'a draft: the running row resumes once it is ready for review' }]);
    expect(row(w)).toMatchObject({ state: 'running', attempts: 1 });
    expect(posts(w)).toBe(0);
    // Ready again: the round's review posts, on the same attempt and round.
    draft(false);
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', attempts: 1 });
    expect(posts(w)).toBe(1);
    expect(roundsCount(w.h)).toBe(1);
  });

  it('a draft on resume: a posting row is reconciled first, then its re-post refuses the draft and the row waits (P8 round 1 row 3)', async () => {
    const w = await world();
    const draft = (on: boolean): void => {
      Object.assign(json(w.routes, `GET ${PULL}`), { draft: on });
      w.sync();
    };
    let crash = true;
    await w.pass({ hooks: { afterPostClaim: () => (crash ? ((crash = false), (() => { throw new Error('died before the POST'); })()) : undefined) } });
    expect(row(w)).toMatchObject({ state: 'posting' });
    draft(true);
    await w.pass();
    expect(posts(w)).toBe(0);
    expect(row(w)).toMatchObject({ state: 'running', records_sha: null, attempts: 1 });
    const kinds = getEvents(w.h.store.db, row(w)['round_id'] as number).map((e) => e.kind);
    expect(kinds.indexOf('post-reconcile')).toBeGreaterThan(-1);
    expect(kinds.lastIndexOf('post-refused')).toBeGreaterThan(kinds.indexOf('post-reconcile'));
    draft(false);
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', attempts: 1 });
    expect(posts(w)).toBe(1);
  });

  it('the head moves mid-round: the round is superseded and nothing posts; the next pass reviews the new head', async () => {
    const w = await world();
    let e = '';
    await w.pass({
      hooks: {
        afterLegs: () => {
          e = pushE(w, 990001);
        },
      },
    });
    expect(row(w)).toMatchObject({ state: 'superseded' });
    expect(posts(w)).toBe(0);
    const r = await w.pass();
    expect(r.candidates.find((c) => c.head === e)).toMatchObject({ action: 'queued' });
    expect(ledgerRows(w.h).find((x) => x['head'] === e)).toMatchObject({ state: 'approved', round_no: 4 });
    expect(posts(w)).toBe(1);
  });

  it('a human review lands mid-approve: our approval is withdrawn, the row is posted, and you are told', async () => {
    const w = await world();
    w.routes[`PUT ${PULL}/reviews/990001/dismissals`] = { json: {} };
    w.sync();
    await w.pass({
      hooks: {
        afterPost: () => {
          w.addReview(ghReview(8001, 'alice', 'CHANGES_REQUESTED', w.d, '2026-11-13T12:00:01Z', 'Wait, this breaks the API.'));
        },
      },
    });
    expect(row(w)).toMatchObject({ state: 'posted', event: 'APPROVE' });
    expect(String(row(w)['reason'])).toMatch(/withdrawn: a review landed while the approval was posted \(alice CHANGES_REQUESTED\)/);
    expect(posts(w, 'PUT')).toBe(1);
    expect(w.notices.map((n) => n.kind)).toEqual(['approval-dismissed']);
  });

  it('a stale claim is taken over: a dead pid at once, a reused pid once its heartbeat is stale, a live one never', async () => {
    for (const kind of ['dead', 'reused', 'live'] as const) {
      const w = await world();
      const owner = JSON.stringify({ host: hostname(), pid: kind === 'dead' ? deadPid() : process.pid, token: 'gone' });
      await w.pass({
        hooks: {
          afterLegs: () => {
            // The daemon "dies" here, leaving its claim on the row.
            w.h.store.db.prepare('UPDATE ledger SET claim_owner = ?, heartbeat_at = ?').run(owner, new Date().toISOString());
            throw new Error('the daemon died after the legs');
          },
        },
      });
      expect(row(w)).toMatchObject({ state: 'running', claim_owner: owner, attempts: 1 });
      const roundId = row(w)['round_id'] as number;
      const legs = getLegs(w.h.store.db, roundId).length;
      const later = kind === 'reused' ? Date.now() + CLAIM_STALE_MS + 60_000 : Date.now();
      await w.pass({ now: () => later });
      if (kind === 'live') {
        expect(row(w)).toMatchObject({ state: 'running', claim_owner: owner });
        expect(posts(w)).toBe(0);
        continue;
      }
      expect(row(w)).toMatchObject({ state: 'approved', attempts: 1, round_id: roundId });
      expect(roundsCount(w.h)).toBe(1);
      expect(getLegs(w.h.store.db, roundId).length).toBe(legs);
      expect(w.h.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'ledger' AND json_extract(detail_json, '$.change') = 'claim-taken-over'").get()).toMatchObject({ n: 1 });
      expect(posts(w)).toBe(1);
    }
  });

  it('a round is linked to its row in the transaction that creates it: a crash after it resumes that round, never a second (P8 round 1 row 4)', async () => {
    const w = await world();
    const dead = JSON.stringify({ host: hostname(), pid: deadPid(), token: 'dead' });
    let inside: unknown = null;
    await w.pass({
      hooks: {
        roundInserted: (roundId) => {
          // Uncommitted yet: the row already names the round, and the cap already counts it.
          inside = {
            linked: (w.h.store.db.prepare('SELECT round_id FROM ledger WHERE head = ?').get(w.d) as { round_id: number | null }).round_id === roundId,
            counted: (w.h.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'auto-round' AND round_id = ?").get(roundId) as { n: number }).n,
          };
        },
        afterPrepare: () => {
          // The daemon dies right after the round was prepared, before its legs started.
          w.h.store.db.prepare('UPDATE ledger SET claim_owner = ?, heartbeat_at = ?').run(dead, new Date().toISOString());
          throw new Error('the daemon died after the prepare');
        },
      },
    });
    expect(inside).toEqual({ linked: true, counted: 1 });
    const roundId = row(w)['round_id'] as number;
    expect(row(w)).toMatchObject({ state: 'running', attempts: 1, claim_owner: dead });
    expect(getRound(w.h.store.db, roundId)?.status).toBe('running');
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', attempts: 1, round_id: roundId });
    expect(roundsCount(w.h)).toBe(1);
    expect(getLegs(w.h.store.db, roundId).length).toBeGreaterThan(0);
    expect(posts(w)).toBe(1);
  });

  it('a resume that would prepare a round waits at max_rounds_per_day; a running auto round no row references is failed and its roots pruned (P8 round 1 row 4)', async () => {
    const w = await world({ auto: 'max_rounds_per_day = 1\n' });
    // A claim whose pass died before it prepared anything, and one round already in the last 24 h.
    const { claimRow, release } = await import('../src/auto/ledger.js');
    const c = claimRow(w.h.store.db, { repo: REPO_KEY, num: 2, head: w.d }, { attempt: true, dryRun: false });
    if (!c.ok) throw new Error('no claim');
    release(w.h.store.db, c.claim);
    w.h.store.db.prepare("INSERT INTO events (ts, kind, round_id, detail_json) VALUES (?, 'auto-round', NULL, '{}')").run(new Date(Date.now() - 60 * 60_000).toISOString());
    const r = await w.pass();
    expect(r.candidates.find((x) => x.source === 'resume' && x.action === 'deferred')?.why).toBe('max_rounds_per_day (1) reached: 1 rounds in the last 24 h; the row waits');
    expect(roundsCount(w.h)).toBe(0);
    expect(row(w)).toMatchObject({ state: 'running', round_id: null, attempts: 1, claim_owner: null });
    w.h.store.db.prepare("UPDATE events SET ts = ? WHERE kind = 'auto-round'").run(new Date(Date.now() - 25 * 60 * 60_000).toISOString());
    // The cap frees: the resumed row prepares its round, and a crash leaves it running and linked.
    await w.pass({
      hooks: {
        afterPrepare: () => {
          throw new Error('the daemon died after the prepare');
        },
      },
    });
    const orphan = row(w)['round_id'] as number;
    expect(getRound(w.h.store.db, orphan)?.status).toBe('running');
    // The row lets go of it (as a reset does): an auto round no row references. A round of `round start` (no
    // auto-round event) that is running is never touched.
    w.h.store.db.prepare("UPDATE ledger SET round_id = NULL, state = 'skipped', claim_owner = NULL").run();
    const cols = 'target_id, round_no, mode, head_sha, base_sha, baseline_sha, nonce, roster_json, started_at, status, kind, marker, dry_run';
    const manual = Number(w.h.store.db.prepare(`INSERT INTO rounds (${cols}) SELECT ${cols} FROM rounds WHERE id = ?`).run(orphan).lastInsertRowid);
    const p = await w.pass();
    expect(p.pruned.orphans).toBe(1);
    expect(p.pruned.roots).toBeGreaterThan(0);
    expect(getRound(w.h.store.db, orphan)?.status).toBe('failed');
    expect(getEvents(w.h.store.db, orphan).find((e) => e.kind === 'round-failed')?.detail).toMatchObject({ stage: 'orphaned' });
    expect(getRound(w.h.store.db, manual)?.status).toBe('running');
  });

  it('a head already reviewed by us (a marker review on it, another store) is skipped, never reviewed again', async () => {
    const w = await world({
      edit: (routes, _src, d) => {
        (routes[`GET ${PULL}/reviews`] as { json: Array<Record<string, unknown>> }).json.push(
          ghReview(5555, LOGIN, 'COMMENTED', d, '2026-11-13T09:00:00Z', `sabotage-council round 4 on sabotage-dev/sabotage-council#2 at ${d.slice(0, 7)}`),
        );
      },
    });
    const r = await w.pass();
    expect(r.candidates.find((c) => c.pr.endsWith('#2'))).toMatchObject({ action: 'skipped', why: 'already reviewed at this head (review 5555)' });
    expect(row(w)).toMatchObject({ state: 'skipped', review_id: 5555, attempts: 0 });
    expect(roundsCount(w.h)).toBe(0);
    expect(posts(w)).toBe(0);
  });

  it('a held row is superseded when a new head arrives, and the new head is reviewed', async () => {
    const w = await world();
    w.adj.kind = 'ruling';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'needs-ruling' });
    w.addReview(landed(w));
    const e = pushE(w);
    w.adj.kind = 'approve';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'superseded', reason: `a new head ${e.slice(0, 7)} arrived` });
    expect(ledgerRows(w.h).find((x) => x['head'] === e)).toMatchObject({ state: 'approved' });
  });

  it('continuation reads are bounded per pass: beyond the bound a PR waits its turn', async () => {
    const w = await world();
    w.adj.kind = 'owed';
    await w.pass();
    w.routes[SEARCH] = searchOf();
    w.addReview(landed(w));
    const e = pushE(w);
    w.adj.kind = 'approve';
    const none = await w.pass({ continuationReads: 0 });
    expect(none.continuation).toEqual({ read: 0, of: 1 });
    expect(ledgerRows(w.h).find((x) => x['head'] === e)).toBeUndefined();
    const one = await w.pass({ continuationReads: 1 });
    expect(one.continuation).toEqual({ read: 1, of: 1 });
    expect(ledgerRows(w.h).find((x) => x['head'] === e)).toMatchObject({ state: 'approved' });
  });

  it('max_rounds_per_day: the cap defers a new head (no row, no round); rounds older than 24 h do not count', async () => {
    const w = await world({ auto: 'max_rounds_per_day = 1\n' });
    const insert = w.h.store.db.prepare("INSERT INTO events (ts, kind, round_id, detail_json) VALUES (?, 'auto-round', NULL, '{}')");
    insert.run(new Date(Date.now() - 60 * 60_000).toISOString());
    const r = await w.pass();
    expect(r.candidates.find((c) => c.pr.endsWith('#2'))).toMatchObject({ action: 'deferred', why: 'max_rounds_per_day (1) reached: 1 rounds in the last 24 h' });
    expect(ledgerRows(w.h)).toEqual([]);
    expect(roundsCount(w.h)).toBe(0);
    w.h.store.db.prepare("UPDATE events SET ts = ? WHERE kind = 'auto-round'").run(new Date(Date.now() - 25 * 60 * 60_000).toISOString());
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved' });
  });

  it('two attempts per head: a failed round retries once with its fixed round number, then fails for good and notifies', async () => {
    const w = await world();
    const failing = fakeHome({ codex: { [OCC.a]: [codexCase('wrong-model')] }, claude: { [OCC.b]: [claudeCase('model-not-found')], [OCC.c]: [claudeCase('model-not-found')] } }).env;
    await w.pass({ env: failing });
    expect(row(w)).toMatchObject({ state: 'failed', attempts: 1, round_no: 4 });
    expect(w.notices).toEqual([]);
    // Another council posts a round 9 marker meanwhile: the count for this head would now be 10, but the ledger fixed
    // the number at its first claim (plan 9.4).
    w.addReview(ghReview(6001, 'repo-owner', 'COMMENTED', w.src.shas['C7']!, '2026-11-13T11:00:00Z', `sabotage-council round 9 on sabotage-dev/sabotage-council#2 at ${w.src.shas['C7']!.slice(0, 7)}`));
    await w.pass({ env: failing });
    expect(row(w)).toMatchObject({ state: 'failed', attempts: 2, round_no: 4 });
    expect(w.notices.map((n) => n.kind)).toEqual(['failure']);
    const rounds = w.h.store.db.prepare('SELECT round_no, status FROM rounds ORDER BY id').all();
    expect(rounds).toEqual([
      { round_no: 4, status: 'failed' },
      { round_no: 4, status: 'failed' },
    ]);
    const r3 = await w.pass();
    expect(r3.candidates.find((c) => c.pr.endsWith('#2'))).toMatchObject({ action: 'done', why: 'the ledger row is failed after 2 attempts' });
    expect(roundsCount(w.h)).toBe(2);
  });

  it('round_no is fixed by the claim from the reviews read before it: a counted review landing before the prepare does not move it (P8 round 1 row 5)', async () => {
    const w = await world();
    let atClaim: unknown = null;
    await w.pass({
      hooks: {
        afterRowClaim: () => {
          atClaim = (w.h.store.db.prepare('SELECT round_no FROM ledger WHERE head = ?').get(w.d) as { round_no: number | null }).round_no;
          // Another council's round 9 marker lands now: a count at the prepare would give this head 10.
          w.addReview(ghReview(6002, 'repo-owner', 'COMMENTED', w.src.shas['C7']!, '2026-11-13T11:00:00Z', `sabotage-council round 9 on sabotage-dev/sabotage-council#2 at ${w.src.shas['C7']!.slice(0, 7)}`));
        },
      },
    });
    expect(atClaim).toBe(4);
    expect(row(w)).toMatchObject({ state: 'approved', round_no: 4 });
    const roundId = row(w)['round_id'] as number;
    expect(getRound(w.h.store.db, roundId)).toMatchObject({ round_no: 4, marker: `sabotage-council round 4 on sabotage-dev/sabotage-council#2 at ${w.d.slice(0, 7)}` });
    expect(getEvents(w.h.store.db, roundId).find((e) => e.kind === 'round-number-fixed')?.detail).toEqual({ fixed: 4, computed: 10 });
  });

  it('a transient adjudicator failure retries the adjudication on the same round, never the seats', async () => {
    const w = await world();
    w.adj.kind = 'fail';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'failed', attempts: 1 });
    expect(getRound(w.h.store.db, row(w)['round_id'] as number)?.status).toBe('awaiting-adjudication');
    w.adj.kind = 'approve';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', attempts: 2 });
    expect(roundsCount(w.h)).toBe(1);
    expect(w.adj.calls).toBe(2);
  });

  it('notifications are deduped per key per 24 h: the account check failing twice notifies once', async () => {
    const w = await world();
    w.routes['GET user'] = { json: { login: 'someone-else' } };
    w.sync();
    const r = await w.pass();
    expect(r.outcome).toBe('failed');
    expect(r.errors.join(' ')).toMatch(/gh is logged in as someone-else, but github.login is reviewer-x/);
    await w.pass();
    expect(w.notices.map((n) => n.kind)).toEqual(['failure']);
    await w.pass({ now: () => Date.now() + 25 * 60 * 60_000 });
    expect(w.notices.map((n) => n.kind)).toEqual(['failure', 'failure']);
    expect(w.gh.requests().filter((q) => q.key !== 'GET user')).toEqual([]);
  });

  it('a dry pass notice never suppresses the real one: dry and real keys are apart, each deduped on its own (P8 round 1 row 7)', async () => {
    const w = await world();
    w.routes['GET user'] = { json: { login: 'someone-else' } };
    w.sync();
    await w.pass({ dryRun: true });
    await w.pass({ dryRun: true });
    expect(w.notices.map((n) => [n.key, n.dry_run])).toEqual([['failure:dry:account#0@none', true]]);
    await w.pass();
    await w.pass();
    expect(w.notices.map((n) => [n.key, n.dry_run])).toEqual([
      ['failure:dry:account#0@none', true],
      ['failure:account#0@none', false],
    ]);
  });

  it('--dry-run renders and posts nothing (no POST, no dismissal); a real pass later starts the head over', async () => {
    const w = await world();
    const dry = await w.pass({ dryRun: true });
    expect(dry.dry_run).toBe(true);
    expect(row(w)).toMatchObject({ state: 'rendered', dry_run: 1, event: 'APPROVE' });
    expect(getRound(w.h.store.db, row(w)['round_id'] as number)?.dry_run).toBe(1);
    expect(w.posts()).toEqual([]);
    const again = await w.pass({ dryRun: true });
    expect(again.candidates.find((c) => c.pr.endsWith('#2'))).toMatchObject({ action: 'done' });
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', dry_run: 0, attempts: 1 });
    expect(roundsCount(w.h)).toBe(2);
    expect(posts(w)).toBe(1);
    const dry2 = await w.pass({ dryRun: true });
    expect(dry2.candidates.find((c) => c.pr.endsWith('#2'))).toMatchObject({ action: 'done', why: 'a real pass has this head (approved)' });
  });

  it('a dry pass never touches a real row: a new head does not supersede a held real row until a real pass sees it', async () => {
    const w = await world();
    w.adj.kind = 'ruling';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'needs-ruling', dry_run: 0 });
    w.addReview(landed(w));
    const e = pushE(w);
    w.adj.kind = 'approve';
    await w.pass({ dryRun: true });
    expect(row(w)).toMatchObject({ state: 'needs-ruling', dry_run: 0 });
    expect(ledgerRows(w.h).find((x) => x['head'] === e)).toMatchObject({ state: 'rendered', dry_run: 1 });
    expect(posts(w)).toBe(1);
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'superseded' });
    expect(ledgerRows(w.h).find((x) => x['head'] === e)).toMatchObject({ state: 'approved', dry_run: 0 });
    expect(posts(w)).toBe(2);
  });

  it('a busy pass is the last pass on record, and a lock busy for several passes in a row is notified (P8 round 1 row 6)', async () => {
    const w = await world();
    const file = join(autoDir(w.h.layout), 'pass.lock');
    mkdirSync(autoDir(w.h.layout), { recursive: true });
    writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), token: 'another-pass', started_at: new Date().toISOString() }));
    for (let i = 1; i <= BUSY_NOTIFY_AFTER; i++) {
      const r = await w.pass();
      expect(r.outcome).toBe('busy');
      expect(lastReport(w.h.store)).toMatchObject({ outcome: 'busy', errors: [expect.stringMatching(/^another pass holds /)] });
      expect(w.notices.length).toBe(i < BUSY_NOTIFY_AFTER ? 0 : 1);
    }
    expect(w.notices[0]).toMatchObject({ kind: 'failure', key: 'failure:pass-lock#0@busy', message: expect.stringMatching(/3 passes in a row found another pass holding the lock/) });
    expect(w.gh.requests()).toEqual([]);
    unlinkSync(file);
    expect((await w.pass()).outcome).toBe('done');
    expect(row(w)).toMatchObject({ state: 'approved' });
  });

  it('a pass whose lock was taken over claims nothing more (P8 round 1 row 6)', async () => {
    const w = await world({ edit: secondPr });
    await w.pass({
      hooks: {
        afterPost: () => {
          // Another pass judged this one's lock stale and took it over.
          writeFileSync(join(autoDir(w.h.layout), 'pass.lock'), JSON.stringify({ pid: 1, host: 'elsewhere', token: 'taker' }));
        },
      },
    }).then((r) => {
      expect(r.outcome).toBe('failed');
      expect(r.errors).toContain('the pass lock was taken over (its heartbeat had gone stale): this pass claims nothing more');
    });
    expect(row(w)).toMatchObject({ state: 'approved' });
    expect(ledgerRows(w.h).filter((x) => x['num'] === 3)).toEqual([]);
  });

  it('a paused daemon does nothing at all', async () => {
    const { setPaused } = await import('../src/auto/pass.js');
    const w = await world();
    setPaused(w.h.store, true, 'testing');
    const r = await w.pass();
    expect(r.outcome).toBe('paused');
    expect(w.gh.requests()).toEqual([]);
    setPaused(w.h.store, false, null);
    expect((await w.pass()).outcome).toBe('done');
    expect(row(w)['state']).toBe('approved');
  });

  it('retires the rows of a closed PR and prunes round dirs past 90 days (the rows stay)', async () => {
    const w = await world();
    await w.pass();
    const roundId = row(w)['round_id'] as number;
    w.routes[SEARCH] = searchOf();
    Object.assign(json(w.routes, `GET ${PULL}`), { state: 'closed', merged: true });
    w.sync();
    const r = await w.pass();
    expect(r.pruned.retired).toBe(1);
    expect(r.pruned.round_dirs).toBe(0);
    expect(row(w)).toMatchObject({ state: 'retired' });
    // Ten days old: kept (round dirs live 90 days).
    w.h.store.db.prepare('UPDATE rounds SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString(), roundId);
    expect((await w.pass()).pruned.round_dirs).toBe(0);
    w.h.store.db.prepare('UPDATE rounds SET started_at = ? WHERE id = ?').run(new Date(Date.now() - 91 * 24 * 60 * 60_000).toISOString(), roundId);
    const r2 = await w.pass();
    expect(r2.pruned.round_dirs).toBe(1);
    expect(getRound(w.h.store.db, roundId)).toBeDefined();
    // A retired PR is no longer read.
    expect(r2.continuation).toEqual({ read: 0, of: 0 });
  });
});

describe('auto records_sha (plan 9.4)', () => {
  it('hashes the adjudication, the body to post and every leg record, and changes when any of them does', () => {
    const dir = scratch('sc-records-');
    writeFileSync(join(dir, 'ADJUDICATION.json'), '{}');
    writeFileSync(join(dir, 'AUTO-POST.md'), 'body');
    mkdirSync(join(dir, 'legs', 'a-primary-1'), { recursive: true });
    writeFileSync(join(dir, 'legs', 'a-primary-1', 'answer.md'), 'answer');
    const a = recordsSha(dir, 'council');
    expect(recordsSha(dir, 'council')).toBe(a);
    writeFileSync(join(dir, 'legs', 'a-primary-1', 'answer.md'), 'answer2');
    expect(recordsSha(dir, 'council')).not.toBe(a);
    const b = recordsSha(dir, 'council');
    writeFileSync(join(dir, 'AUTO-POST.md'), 'other body');
    expect(recordsSha(dir, 'council')).not.toBe(b);
    const c = recordsSha(dir, 'council');
    writeFileSync(join(dir, 'ADJUDICATION.json'), '{"x":1}');
    expect(recordsSha(dir, 'council')).not.toBe(c);
  });
});
