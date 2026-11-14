import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimLive, claimRow, CLAIM_STALE_MS, getRow, heartbeat, release, update, updateUnclaimed, type LedgerKey } from '../src/auto/ledger.js';
import { commandDeliver, desktopDeliver, notify, DEDUPE_MS, type Notice } from '../src/auto/notify.js';
import { PASS_LOCK_KEY, PASS_LOCK_STALE_MS, takePassLock } from '../src/auto/pass.js';
import { inScope, narrowOwners, searchQueries, searchQueue, type QueueConfig } from '../src/auto/queue.js';
import { installService, previewService, renderPlist, renderUnit, serviceArgs, serviceProblems, systemdWord, uninstallService, type ServiceSpec } from '../src/auto/service.js';
import { LOG_TAIL_CHARS, LOG_TAIL_LINES, runTests, testGate, testsFor, testsMarkdown } from '../src/auto/tests.js';
import { ghApi } from '../src/forge/github.js';
import { openStore, type Store } from '../src/store/index.js';
import { openShadow } from '../src/root/git.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { FAKE_GH, fakeGh } from './helpers/github.js';
import { commitAll, initRepo, writeTree } from './helpers/git-fixture.js';

cleanScratchAfterAll();

const store = () => openStore(join(scratch('sc-auto-'), 'council.db'));
const KEY: LedgerKey = { repo: 'github.com/sabotage-dev/sabotage-council', num: 2, head: 'a'.repeat(40) };

/** A pid that no process has: a child that already exited. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}

describe('auto ledger: claim fencing, heartbeat, attempts (plan 9.4)', () => {
  it('claims a new head once: a live claim refuses a second, and every write is fenced to its owner', () => {
    const s = store();
    const a = claimRow(s.db, KEY, { attempt: true, dryRun: false });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.row).toMatchObject({ state: 'running', attempts: 1, claim_pid: process.pid, dry_run: 0 });
    const b = claimRow(s.db, KEY, { attempt: true, dryRun: false });
    expect(b.ok).toBe(false);
    expect(update(s.db, a.claim, { state: 'posting', records_sha: 'x' })).toBe(true);
    // Another owner's token writes nothing.
    expect(update(s.db, { ...a.claim, owner: '{"host":"h","pid":1,"token":"t"}' }, { state: 'posted' })).toBe(false);
    expect(getRow(s.db, KEY)?.state).toBe('posting');
    release(s.db, a.claim);
    expect(getRow(s.db, KEY)?.claim_owner).toBeNull();
    // A resume claim keeps a posting row posting and starts no attempt.
    const c = claimRow(s.db, KEY, { attempt: false, dryRun: false });
    expect(c.ok && c.row).toMatchObject({ state: 'posting', attempts: 1 });
  });

  it('frees a claim whose pid is dead at once, and a reused (live) pid or another host once its heartbeat is stale', () => {
    const s = store();
    const now = Date.now();
    const at = new Date(now).toISOString();
    const seed = (owner: string, beat: string): void => {
      s.db.prepare('DELETE FROM ledger').run();
      s.db.prepare("INSERT INTO ledger (repo, num, head, state, attempts, claim_owner, heartbeat_at, updated_at) VALUES (?, ?, ?, 'running', 1, ?, ?, ?)").run(KEY.repo, KEY.num, KEY.head, owner, beat, at);
    };
    seed(JSON.stringify({ host: hostname(), pid: deadPid(), token: 'old' }), at);
    expect(claimLive(getRow(s.db, KEY)!, now)).toBe(false);
    const dead = claimRow(s.db, KEY, { attempt: false, dryRun: false, nowMs: now });
    expect(dead.ok && dead.takenOver).toBe(true);

    seed(JSON.stringify({ host: hostname(), pid: process.pid, token: 'reused' }), at);
    expect(claimLive(getRow(s.db, KEY)!, now)).toBe(true);
    expect(claimRow(s.db, KEY, { attempt: false, dryRun: false, nowMs: now }).ok).toBe(false);
    expect(claimLive(getRow(s.db, KEY)!, now + CLAIM_STALE_MS + 1)).toBe(false);
    expect(claimRow(s.db, KEY, { attempt: false, dryRun: false, nowMs: now + CLAIM_STALE_MS + 1 }).ok).toBe(true);

    seed(JSON.stringify({ host: 'another-host', pid: 1, token: 'x' }), at);
    expect(claimLive(getRow(s.db, KEY)!, now)).toBe(true);
    expect(claimLive(getRow(s.db, KEY)!, now + CLAIM_STALE_MS + 1)).toBe(false);
  });

  it('fences the first owner once its claim is taken over: its heartbeat and its writes fail', () => {
    const s = store();
    const now = Date.now();
    const a = claimRow(s.db, KEY, { attempt: true, dryRun: false, nowMs: now });
    if (!a.ok) throw new Error('no claim');
    const later = now + CLAIM_STALE_MS + 1;
    // Same pid (this process) but a stale heartbeat: the reused-pid case, taken over.
    const b = claimRow(s.db, KEY, { attempt: false, dryRun: false, nowMs: later });
    expect(b.ok && b.takenOver).toBe(true);
    expect(heartbeat(s.db, a.claim, later)).toBe(false);
    expect(update(s.db, a.claim, { state: 'posted' })).toBe(false);
    expect(getRow(s.db, KEY)?.state).toBe('running');
    expect((s.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'ledger' AND json_extract(detail_json, '$.change') = 'claim-taken-over'").get() as { n: number }).n).toBe(1);
  });

  it('updates an unclaimed row (a ruling, the prune) only while no live claim holds it', () => {
    const s = store();
    const a = claimRow(s.db, KEY, { attempt: true, dryRun: false });
    if (!a.ok) throw new Error('no claim');
    expect(updateUnclaimed(s.db, KEY, { state: 'retired' })).toBe(false);
    release(s.db, a.claim);
    expect(updateUnclaimed(s.db, KEY, { state: 'retired' })).toBe(true);
    expect(() => updateUnclaimed(s.db, KEY, { state: 'bogus' as never })).toThrow(/unknown ledger state/);
  });

  it('stores the round number in the claim that creates the row, and keeps it on every later claim until a reset (P8 round 1 row 5)', () => {
    const s = store();
    const a = claimRow(s.db, KEY, { attempt: true, dryRun: false, roundNo: 4 });
    if (!a.ok) throw new Error('no claim');
    expect(a.row.round_no).toBe(4);
    release(s.db, a.claim);
    const b = claimRow(s.db, KEY, { attempt: true, dryRun: false, roundNo: 10 });
    expect(b.ok && b.row.round_no).toBe(4);
    if (b.ok) release(s.db, b.claim);
    const c = claimRow(s.db, KEY, { attempt: true, dryRun: false, roundNo: 6, reset: true });
    expect(c.ok && c.row.round_no).toBe(6);
  });

  it('resets a head on request (a real pass over a dry run): attempts, round and records cleared', () => {
    const s = store();
    const a = claimRow(s.db, KEY, { attempt: true, dryRun: true });
    if (!a.ok) throw new Error('no claim');
    update(s.db, a.claim, { state: 'rendered', round_id: null, round_no: 4, event: 'APPROVE' });
    release(s.db, a.claim);
    const b = claimRow(s.db, KEY, { attempt: true, dryRun: false, reset: true });
    expect(b.ok && b.row).toMatchObject({ state: 'running', attempts: 1, round_no: null, event: null, dry_run: 0 });
  });
});

const QCFG: QueueConfig = { login: 'reviewer-x', repos_allow: ['sabotage-dev/*'], repos_skip: [], include_assigned: false, include_team_requests: true };

describe('auto queue: the search and the lists (plan 9.4, Q10, Q11)', () => {
  it('narrows each search to the allow list owners, team requests by default, assignees only when asked', () => {
    expect(searchQueries(QCFG)).toEqual([{ q: 'is:pr is:open draft:false review-requested:@me user:sabotage-dev', source: 'requested' }]);
    expect(searchQueries({ ...QCFG, include_team_requests: false })[0]?.q).toBe('is:pr is:open draft:false user-review-requested:@me user:sabotage-dev');
    expect(searchQueries({ ...QCFG, include_assigned: true }).map((x) => x.q)).toEqual([
      'is:pr is:open draft:false review-requested:@me user:sabotage-dev',
      'is:pr is:open draft:false assignee:@me user:sabotage-dev',
    ]);
    expect(searchQueries({ ...QCFG, repos_allow: ['b/x', 'A/y', 'a/*'] }).map((x) => x.q)).toEqual([
      'is:pr is:open draft:false review-requested:@me user:a',
      'is:pr is:open draft:false review-requested:@me user:b',
    ]);
    // An owner with a wildcard cannot narrow: one unnarrowed search, the client-side filter keeps the list.
    expect(narrowOwners(['*/x'])).toBeNull();
    expect(searchQueries({ ...QCFG, repos_allow: ['sabo*/x'] })[0]?.q).toBe('is:pr is:open draft:false review-requested:@me');
    // An empty allow list allows nothing and searches nothing.
    expect(searchQueries({ ...QCFG, repos_allow: [] })).toEqual([]);
  });

  it('keeps a repository on repos_allow and off repos_skip, case-insensitively', () => {
    const cfg = { repos_allow: ['sabotage-dev/*'], repos_skip: ['sabotage-dev/private-*'] };
    expect(inScope(cfg, 'Sabotage-Dev/sabotage-council')).toBe(true);
    expect(inScope(cfg, 'sabotage-dev/private-notes')).toBe(false);
    expect(inScope(cfg, 'work-org/service')).toBe(false);
    expect(inScope({ repos_allow: [], repos_skip: [] }, 'sabotage-dev/x')).toBe(false);
  });

  it('drops a result outside the allow list unread, counting it only', () => {
    const gh = fakeGh({
      'GET search/issues q=is:pr is:open draft:false review-requested:@me user:sabotage-dev': {
        json: {
          total_count: 3,
          incomplete_results: false,
          items: [
            { number: 2, repository_url: 'https://api.github.com/repos/sabotage-dev/sabotage-council', user: { login: 'repo-owner' }, draft: false, pull_request: {} },
            { number: 9, repository_url: 'https://api.github.com/repos/work-org/secret-service', user: { login: 'someone' }, draft: false, pull_request: {} },
            { number: 3, repository_url: 'https://api.github.com/repos/sabotage-dev/sabotage-council', user: { login: 'x' }, draft: false },
          ],
        },
      },
    });
    const r = searchQueue(ghApi({ bin: FAKE_GH, env: gh.env }), QCFG);
    expect(r.hits.map((h) => `${h.fullName}#${h.ref.number}`)).toEqual(['sabotage-dev/sabotage-council#2']);
    expect(r.dropped).toBe(1);
    expect(gh.requests().map((q) => q.key)).toEqual(['GET search/issues']);
  });
});

function notice(over: Partial<Notice> = {}): Notice {
  return { kind: 'failure', key: 'failure:x#1@h', title: 't', message: 'm', repo: 'o/r', number: 1, head: 'h', round_id: null, url: null, dry_run: false, ...over };
}

describe('the pass lock: an owner-checked lease in the store, a heartbeat, staleness by age (P8 round 1 row 6, round 2 row 2)', () => {
  /** Two connections to one store, as two processes have; the second never waits on a busy store. */
  const twoStores = () => {
    const path = join(scratch('sc-lock-'), 'data', 'council.db');
    const a = openStore(path);
    const b = openStore(path);
    b.db.exec('PRAGMA busy_timeout = 0');
    return { a, b };
  };
  const lease = (s: Store): string | undefined => (s.db.prepare('SELECT value FROM auto_state WHERE key = ?').get(PASS_LOCK_KEY) as { value: string } | undefined)?.value;
  const seed = (s: Store, holder: Record<string, unknown>, ageMs: number): void => {
    s.db
      .prepare('INSERT INTO auto_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(PASS_LOCK_KEY, JSON.stringify({ ...holder, token: 'theirs', started_at: '2026-11-13T00:00:00Z' }), new Date(Date.now() - ageMs).toISOString());
  };
  const stale = PASS_LOCK_STALE_MS + 60_000;

  it('a reused pid on this host holds the lock while its heartbeat is fresh, and frees it once stale', () => {
    const { a } = twoStores();
    seed(a, { pid: process.pid, host: hostname() }, 0);
    expect(takePassLock(a.db)).toMatchObject({ busy: expect.stringMatching(/^another pass holds the pass lock \(pid \d+ on /) });
    seed(a, { pid: process.pid, host: hostname() }, stale);
    const taken = takePassLock(a.db);
    expect('beat' in taken).toBe(true);
    expect(JSON.parse(lease(a)!)).toMatchObject({ pid: process.pid, host: hostname() });
    expect(JSON.parse(lease(a)!).token).not.toBe('theirs');
    expect(a.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'auto-pass-lock-taken-over'").get()).toMatchObject({ n: 1 });
  });

  it('a host name that changed holds it only while fresh; a dead pid on this host frees it at once', () => {
    const { a } = twoStores();
    seed(a, { pid: 1, host: 'an-old-host-name.local' }, 0);
    expect('busy' in takePassLock(a.db)).toBe(true);
    seed(a, { pid: 1, host: 'an-old-host-name.local' }, stale);
    expect('beat' in takePassLock(a.db)).toBe(true);
    const { a: a2 } = twoStores();
    seed(a2, { pid: deadPid(), host: hostname() }, 0);
    expect('beat' in takePassLock(a2.db)).toBe(true);
  });

  it('two takers of one stale lock leave exactly one owner, and a takeover never removes a fresh owner\'s lock', () => {
    const { a, b } = twoStores();
    seed(a, { pid: process.pid, host: hostname() }, stale);
    // The second taker arrives while the first is taking the stale lock: it is busy, and the first owns the lock.
    let inner: ReturnType<typeof takePassLock> | null = null;
    const outer = takePassLock(a.db, { beforeTake: () => (inner = takePassLock(b.db)) });
    expect(inner).toMatchObject({ busy: expect.stringMatching(/^another pass is taking the pass lock right now/) });
    if (!('beat' in outer)) throw new Error(outer.busy);
    const owner = lease(a);
    expect(JSON.parse(owner!).token).not.toBe('theirs');
    // A taker after it finds the fresh lock: busy, and the owner's lock stands, untouched.
    expect(takePassLock(b.db)).toMatchObject({ busy: expect.stringMatching(/^another pass holds the pass lock/) });
    expect(lease(a)).toBe(owner);
    expect(outer.beat(Date.now())).toBe(true);
    expect(a.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'auto-pass-lock-taken-over'").get()).toMatchObject({ n: 1 });
    outer.release();
    expect(lease(a)).toBeUndefined();
  });

  it('the heartbeat refreshes the lock, and reports a lock that is no longer this pass\'s; release then leaves it alone', () => {
    const { a } = twoStores();
    const lock = takePassLock(a.db);
    if (!('beat' in lock)) throw new Error(lock.busy);
    a.db.prepare('UPDATE auto_state SET updated_at = ? WHERE key = ?').run(new Date(Date.now() - stale).toISOString(), PASS_LOCK_KEY);
    const now = Date.now();
    expect(lock.beat(now)).toBe(true);
    expect((a.db.prepare('SELECT updated_at FROM auto_state WHERE key = ?').get(PASS_LOCK_KEY) as { updated_at: string }).updated_at).toBe(new Date(now).toISOString());
    seed(a, { pid: 1, host: 'elsewhere' }, 0);
    const theirs = lease(a);
    expect(lock.beat(Date.now())).toBe(false);
    lock.release();
    expect(lease(a)).toBe(theirs);
  });
});

describe('auto notifications: the hook or the desktop, deduped per key per 24 h (plan 9.4)', () => {
  it('delivers a key once in 24 hours, again after; a failed delivery does not count', () => {
    const s = store();
    const sent: Notice[] = [];
    let ok = false;
    const deliver = (n: Notice) => {
      sent.push(n);
      return { ok, via: 'test', detail: ok ? 'ok' : 'down' };
    };
    const t0 = Date.now();
    expect(notify(s.db, deliver, notice(), t0)).toBe('failed');
    ok = true;
    expect(notify(s.db, deliver, notice(), t0 + 1000)).toBe('sent');
    expect(notify(s.db, deliver, notice(), t0 + 2000)).toBe('deduped');
    expect(notify(s.db, deliver, notice({ key: 'other' }), t0 + 3000)).toBe('sent');
    expect(notify(s.db, deliver, notice(), t0 + 1000 + DEDUPE_MS + 1)).toBe('sent');
    expect(sent.length).toBe(4);
  });

  it('runs notify.command with the notice as JSON on stdin, no shell, ~ expanded', () => {
    const home = scratch('sc-notify-home-');
    const out = join(home, 'got.json');
    mkdirSync(join(home, 'bin'));
    writeFileSync(join(home, 'bin', 'notify'), `#!/bin/sh\ncat > "${out}"\n`);
    chmodSync(join(home, 'bin', 'notify'), 0o755);
    const r = commandDeliver('~/bin/notify', { HOME: home, PATH: process.env['PATH'] })(notice({ message: 'x; rm -rf ~' }));
    expect(r.ok).toBe(true);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toMatchObject({ kind: 'failure', message: 'x; rm -rf ~' });
    expect(commandDeliver('~/bin/missing', { HOME: home })(notice()).ok).toBe(false);
  });

  it('passes desktop text as arguments, never into the AppleScript', () => {
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    const fake = ((bin: string, args: readonly string[]) => {
      calls.push({ bin, args });
      return { status: 0, error: undefined };
    }) as unknown as typeof spawnSync;
    expect(desktopDeliver('darwin', fake)(notice({ title: 'T"', message: '" & do shell script "x' })).ok).toBe(true);
    expect(calls[0]?.bin).toBe('osascript');
    expect(calls[0]?.args.slice(-2)).toEqual(['T"', '" & do shell script "x']);
    expect(calls[0]?.args.slice(0, 6).join(' ')).not.toContain('shell script');
    desktopDeliver('linux', fake)(notice());
    expect(calls[1]).toMatchObject({ bin: 'notify-send', args: ['t', 'm'] });
  });
});

describe('auto opt-in tests (plan 6.6, D12)', () => {
  it('gates on write access and a head in the same repository: never a fork', () => {
    expect(testGate({ trusted: true, baseRepo: 'o/r', headRepo: 'O/R' }).run).toBe(true);
    expect(testGate({ trusted: true, baseRepo: 'o/r', headRepo: 'fork/r' })).toMatchObject({ run: false, why: expect.stringMatching(/fork/) });
    expect(testGate({ trusted: true, baseRepo: 'o/r', headRepo: null }).run).toBe(false);
    expect(testGate({ trusted: false, baseRepo: 'o/r', headRepo: 'o/r' })).toMatchObject({ run: false, why: expect.stringMatching(/collaborators/) });
    expect(testsFor({ 'Org/Api': { command: 'x', timeout_minutes: 1 } }, 'org/api')?.command).toBe('x');
    expect(testsFor({}, 'org/api')).toBeNull();
  });

  it('runs setup and command on an archive of the head, outside the root, with an allowlisted environment', { timeout: 30_000 }, async () => {
    const repo = initRepo(join(scratch('sc-tests-repo-'), 'r'));
    writeTree(repo, { 'ok.sh': 'echo pass\n', 'env.sh': 'env | sort > "$TMPDIR/../env.txt"\n' });
    const head = commitAll(repo, 'tests');
    const mirror = openShadow(repo, join(scratch('sc-tests-shadow-'), 'shadow.git'));
    const env = { PATH: process.env['PATH'], SECRET_TOKEN: 'never-passed', HOME: '/real/home' };
    const run = async (spec: { setup?: string; command: string; timeout_minutes: number }) => {
      const roundDir = scratch('sc-tests-round-');
      return { roundDir, r: await runTests({ mirror, head, roundDir, spec, env }) };
    };
    const pass = await run({ setup: 'sh env.sh', command: 'sh ok.sh', timeout_minutes: 1 });
    expect(pass.r).toMatchObject({ result: 'PASS', exitCode: 0, log: 'tests/test.log' });
    expect(readFileSync(join(pass.roundDir, 'tests', 'test.log'), 'utf8')).toBe('pass\n');
    const seen = readFileSync(join(pass.roundDir, 'tests', 'env.txt'), 'utf8');
    expect(seen).not.toContain('SECRET_TOKEN');
    expect(seen).not.toContain('/real/home');
    expect(seen).toContain('CI=true');
    expect((await run({ command: 'exit 3', timeout_minutes: 1 })).r).toMatchObject({ result: 'FAIL', exitCode: 3 });
    expect((await run({ setup: 'exit 2', command: 'true', timeout_minutes: 1 })).r.result).toBe('SETUPFAIL');
    const md = testsMarkdown(pass.r, null, pass.roundDir);
    expect(md).toContain('Result: PASS');
    expect(md).toContain('DATA: pass');
    expect(testsMarkdown(null, 'the head is in a fork', '/x')).toContain('None: no tests ran for this round (the head is in a fork)');
  });

  it('gives the adjudicator labelled tails of standard output and standard error, each bounded (P8 round 1 row 10)', { timeout: 30_000 }, async () => {
    const repo = initRepo(join(scratch('sc-tests-repo-'), 'r'));
    writeTree(repo, { 'x.txt': 'x\n' });
    const head = commitAll(repo, 'x');
    const mirror = openShadow(repo, join(scratch('sc-tests-shadow-'), 'shadow.git'));
    const roundDir = scratch('sc-tests-round-');
    const command = `echo "ran 3 tests"; i=0; while [ $i -lt ${LOG_TAIL_LINES + 20} ]; do echo "noise $i" >&2; i=$((i+1)); done; echo "AssertionError: expected 2 to be 3" >&2; exit 1`;
    const r = await runTests({ mirror, head, roundDir, spec: { command, timeout_minutes: 1 }, env: { PATH: process.env['PATH'] } });
    expect(r).toMatchObject({ result: 'FAIL', log: 'tests/test.log', errLog: 'tests/test.err.log' });
    const md = testsMarkdown(r, null, roundDir);
    expect(md).toContain('The last lines of its standard output, as data');
    expect(md).toContain('DATA: ran 3 tests');
    expect(md).toContain('The last lines of its standard error, as data');
    expect(md).toContain('DATA: AssertionError: expected 2 to be 3');
    expect(md).not.toContain('DATA: noise 0\n');
    expect(md.split('\n').filter((l) => l.startsWith('DATA: noise')).length).toBe(LOG_TAIL_LINES - 1);
    // A long line is cut from its start, to the character bound.
    writeFileSync(join(roundDir, 'tests', 'test.err.log'), `${'y'.repeat(LOG_TAIL_CHARS * 2)}\n`);
    const long = testsMarkdown(r, null, roundDir).split('\n').find((l) => l.startsWith('DATA: y'));
    expect(long?.length).toBe('DATA: '.length + LOG_TAIL_CHARS);
  });

  it('ends a test run at its cap as TIMEOUT and leaves no process behind', { timeout: 30_000 }, async () => {
    const repo = initRepo(join(scratch('sc-tests-repo-'), 'r'));
    writeTree(repo, { 'x.txt': 'x\n' });
    const head = commitAll(repo, 'x');
    const mirror = openShadow(repo, join(scratch('sc-tests-shadow-'), 'shadow.git'));
    const roundDir = scratch('sc-tests-round-');
    const r = await runTests({ mirror, head, roundDir, spec: { command: 'sleep 30 & echo $! > child.pid; wait', timeout_minutes: 0.02 }, env: { PATH: process.env['PATH'] } });
    expect(r.result).toBe('TIMEOUT');
    const pid = Number(readFileSync(join(roundDir, 'tests', 'work', 'child.pid'), 'utf8'));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

const SPEC: ServiceSpec = {
  node: '/usr/local/bin/node',
  cli: '/opt/sc/dist/cli/index.js',
  configPath: '/home/u/.config/sabotage-council/config.toml',
  dbPath: '/home/u/.local/share/sabotage-council/council.db',
  rootsPath: '/home/u/.cache/sabotage-council/roots',
  shadow: true,
  path: '/usr/bin:/bin',
  home: '/home/u',
  logFile: '/home/u/.local/share/sabotage-council/auto/daemon.log',
};

describe('auto install: the launchd agent and the systemd unit (plan 9.4)', () => {
  it('renders the daemon command line with the store and the mode it was installed with', () => {
    expect(serviceArgs(SPEC)).toEqual(['/usr/local/bin/node', '/opt/sc/dist/cli/index.js', 'auto', 'run', '--config', SPEC.configPath, '--db', SPEC.dbPath, '--roots', SPEC.rootsPath, '--dry-run']);
    const plist = renderPlist(SPEC);
    expect(serviceProblems('darwin', plist, SPEC)).toEqual([]);
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    expect(plist).toContain('<string>--dry-run</string>');
    const unit = renderUnit({ ...SPEC, configPath: '/home/u/my $cfg%/x"y.toml' });
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/sc/dist/cli/index.js" "auto" "run" "--config" "/home/u/my $$cfg%%/x\\"y.toml"');
    expect(serviceProblems('linux', unit, { ...SPEC, configPath: '/home/u/my $cfg%/x"y.toml' })).toEqual([]);
    expect(systemdWord('a\\b')).toBe('"a\\\\b"');
    expect(serviceProblems('darwin', renderPlist(SPEC).replace('<key>Label</key>', ''), SPEC)).toContain('no Label');
    expect(serviceProblems('linux', `${renderUnit(SPEC)}Environment=GH_TOKEN=ghp_${'a'.repeat(36)}\n`, SPEC)).toContain('the file holds a credential-shaped string');
  });

  it('writes and validates into a temp dir (plutil -lint on macOS), and loads only through the loader it is given', () => {
    const dir = scratch('sc-service-');
    const spec = { ...SPEC, logFile: join(dir, 'store', 'auto', 'daemon.log') };
    const calls: Array<{ bin: string; args: readonly string[] }> = [];
    const run = (bin: string, args: readonly string[]) => {
      calls.push({ bin, args });
      return { status: 0, stdout: '', stderr: '' };
    };
    const plutil = existsSync('/usr/bin/plutil') ? '/usr/bin/plutil' : null;
    const lint = installService(spec, { platform: 'darwin', dir, load: false, plutil });
    expect(lint).toMatchObject({ written: true, loaded: false, problems: [] });
    expect(lint.commands).toEqual([['bootstrap', `gui/${process.getuid?.() ?? 0}`, join(dir, 'dev.sabotage-council.auto.plist')]]);
    // No loader named, a dir that is not the default: refused before anything runs.
    expect(() => installService(spec, { platform: 'darwin', dir, load: true, plutil: null, run })).toThrow(/refusing to load/);
    expect(calls).toEqual([]);
    const loaded = installService(spec, { platform: 'linux', dir, load: true, loader: '/fake/systemctl', run, home: '/nowhere' });
    expect(loaded.loaded).toBe(true);
    expect(calls.map((c) => [c.bin, ...c.args].join(' '))).toEqual(['/fake/systemctl --user daemon-reload', '/fake/systemctl --user enable --now sabotage-council-auto.service']);
    const gone = uninstallService({ platform: 'linux', dir, load: true, loader: '/fake/systemctl', run });
    expect(gone.removed).toBe(true);
    expect(existsSync(join(dir, 'sabotage-council-auto.service'))).toBe(false);
  });

  it('reports a plist plutil rejects, and loads nothing', () => {
    const dir = scratch('sc-service-');
    const run = (bin: string) => (bin === '/fake/plutil' ? { status: 1, stdout: 'bad plist', stderr: '' } : { status: 0, stdout: '', stderr: '' });
    const r = installService({ ...SPEC, logFile: join(dir, 'auto', 'daemon.log') }, { platform: 'darwin', dir, load: true, loader: '/fake/launchctl', plutil: '/fake/plutil', run });
    expect(r.loaded).toBe(false);
    expect(r.problems).toEqual(['plutil -lint: bad plist']);
  });

  it('creates the log file\'s dir (0700) before the service file is written and loaded (P8 round 1 row 9)', () => {
    const dir = scratch('sc-service-');
    const logDir = join(dir, 'fresh-store', 'auto');
    const order: string[] = [];
    const run = (bin: string, args: readonly string[]) => {
      order.push(`${bin} ${args[0] ?? ''}: log dir ${existsSync(logDir) ? `0${(statSync(logDir).mode & 0o777).toString(8)}` : 'missing'}`);
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = installService({ ...SPEC, logFile: join(logDir, 'daemon.log') }, { platform: 'darwin', dir: join(dir, 'agents'), load: true, loader: '/fake/launchctl', plutil: '/fake/plutil', run });
    expect(r).toMatchObject({ written: true, loaded: true, problems: [] });
    expect(order).toEqual(['/fake/plutil -lint: log dir 0700', '/fake/launchctl bootstrap: log dir 0700']);
  });

  it('previews without writing, creating or loading anything (P8 round 1 row 13)', () => {
    const dir = scratch('sc-service-');
    const p = previewService({ ...SPEC, logFile: join(dir, 'store', 'auto', 'daemon.log') }, { platform: 'darwin', dir: join(dir, 'agents') });
    expect(p).toMatchObject({ file: join(dir, 'agents', 'dev.sabotage-council.auto.plist'), problems: [], logDir: join(dir, 'store', 'auto') });
    expect(p.text).toContain('<string>--dry-run</string>');
    expect(p.commands).toEqual([['bootstrap', `gui/${process.getuid?.() ?? 0}`, join(dir, 'agents', 'dev.sabotage-council.auto.plist')]]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
