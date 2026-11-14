import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import { CLAIM_STALE_MS, claimRow } from '../src/auto/ledger.js';
import { getEvents, getRound, roundSummary } from '../src/engine/index.js';
import { releaseRound, ruleFinding } from '../src/engine/ruling.js';
import { postRound } from '../src/engine/post.js';
import { ghApi } from '../src/forge/github.js';
import { fakeRegistry } from './fake-registry.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { FAKE_GH } from './helpers/github.js';
import { fakeAdapters, ROSTER_TOML } from './helpers/round.js';
import { adjStep, docFor, ghReview, json, landed, ledgerRows, LOGIN, PULL, REPO_KEY, roundsCount, world, type World } from './helpers/auto.js';

/*
 * Rulings (plan 3.8) under the daemon, opt-in tests (6.6, D12) in a pass, the real headless adjudicator (P7) under a
 * pass, caffeinate, and the `auto` and `ruling` commands.
 */

cleanScratchAfterAll();

const row = (w: World): Record<string, unknown> => ledgerRows(w.h).find((r) => r['head'] === w.d)!;
const sent = (w: World, method = 'POST') => w.posts().filter((p) => p.method === method);
const roundOf = (w: World): number => row(w)['round_id'] as number;
type Json = Record<string, unknown>;

describe('rulings under the daemon (plan 3.8): a held row is released only by a ruling', { timeout: 120_000 }, () => {
  it('your own change request on the head: the ruling COMMENT posts, the row holds through passes, and only approve releases an APPROVE', async () => {
    const w = await world({
      edit: (routes, _src, d) => {
        (routes[`GET ${PULL}/reviews`] as { json: Json[] }).json.push(ghReview(7001, LOGIN, 'CHANGES_REQUESTED', d, '2026-11-13T10:00:00Z', 'Please split this change.'));
      },
    });
    w.adj.kind = 'hold';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'needs-ruling', event: 'COMMENT', review_id: 990001 });
    const first = sent(w)[0]?.body as { event: string; body: string };
    expect(first.event).toBe('COMMENT');
    expect(first.body).toContain('## Ruling needed');
    expect(w.notices.map((n) => n.kind)).toEqual(['needs-ruling']);
    w.addReview(landed(w));
    // The user's own request goes away on GitHub: the row still holds, and nothing approves without a ruling.
    const reviews = (w.routes[`GET ${PULL}/reviews`] as { json: Json[] }).json;
    reviews.splice(reviews.findIndex((r) => r['id'] === 7001), 1);
    w.sync();
    const held = await w.pass();
    expect(held.candidates.find((c) => c.pr.endsWith('#2'))).toMatchObject({ action: 'held' });
    expect(sent(w)).toHaveLength(1);
    expect(w.adj.calls).toBe(1);
    expect(roundsCount(w.h)).toBe(1);
    // The release.
    const followup = (w.h.store.db.prepare('SELECT id FROM findings WHERE round_id = ?').get(roundOf(w)) as { id: string }).id;
    expect(() => ruleFinding(w.h.store, roundOf(w), followup, 'uphold', LOGIN, null)).toThrow(/is follow-up, not a ruling/);
    const rel = releaseRound(w.h.store, roundOf(w), 'approve', LOGIN, 'split later');
    expect(rel).toMatchObject({ decision: 'approve', archived: 990001, ledger: 'running' });
    w.routes[`POST ${PULL}/reviews`] = { echoReview: { id: 990002, login: LOGIN } };
    w.sync();
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', review_id: 990002, event: 'APPROVE' });
    const second = sent(w)[1]?.body as { event: string; body: string };
    expect(second.event).toBe('APPROVE');
    expect(second.body).not.toContain('## Ruling needed');
    expect(second.body).toContain('Released by a ruling (approve) of reviewer-x');
    expect(getRound(w.h.store.db, roundOf(w))).toMatchObject({ event_posted: 'APPROVE', review_id: 990002 });
    expect(getEvents(w.h.store.db, roundOf(w)).filter((e) => e.kind === 'ruling-comment-archived')).toHaveLength(1);
    expect(sent(w)).toHaveLength(2);
  });

  it('a ruling finding: release refused until it is ruled; upheld cannot approve; released with post it requests changes', async () => {
    const w = await world();
    w.adj.kind = 'ruling';
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'needs-ruling' });
    const id = roundOf(w);
    const fid = (w.h.store.db.prepare("SELECT id FROM findings WHERE round_id = ? AND outcome = 'ruling'").get(id) as { id: string }).id;
    expect(() => releaseRound(w.h.store, id, 'approve', LOGIN, null)).toThrow(/rule on every ruling finding first/);
    expect(() => ruleFinding(w.h.store, id, 'f_nope', 'uphold', LOGIN, null)).toThrow(/has no finding f_nope/);
    ruleFinding(w.h.store, id, fid, 'uphold', LOGIN, 'it is real');
    expect(w.h.store.db.prepare('SELECT ruling_result, ruled_by FROM findings WHERE round_id = ? AND id = ?').get(id, fid)).toEqual({ ruling_result: 'upheld', ruled_by: LOGIN });
    expect(() => releaseRound(w.h.store, id, 'approve', LOGIN, null)).toThrow(/upheld: that review requests changes/);
    releaseRound(w.h.store, id, 'post', LOGIN, null);
    expect(() => ruleFinding(w.h.store, id, fid, 'overturn', LOGIN, null)).toThrow(/already released/);
    w.addReview(landed(w));
    w.routes[`POST ${PULL}/reviews`] = { echoReview: { id: 990002, login: LOGIN } };
    w.sync();
    await w.pass();
    const b = sent(w)[1]?.body as { event: string; body: string };
    expect(b.event).toBe('REQUEST_CHANGES');
    expect(b.body).toMatch(/\*\*Verdict: NEEDS-WORK, 1 owed\.\*\*/);
    expect(row(w)).toMatchObject({ state: 'posted', event: 'REQUEST_CHANGES' });
  });

  it('an overturned ruling released with approve approves; with post, the approval is held; with skip, nothing more posts', async () => {
    for (const decision of ['approve', 'post', 'skip'] as const) {
      const w = await world();
      w.adj.kind = 'ruling';
      await w.pass();
      const id = roundOf(w);
      const fid = (w.h.store.db.prepare("SELECT id FROM findings WHERE round_id = ? AND outcome = 'ruling'").get(id) as { id: string }).id;
      ruleFinding(w.h.store, id, fid, 'overturn', LOGIN, 'not a defect');
      releaseRound(w.h.store, id, decision, LOGIN, null);
      w.addReview(landed(w));
      w.routes[`POST ${PULL}/reviews`] = { echoReview: { id: 990002, login: LOGIN } };
      w.sync();
      await w.pass();
      if (decision === 'skip') {
        expect(row(w)).toMatchObject({ state: 'skipped' });
        expect(sent(w)).toHaveLength(1);
        // Nor by hand: a round released with skip refuses every later post.
        const by = postRound(w.h.store, { config: w.config, layout: w.h.layout, api: ghApi({ bin: FAKE_GH, env: w.gh.env }), roundId: id, mode: 'dry-run' });
        expect(by).toMatchObject({ outcome: 'refused', problems: [`round ${id} was released with skip by a ruling: nothing more posts`] });
        continue;
      }
      const b = sent(w)[1]?.body as { event: string; body: string };
      if (decision === 'post') {
        expect(b.event).toBe('COMMENT');
        expect(b.body).toMatch(/released by a ruling of reviewer-x without an approval/);
        expect(row(w)).toMatchObject({ state: 'posted', event: 'COMMENT' });
        continue;
      }
      expect(b.event).toBe('APPROVE');
      expect(b.body).toContain('## Refuted');
      expect(b.body).toMatch(/overturned by reviewer-x's ruling/);
      expect(row(w)).toMatchObject({ state: 'approved' });
    }
  });

  it('a crash right after the ruling COMMENT posted: the resume adopts it and the row holds for a ruling', async () => {
    const w = await world();
    w.adj.kind = 'ruling';
    let crash = true;
    await w.pass({
      hooks: {
        afterPost: () => {
          if (crash) {
            crash = false;
            throw new Error('the daemon died right after the POST');
          }
        },
      },
    });
    expect(row(w)).toMatchObject({ state: 'posting', event: 'COMMENT', reason: 'posting the ruling COMMENT' });
    w.addReview(landed(w));
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'needs-ruling', review_id: 990001 });
    expect(sent(w)).toHaveLength(1);
    expect(w.notices.map((n) => n.kind)).toEqual(['needs-ruling']);
  });

  it('refuses a release while the daemon holds the row, and a release of a round that does not hold', async () => {
    const w = await world();
    w.adj.kind = 'hold';
    await w.pass();
    const id = roundOf(w);
    const c = claimRow(w.h.store.db, { repo: REPO_KEY, num: 2, head: w.d }, { attempt: false, dryRun: false });
    expect(c.ok).toBe(true);
    expect(() => releaseRound(w.h.store, id, 'approve', LOGIN, null)).toThrow(/the auto daemon is working on round/);
    const plain = await world();
    await plain.pass();
    expect(() => releaseRound(plain.h.store, roundOf(plain), 'approve', LOGIN, null)).toThrow(/does not hold for a ruling/);
  });
});

/** A pid no process has: a child that already exited. */
function deadPid(): number {
  return Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
}

/** A held round with its ruling finding overturned and released with `approve`: the next pass posts the APPROVE. */
async function releasedApprove(): Promise<{ w: World; id: number }> {
  const w = await world();
  w.adj.kind = 'ruling';
  await w.pass();
  const id = roundOf(w);
  const fid = (w.h.store.db.prepare("SELECT id FROM findings WHERE round_id = ? AND outcome = 'ruling'").get(id) as { id: string }).id;
  ruleFinding(w.h.store, id, fid, 'overturn', LOGIN, null);
  releaseRound(w.h.store, id, 'approve', LOGIN, null);
  w.addReview(landed(w));
  w.routes[`POST ${PULL}/reviews`] = { echoReview: { id: 990002, login: LOGIN } };
  w.sync();
  return { w, id };
}

describe('a release waits for a post that may be on GitHub (P8 round 1 row 1)', { timeout: 120_000 }, () => {
  it('a landed approval with a stale claim: no release while the row is posting; the next pass adopts it, and then none is needed', async () => {
    const { w, id } = await releasedApprove();
    const stale = JSON.stringify({ host: hostname(), pid: deadPid(), token: 'dead' });
    await w.pass({
      hooks: {
        afterPost: () => {
          // The daemon dies right after GitHub took the APPROVE: its claim is left behind, stale.
          w.h.store.db.prepare('UPDATE ledger SET claim_owner = ?, heartbeat_at = ?').run(stale, new Date(Date.now() - CLAIM_STALE_MS - 60_000).toISOString());
          throw new Error('the daemon died right after the POST');
        },
      },
    });
    expect(row(w)).toMatchObject({ state: 'posting', event: 'APPROVE', claim_owner: stale });
    expect(sent(w)).toHaveLength(2);
    w.addReview(landed(w, 990002, '2026-11-13T12:05:00Z'));
    for (const d of ['skip', 'post', 'approve'] as const) {
      expect(() => releaseRound(w.h.store, id, d, LOGIN, null)).toThrow(/ledger row is posting: its review may be on GitHub, and the next pass of the auto daemon .* reconciles it/);
    }
    expect(row(w)).toMatchObject({ state: 'posting', records_sha: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await w.pass();
    expect(row(w)).toMatchObject({ state: 'approved', review_id: 990002 });
    expect(sent(w)).toHaveLength(2);
    expect(getEvents(w.h.store.db, id).map((e) => e.kind)).toContain('post-adopted');
    expect(() => releaseRound(w.h.store, id, 'skip', LOGIN, null)).toThrow(/was released \(approve\) and its review is posted/);
  });

  it('records_sha of a post never recorded, or an intent never reconciled, refuses a release; a reconciliation that found nothing lets it go', async () => {
    const { w, id } = await releasedApprove();
    await w.pass({
      hooks: {
        afterPost: () => {
          throw new Error('the daemon died right after the POST');
        },
      },
    });
    expect(row(w)).toMatchObject({ state: 'posting' });
    // A row that holds records_sha with nothing recorded posted, whatever its state says.
    w.h.store.db.prepare("UPDATE ledger SET state = 'running'").run();
    expect(() => releaseRound(w.h.store, id, 'skip', LOGIN, null)).toThrow(/holds the records of a post that was never recorded/);
    // The same post seen from outside the ledger (a post by hand): its intent alone refuses.
    w.h.store.db.prepare('DELETE FROM ledger').run();
    expect(() => releaseRound(w.h.store, id, 'skip', LOGIN, null)).toThrow(/a post of round \d+ recorded its intent and was never reconciled: .*post \d+ --post reconciles it/);
    // Reconciled: nothing of it landed on GitHub, so the release may replace it.
    const rec = postRound(w.h.store, { config: w.config, layout: w.h.layout, api: ghApi({ bin: FAKE_GH, env: w.gh.env }), roundId: id, mode: 'post', reconcileOnly: true });
    expect(rec).toMatchObject({ outcome: 'refused', notLanded: true });
    expect(releaseRound(w.h.store, id, 'skip', LOGIN, null)).toMatchObject({ decision: 'skip' });
  });

  it('a dry round is never released, and says why', async () => {
    const w = await world();
    w.adj.kind = 'ruling';
    await w.pass({ dryRun: true });
    expect(row(w)).toMatchObject({ state: 'needs-ruling', dry_run: 1 });
    expect(w.notices.map((n) => n.message).join(' ')).toMatch(/would hold for your ruling \(dry run: nothing posted/);
    for (const d of ['approve', 'post', 'skip'] as const) {
      expect(() => releaseRound(w.h.store, roundOf(w), d, LOGIN, null)).toThrow(/is a dry run .* it renders its review and never posts, so a release has nothing to post/);
    }
    expect(getEvents(w.h.store.db, roundOf(w)).filter((e) => e.kind === 'ruling-release')).toEqual([]);
  });

  it('an in-flight post re-checks for a release at its intent: one recorded after its claim means nothing posts', async () => {
    const w = await world();
    w.adj.kind = 'ruling';
    await w.pass({
      hooks: {
        afterPostClaim: () => {
          throw new Error('died before the POST');
        },
      },
    });
    // The round as a post by hand sees it: held, nothing posted, no ledger row.
    w.h.store.db.prepare('DELETE FROM ledger').run();
    const id = (w.h.store.db.prepare('SELECT id FROM rounds').get() as { id: number }).id;
    const fid = (w.h.store.db.prepare("SELECT id FROM findings WHERE round_id = ? AND outcome = 'ruling'").get(id) as { id: string }).id;
    ruleFinding(w.h.store, id, fid, 'overturn', LOGIN, null);
    const api = ghApi({ bin: FAKE_GH, env: w.gh.env });
    const opts = { config: w.config, layout: w.h.layout, api, roundId: id };
    const dry = postRound(w.h.store, { ...opts, mode: 'dry-run' });
    expect(dry).toMatchObject({ outcome: 'rendered', event: 'COMMENT', ruling: true });
    const r = postRound(w.h.store, {
      ...opts,
      mode: 'post',
      expect: dry.reviewSha256!,
      hooks: { beforeFinalRead: () => void releaseRound(w.h.store, id, 'approve', LOGIN, 'ruled while the post ran') },
    });
    expect(r.outcome).toBe('refused');
    expect(r.problems.join(' ')).toMatch(/a ruling released round \d+ after this post began: this one records no intent and posts nothing/);
    expect(sent(w)).toEqual([]);
    expect(getEvents(w.h.store.db, id).filter((e) => e.kind === 'posting')).toEqual([]);
    // The next post maps the release: an APPROVE that names it.
    const again = postRound(w.h.store, { ...opts, mode: 'dry-run' });
    expect(again).toMatchObject({ outcome: 'rendered', event: 'APPROVE' });
    expect(postRound(w.h.store, { ...opts, mode: 'post', expect: again.reviewSha256! }).outcome).toBe('posted');
    expect((sent(w)[0]?.body as { event: string; body: string }).body).toContain('Released by a ruling (approve) of reviewer-x');
  });
});

describe('opt-in tests in a pass (plan 6.6, D12)', { timeout: 120_000 }, () => {
  const TESTS = (cmd: string) => `\n[auto.tests."sabotage-dev/sabotage-council"]\ncommand = "${cmd}"\ntimeout_minutes = 1\n`;

  it('a collaborator PR runs them: PASS allows the approval, FAIL holds it', async () => {
    const pass = await world({ auto: TESTS('test -f src/step8.py') });
    await pass.pass();
    expect(row(pass)).toMatchObject({ state: 'approved' });
    expect(getEvents(pass.h.store.db, roundOf(pass)).find((e) => e.kind === 'auto-tests')?.detail).toMatchObject({ result: 'PASS', gate: null });
    const fail = await world({ auto: TESTS('exit 4') });
    await fail.pass();
    expect(row(fail)).toMatchObject({ state: 'posted', event: 'COMMENT' });
    expect((sent(fail)[0]?.body as { body: string }).body).toMatch(/tests failed: FAIL: the test command exited 4/);
    expect(fail.notices.map((n) => n.kind)).toEqual(['approval-held']);
  });

  it('never runs them for a fork, and then holds the approval', async () => {
    const w = await world({
      auto: TESTS('touch ran'),
      edit: (routes) => {
        (json(routes, `GET ${PULL}`)['head'] as Json)['repo'] = { full_name: 'stranger/sabotage-council' };
      },
    });
    await w.pass();
    const t = getEvents(w.h.store.db, roundOf(w)).find((e) => e.kind === 'auto-tests')?.detail as Json;
    expect(t).toMatchObject({ result: null, gate: expect.stringMatching(/never run for forks/) });
    expect(row(w)).toMatchObject({ state: 'posted', event: 'COMMENT' });
    expect(existsSync(join(w.h.layout.roundsDir, String(roundOf(w)), 'tests', 'work'))).toBe(false);
  });
});

describe('the real headless adjudicator under a pass (P7 composed)', { timeout: 120_000 }, () => {
  it('adjudicates through claude -p (the fake), stores, and posts its REQUEST_CHANGES', async () => {
    const w = await world();
    const FAKE = new URL('./fixtures/bin/fake-claude-adjudicator.mjs', import.meta.url).pathname;
    const home = w.legEnv['HOME']!;
    await w.pass({
      adjudicate: undefined,
      claudeBin: FAKE,
      headlessPollMs: 10,
      hooks: {
        afterLegs: (roundId) => {
          // The document the adjudicator writes, with placeholder ids as a headless run must.
          const doc = docFor(roundSummary(w.h.store, w.h.layout, roundId), 'owed') as Json & { findings: Json[]; followups: string[] };
          doc.findings.forEach((f, i) => (f['id'] = `f_${String(i + 1).padStart(12, '0')}`));
          writeFileSync(join(home, 'fake-adjudicator.json'), JSON.stringify({ version: '2.1.325', launches: [{ output: doc }] }));
        },
      },
    });
    expect(row(w)).toMatchObject({ state: 'posted', event: 'REQUEST_CHANGES' });
    const round = getRound(w.h.store.db, roundOf(w))!;
    expect(round).toMatchObject({ adjudicator_model_observed: 'claude-opus-5-5', status: 'adjudicated', verdict: 'NEEDS-WORK' });
    expect(getEvents(w.h.store.db, round.id).find((e) => e.kind === 'adjudicated')?.detail).toMatchObject({ headless: true });
    void adjStep;
  });
});

describe('caffeinate (macOS: rounds run under caffeinate -i)', { timeout: 120_000 }, () => {
  it('runs caffeinate -i -w <pid> while the round runs, and stops it after', async () => {
    const dir = scratch('sc-caffeinate-');
    const bin = join(dir, 'caffeinate');
    const log = join(dir, 'log');
    writeFileSync(bin, `#!/bin/sh\necho "$$ $*" >> "${log}"\nexec sleep 60\n`);
    chmodSync(bin, 0o755);
    const w = await world();
    let alive: boolean | null = null;
    await w.pass({
      caffeinate: bin,
      hooks: {
        afterLegs: () => {
          const pid = Number(readFileSync(log, 'utf8').split(' ')[0]);
          try {
            process.kill(pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
        },
      },
    });
    const [pid, ...args] = readFileSync(log, 'utf8').trim().split(' ');
    expect(args).toEqual(['-i', '-w', String(process.pid)]);
    expect(alive).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    let after = true;
    try {
      process.kill(Number(pid), 0);
    } catch {
      after = false;
    }
    if (after) process.kill(Number(pid), 'SIGKILL');
    expect(after).toBe(false);
  });
});

describe('the auto and ruling commands', { timeout: 120_000 }, () => {
  it('auto run-once --dry-run, status, pause and resume, install --no-load into a temp dir, and ruling', async () => {
    const w = await world();
    const dir = scratch('sc-auto-cli-');
    const configPath = join(dir, 'config.toml');
    writeFileSync(configPath, `${ROSTER_TOML}\n[github]\nlogin = "${LOGIN}"\ncouncil_logins = ["repo-owner"]\n\n[adjudicator]\nmodel = "claude-opus-5-5"\n\n[auto]\nrepos_allow = ["sabotage-dev/*"]\n`);
    const serviceDir = join(dir, 'LaunchAgents');
    const run = async (...args: string[]): Promise<{ code: number; lines: string[] }> => {
      const lines: string[] = [];
      let code = 0;
      const io: ProgramIo = {
        write: (l) => lines.push(l),
        env: { HOME: dir, PATH: process.env['PATH'], ...w.gh.env },
        setExitCode: (c) => (code = c),
        adapters: fakeAdapters,
        registry: fakeRegistry({ codex: [{ id: 'gpt-6.1-sol', family: 'openai' }], claude: [{ id: 'claude-sonnet-5-5', family: 'anthropic' }, { id: 'claude-haiku-5-5', family: 'anthropic' }, { id: 'claude-opus-5-5', family: 'anthropic' }] }),
        cwd: dir,
        ghBin: FAKE_GH,
        mirrorSource: () => ({ url: w.src.repo }),
        auto: {
          passOverrides: { adjudicate: adjStep(w), deliver: () => ({ ok: true, via: 'test', detail: '' }), caffeinate: null, legPollMs: 20, legTimeoutMs: 20_000, env: w.legEnv },
          servicePlatform: 'darwin',
          plutil: null,
        },
      };
      await buildProgram(io).exitOverride().parseAsync(['node', 'sabotage-council', ...args, '--config', configPath, '--db', join(dir, 'data', 'council.db'), '--roots', join(dir, 'roots')]);
      return { code, lines };
    };
    const once = await run('auto', 'run-once', '--dry-run');
    expect(once.code, once.lines.join('\n')).toBe(0);
    expect(once.lines.find((l) => l.startsWith('pass '))).toMatch(/^pass done \(dry run: nothing posts\)/);
    expect(once.lines.join('\n')).toMatch(/row sabotage-dev\/sabotage-council#2@\w{7}: running -> rendered/);
    expect(w.posts()).toEqual([]);
    const status = await run('auto', 'status', '--json');
    const s = JSON.parse(status.lines.join('\n')) as { counts: Record<string, number>; paused: { paused: boolean }; last_pass: { dry_run: boolean } };
    expect(s.counts).toEqual({ rendered: 1 });
    expect(s.last_pass.dry_run).toBe(true);
    expect((await run('auto', 'pause', '--reason', 'away')).lines).toEqual(['paused: passes do nothing until `auto resume` (a pass already running finishes its current round)']);
    expect((await run('auto', 'run-once', '--dry-run')).lines.find((l) => l.startsWith('pass '))).toMatch(/^pass paused/);
    await run('auto', 'resume');
    // The daemon loop the service runs, stopped after one pass.
    const loop = await run('auto', 'run', '--dry-run', '--passes', '1');
    expect(loop.code).toBe(0);
    expect(loop.lines.find((l) => l.startsWith('pass '))).toMatch(/^pass done \(dry run: nothing posts\)/);
    const inst = await run('auto', 'install', '--dry-run', '--no-load', '--dir', serviceDir);
    expect(inst.code, inst.lines.join('\n')).toBe(0);
    const plist = readFileSync(join(serviceDir, 'dev.sabotage-council.auto.plist'), 'utf8');
    expect(plist).toContain('<string>--dry-run</string>');
    expect(plist).toContain(`<string>${configPath}</string>`);
    expect(inst.lines.some((l) => l.startsWith('to load it: launchctl bootstrap gui/'))).toBe(true);
    const un = await run('auto', 'uninstall', '--no-load', '--dir', serviceDir);
    expect(un.lines[0]).toMatch(/^removed /);
    expect((await run('ruling', '1', 'approve')).lines).toEqual([
      'error: round 1 is a dry run (auto --dry-run, or round start --dry-run): it renders its review and never posts, so a release has nothing to post; a real pass reviews the head afresh',
    ]);
    expect((await run('ruling', '1', 'f_x', 'maybe')).lines).toEqual(['error: a finding takes uphold or overturn']);
  });
});
