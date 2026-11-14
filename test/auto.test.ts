import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claimLive, claimRow, CLAIM_STALE_MS, getRow, heartbeat, release, update, updateUnclaimed, type LedgerKey } from '../src/auto/ledger.js';
import { commandDeliver, desktopDeliver, notify, DEDUPE_MS, type Notice } from '../src/auto/notify.js';
import { autoDir, PASS_LOCK_STALE_MS, takePassLock, type PassLock } from '../src/auto/pass.js';
import { inScope, narrowOwners, searchQueries, searchQueue, type QueueConfig } from '../src/auto/queue.js';
import { installService, previewService, renderPlist, renderUnit, serviceArgs, serviceProblems, systemdWord, uninstallService, type ServiceSpec } from '../src/auto/service.js';
import { LOG_TAIL_CHARS, LOG_TAIL_LINES, runTests, testGate, testsFor, testsMarkdown } from '../src/auto/tests.js';
import { ghApi } from '../src/forge/github.js';
import { openStore } from '../src/store/index.js';
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

describe('the pass lock: a heartbeat, staleness by age, takeover by atomic rename (P8 round 1 row 6)', () => {
  const layoutIn = () => ({ dbPath: join(scratch('sc-lock-'), 'data', 'council.db') });
  const lockFile = (l: { dbPath: string }) => join(autoDir(l), 'pass.lock');
  const seed = (l: { dbPath: string }, holder: Record<string, unknown>, ageMs: number): void => {
    mkdirSync(autoDir(l), { recursive: true });
    writeFileSync(lockFile(l), JSON.stringify({ ...holder, token: 'theirs', started_at: '2026-11-13T00:00:00Z' }));
    const t = new Date(Date.now() - ageMs);
    utimesSync(lockFile(l), t, t);
  };
  const stale = PASS_LOCK_STALE_MS + 60_000;

  it('a reused pid on this host holds the lock while its heartbeat is fresh, and frees it once stale', () => {
    const l = layoutIn();
    seed(l, { pid: process.pid, host: hostname() }, 0);
    expect(takePassLock(l)).toMatchObject({ busy: expect.stringMatching(/^another pass holds .*pass\.lock \(pid \d+ on /) });
    seed(l, { pid: process.pid, host: hostname() }, stale);
    const taken = takePassLock(l);
    expect('beat' in taken).toBe(true);
    expect(JSON.parse(readFileSync(lockFile(l), 'utf8'))).toMatchObject({ pid: process.pid, host: hostname() });
    expect(JSON.parse(readFileSync(lockFile(l), 'utf8')).token).not.toBe('theirs');
  });

  it('a host name that changed holds it only while fresh; a dead pid on this host frees it at once', () => {
    const l = layoutIn();
    seed(l, { pid: 1, host: 'an-old-host-name.local' }, 0);
    expect('busy' in takePassLock(l)).toBe(true);
    seed(l, { pid: 1, host: 'an-old-host-name.local' }, stale);
    expect('beat' in takePassLock(l)).toBe(true);
    const l2 = layoutIn();
    seed(l2, { pid: deadPid(), host: hostname() }, 0);
    expect('beat' in takePassLock(l2)).toBe(true);
  });

  it('two takers of one stale lock: exactly one wins, and the other puts the fresh lock back', () => {
    const l = layoutIn();
    seed(l, { pid: process.pid, host: hostname() }, stale);
    let inner: ReturnType<typeof takePassLock> | null = null;
    const outer = takePassLock(l, { beforeTakeover: () => (inner = takePassLock(l)) });
    expect(outer).toEqual({ busy: expect.stringMatching(/took .* over first$/) });
    expect(inner !== null && 'beat' in inner).toBe(true);
    const won = inner as unknown as PassLock;
    expect(won.beat()).toBe(true);
    expect(readdirSync(autoDir(l))).toEqual(['pass.lock']);
    won.release();
    expect(existsSync(lockFile(l))).toBe(false);
  });

  it('the heartbeat refreshes the lock, and reports a lock that is no longer this pass\'s', () => {
    const l = layoutIn();
    const lock = takePassLock(l);
    if (!('beat' in lock)) throw new Error(lock.busy);
    const old = new Date(Date.now() - stale);
    utimesSync(lockFile(l), old, old);
    expect(lock.beat()).toBe(true);
    expect(Date.now() - statSync(lockFile(l)).mtimeMs).toBeLessThan(PASS_LOCK_STALE_MS);
    writeFileSync(lockFile(l), JSON.stringify({ pid: 1, host: 'elsewhere', token: 'x' }));
    expect(lock.beat()).toBe(false);
    lock.release();
    expect(existsSync(lockFile(l))).toBe(true);
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
