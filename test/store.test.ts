import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, migrate, openStore, readMigrations, type Store } from '../src/store/index.js';

const CORE_TABLES = [
  'credits',
  'earlier_items',
  'events',
  'finding_sources',
  'findings',
  'followups',
  'leg_findings',
  'ledger',
  'legs',
  'occupants',
  'post_guards',
  'rounds',
  'targets',
];

let dir: string;
const open: Store[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-store-'));
});

afterEach(() => {
  for (const store of open.splice(0)) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function openTemp(name = 'council.db', migrationsDir?: string): Store {
  const store = openStore(join(dir, name), { migrationsDir });
  open.push(store);
  return store;
}

function tables(store: Store): string[] {
  const rows = store.db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

/** The shipped migrations, by file name. */
const SHIPPED = ['001_initial.sql', '002_pr_rounds.sql', '003_post_guards.sql', '004_adjudicator_record.sql'];
const LATEST = SHIPPED.length;

/** A migrations dir holding the shipped migrations plus extra files. */
function migrationsWith(extra: Record<string, string>): string {
  const target = join(dir, `migrations-${Object.keys(extra).join('-').replace(/[^a-z0-9]/gi, '')}`);
  mkdirSync(target);
  for (const f of SHIPPED) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(target, f));
  for (const [file, sql] of Object.entries(extra)) writeFileSync(join(target, file), sql);
  return target;
}

describe('store: migrations', () => {
  it('migrates a fresh database: every table of plan 8.1, every shipped version, foreign keys on', () => {
    const store = openTemp('nested/dirs/council.db');
    expect(existsSync(join(dir, 'nested/dirs/council.db'))).toBe(true);
    expect(store.migration).toEqual({ applied: [1, 2, 3, 4], version: LATEST });
    expect(tables(store)).toEqual([...CORE_TABLES, 'schema_version'].sort());
    const versions = store.db.prepare('SELECT version, name FROM schema_version').all();
    expect(versions.map((r) => ({ ...r }))).toEqual([
      { version: 1, name: 'initial' },
      { version: 2, name: 'pr_rounds' },
      { version: 3, name: 'post_guards' },
      { version: 4, name: 'adjudicator_record' },
    ]);
    expect({ ...store.db.prepare('PRAGMA foreign_keys').get() }).toEqual({ foreign_keys: 1 });
  });

  it('re-running migrations is a no-op, in the same connection and after reopening', () => {
    const first = openTemp();
    const before = first.db.prepare('SELECT version, applied_at FROM schema_version').all().map((r) => ({ ...r }));
    expect(migrate(first.db)).toEqual({ applied: [], version: LATEST });
    first.close();
    open.splice(open.indexOf(first), 1);

    const again = openTemp();
    expect(again.migration).toEqual({ applied: [], version: LATEST });
    expect(again.db.prepare('SELECT version, applied_at FROM schema_version').all().map((r) => ({ ...r }))).toEqual(before);
    expect(tables(again)).toEqual([...CORE_TABLES, 'schema_version'].sort());
  });

  it('applies only the new migration to an existing store', () => {
    openTemp().close();
    open.pop();
    const migrations = migrationsWith({ '005_add_note.sql': 'ALTER TABLE targets ADD COLUMN note TEXT;' });
    const store = openTemp('council.db', migrations);
    expect(store.migration).toEqual({ applied: [5], version: 5 });
  });

  it('rolls back a failing migration and leaves the store at its old version', () => {
    openTemp().close();
    open.pop();
    const migrations = migrationsWith({ '005_broken.sql': 'CREATE TABLE half (x INTEGER);\nTHIS IS NOT SQL;' });
    expect(() => openTemp('council.db', migrations)).toThrow();
    const store = openTemp();
    expect(store.migration).toEqual({ applied: [], version: LATEST });
    expect(tables(store)).not.toContain('half');
  });

  it('leaves the connection outside a transaction after a failed migration', () => {
    const store = openTemp();
    const broken = readMigrations(migrationsWith({ '005_broken.sql': 'CREATE TABLE half (x INTEGER);\nTHIS IS NOT SQL;' }));
    expect(() => migrate(store.db, broken)).toThrow();
    expect(tables(store)).not.toContain('half');
    // BEGIN fails inside an open transaction, so this proves the failed migration was rolled back.
    expect(() => store.db.exec('BEGIN IMMEDIATE; ROLLBACK;')).not.toThrow();
  });

  it('refuses a store whose applied migration text has changed', () => {
    openTemp().close();
    open.pop();
    const changed = join(dir, 'changed');
    mkdirSync(changed);
    writeFileSync(join(changed, '001_initial.sql'), 'CREATE TABLE other (x INTEGER);');
    expect(() => openTemp('council.db', changed)).toThrow(/migration 1 \(initial\) changed after it was applied/);
  });

  it('refuses a store written by a newer build', () => {
    const migrations = migrationsWith({ '005_add_note.sql': 'ALTER TABLE targets ADD COLUMN note TEXT;' });
    openTemp('council.db', migrations).close();
    open.pop();
    expect(() => openTemp()).toThrow(/schema version 5, which this build does not know/);
  });

  it('rejects badly named or non-contiguous migration files', () => {
    expect(() => readMigrations(migrationsWith({ 'two.sql': 'SELECT 1;' }))).toThrow(/not named NNN_name\.sql/);
    expect(() => readMigrations(migrationsWith({ '006_gap.sql': 'SELECT 1;' }))).toThrow(/without gaps or duplicates/);
    expect(() => readMigrations(migrationsWith({ '001_again.sql': 'SELECT 1;' }))).toThrow(/without gaps or duplicates/);
  });
});

describe('store: schema', () => {
  /** One fully populated row per table, in dependency order. */
  const ROWS: [string, Record<string, string | number | null>][] = [
    ['targets', { id: 1, kind: 'pr', repo: 'org/repo', number: 42, path: null, branch: 'feature/x' }],
    ['occupants', { id: 1, backend: 'codex', model: 'gpt-6.1-sol', effort: 'high', transport: 'headless' }],
    [
      'rounds',
      {
        id: 1,
        target_id: 1,
        round_no: 2,
        mode: 'auto',
        head_sha: 'a'.repeat(40),
        base_sha: 'b'.repeat(40),
        baseline_sha: 'c'.repeat(40),
        full_round_reason: 'rebase',
        nonce: '0123456789ab',
        roster_json: '[{"seat":"a","backend":"codex"}]',
        started_at: '2026-11-12T10:00:00.000Z',
        finished_at: '2026-11-12T10:20:00.000Z',
        verdict: 'SHIP-WITH-FIXES',
        owed_count: 1,
        approve: 0,
        needs_ruling: 0,
        event_posted: 'REQUEST_CHANGES',
        review_id: 3_456_789_012,
        status: 'posted',
        adjudicator_model_observed: 'claude-opus-5-5',
        adjudicator_tools_json: '["Read","Grep"]',
        adjudicator_denials_json: '[]',
        adjudicator_cost_usd: 0.42,
        adjudicator_turns: 12,
        adjudicator_ms: 61_000,
        kind: 'council',
        marker: 'sabotage-council round 2 on org/repo#42 at aaaaaaa',
        dry_run: 0,
        posted_commit_id: 'a'.repeat(40),
        posted_at: '2026-11-12T10:21:00.000Z',
        posted_body_sha256: 'e'.repeat(64),
        post_owner: '{"host":"h","pid":1,"token":"t"}',
        post_claimed_at: '2026-11-12T10:20:30.000Z',
        adjudicator_effort_observed: 'high',
        adjudicator_record_path: '/projects/slug/00000000-0000-4000-8000-000000000001.jsonl',
      },
    ],
    [
      'legs',
      {
        id: 1,
        round_id: 1,
        seat_id: 'a',
        occupant_id: 1,
        attempt: 1,
        role: 'primary',
        enforcement_label: 'sandboxed-exec',
        cli_version: '0.167.0',
        status: 'PASS',
        failure_class: null,
        verdict_raw: 'NEEDS-WORK',
        verdict_effective: 'SHIP-WITH-FIXES',
        model_observed: 'gpt-6.1-sol',
        effort_observed: 'high',
        cwd_ok: 1,
        tools_used_json: '["exec"]',
        tools_offered_json: '["functions.exec"]',
        root_mutated: 0,
        nonce_seen: 1,
        started_at: '2026-11-12T10:01:00.000Z',
        finished_at: '2026-11-12T10:11:00.000Z',
        duration_ms: 600_000,
        tokens_in: 120_000,
        tokens_out: 4_000,
        cost_usd: 0.31,
        credits: 1.5,
        quota_used_pct: 12.5,
        quota_note: 'plan quota',
        record_path: 'rounds/1/legs/a-1/rollout.jsonl',
      },
    ],
    [
      'findings',
      {
        round_id: 1,
        id: 'C1',
        kind: 'finding',
        title: 'Off-by-one in the pager',
        path: 'src/pager.ts',
        line: 42,
        severity: 'MEDIUM',
        outcome: 'owed',
        owner: 'org/repo',
        proof_ref: 'src/pager.ts:42',
        same_as: null,
        closes_item: 'R1-2',
        ruling_result: 'upheld',
        ruled_by: 'someone',
        ruled_at: '2026-11-12T11:00:00.000Z',
      },
    ],
    [
      'leg_findings',
      {
        id: 1,
        leg_id: 1,
        local_id: 'F1',
        severity_raw: 'MED',
        severity: 'MEDIUM',
        path: 'src/pager.ts',
        line: 41,
        title: 'pager skips the last row',
        extracted_by: 'leg',
        mapped_round_id: 1,
        mapped_finding_id: 'C1',
        unmapped_reason: null,
      },
    ],
    ['finding_sources', { round_id: 1, finding_id: 'C1', leg_finding_id: 1 }],
    [
      'earlier_items',
      { round_id: 1, source_id: 'R1-2', kind: 'owed', status: 'half-closed', evidence: 'src/pager.ts:40', body_sha256: 'f'.repeat(64) },
    ],
    [
      'ledger',
      {
        repo: 'org/repo',
        num: 42,
        head: 'a'.repeat(40),
        state: 'posted',
        attempts: 1,
        claim_pid: 4242,
        claim_started: '2026-11-12T10:00:00.000Z',
        heartbeat_at: '2026-11-12T10:19:00.000Z',
        round_id: 1,
        round_no: 2,
        records_sha: 'e'.repeat(64),
        review_id: 3_456_789_012,
        updated_at: '2026-11-12T10:21:00.000Z',
      },
    ],
    ['followups', { id: 1, target_id: 1, round_id: 1, finding_id: 'C1', status: 'exported', exported_at: '2026-11-12T10:22:00.000Z', hook_rc: 0 }],
    [
      'credits',
      {
        repo: 'org/repo',
        num: 42,
        review_id: 1_234_567_890,
        commit_id: 'd'.repeat(40),
        submitted_at: '2026-11-11T09:00:00.000Z',
        credited_by: 'someone',
        credited_at: '2026-11-12T09:30:00.000Z',
        note: 'unmarked council review',
      },
    ],
    ['events', { id: 1, ts: '2026-11-12T10:21:00.000Z', kind: 'posted', round_id: 1, detail_json: '{"event":"REQUEST_CHANGES"}' }],
    [
      'post_guards',
      { id: 1, round_id: 1, kind: 'dismiss-stale', review_id: 3_456_789_000, status: 'done', attempts: 2, outcome: 'dismissed', created_at: '2026-11-12T10:20:59.000Z', done_at: '2026-11-12T10:21:01.000Z' },
    ],
  ];

  function insert(store: Store, table: string, row: Record<string, string | number | null>): void {
    const columns = Object.keys(row);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
    store.db.prepare(sql).run(...Object.values(row));
  }

  it('covers every core table in the round-trip rows', () => {
    expect(ROWS.map(([table]) => table).sort()).toEqual([...CORE_TABLES].sort());
  });

  it('round-trips one fully populated row through every table', () => {
    const store = openTemp();
    for (const [table, row] of ROWS) insert(store, table, row);
    for (const [table, row] of ROWS) {
      const columns = store.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[];
      // The row names every column, so a column added to the schema without a test value fails here.
      expect(columns.map((c) => c.name).sort()).toEqual(Object.keys(row).sort());
      const back = store.db.prepare(`SELECT * FROM ${table}`).all();
      expect(back.map((r) => ({ ...r }))).toEqual([row]);
    }
  });

  it('rejects a duplicate (round_id, id) in findings, and allows the same id in another round', () => {
    const store = openTemp();
    for (const [table, row] of ROWS.slice(0, 3)) insert(store, table, row);
    insert(store, 'rounds', { ...ROWS[2]![1], id: 2, round_no: 3 });
    const finding = { round_id: 1, id: 'C1', title: 'x', outcome: 'owed' };
    insert(store, 'findings', finding);
    expect(() => insert(store, 'findings', { ...finding, title: 'y' })).toThrow(/UNIQUE constraint failed: findings\.round_id, findings\.id/);
    expect(() => insert(store, 'findings', { ...finding, round_id: 2 })).not.toThrow();
  });

  it('enforces foreign keys', () => {
    const store = openTemp();
    expect(() => insert(store, 'rounds', { ...ROWS[2]![1], target_id: 99 })).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('rejects attribution rows that point at a finding id from another round', () => {
    const store = openTemp();
    for (const [table, row] of ROWS.slice(0, 4)) insert(store, table, row);
    insert(store, 'rounds', { ...ROWS[2]![1], id: 2, round_no: 3 });
    insert(store, 'findings', { round_id: 2, id: 'C9', title: 'only in round 2', outcome: 'owed' });
    const legFinding = { leg_id: 1, severity: 'HIGH', title: 't', extracted_by: 'leg' };
    expect(() =>
      insert(store, 'leg_findings', { ...legFinding, id: 90, local_id: 'F90', mapped_round_id: 1, mapped_finding_id: 'C9' }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(() =>
      insert(store, 'leg_findings', { ...legFinding, id: 91, local_id: 'F91', mapped_round_id: 2, mapped_finding_id: 'C9' }),
    ).not.toThrow();
    expect(() => insert(store, 'finding_sources', { round_id: 1, finding_id: 'C9', leg_finding_id: 91 })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    expect(() => insert(store, 'finding_sources', { round_id: 2, finding_id: 'C9', leg_finding_id: 91 })).not.toThrow();
  });

  it('enforces the closed vocabularies and JSON columns', () => {
    const store = openTemp();
    for (const [table, row] of ROWS.slice(0, 3)) insert(store, table, row);
    const finding = { round_id: 1, id: 'C2', title: 'x' };
    expect(() => insert(store, 'findings', { ...finding, outcome: 'maybe' })).toThrow(/CHECK constraint failed/);
    expect(() => insert(store, 'findings', { ...finding, outcome: 'owed', severity: 'CRITICAL' })).toThrow(/CHECK constraint failed/);
    expect(() => insert(store, 'rounds', { ...ROWS[2]![1], id: 3, roster_json: '{not json' })).toThrow(/CHECK constraint failed/);
    expect(() => insert(store, 'rounds', { ...ROWS[2]![1], id: 3, verdict: 'LGTM' })).toThrow(/CHECK constraint failed/);
  });

  it('keys one target per pr, plan path and diff branch', () => {
    const store = openTemp();
    insert(store, 'targets', { kind: 'pr', repo: 'org/repo', number: 1 });
    expect(() => insert(store, 'targets', { kind: 'pr', repo: 'org/repo', number: 1 })).toThrow(/UNIQUE/);
    insert(store, 'targets', { kind: 'plan', repo: null, path: 'docs/PLAN.md' });
    expect(() => insert(store, 'targets', { kind: 'plan', repo: null, path: 'docs/PLAN.md' })).toThrow(/UNIQUE/);
    expect(() => insert(store, 'targets', { kind: 'pr', repo: 'org/repo' })).toThrow(/CHECK constraint failed/);
  });
});

describe('store: migration 002 (P6 pr rounds)', () => {
  /** A migrations dir holding only the shipped 001: a store written by the P5 build. */
  function p5Migrations(): string {
    const target = join(dir, 'migrations-p5');
    mkdirSync(target);
    copyFileSync(join(DEFAULT_MIGRATIONS_DIR, '001_initial.sql'), join(target, '001_initial.sql'));
    return target;
  }

  it('upgrades a P5 store: existing rounds become council rounds, not dry runs, never posted; a pr round round-trips', () => {
    const old = openTemp('council.db', p5Migrations());
    old.db.prepare("INSERT INTO targets (id, kind, repo, number) VALUES (1, 'pr', 'github.com/o/r', 7)").run();
    old.db
      .prepare("INSERT INTO rounds (id, target_id, round_no, mode, head_sha, roster_json, started_at, status) VALUES (1, 1, 1, 'diff', ?, '{}', '2026-11-12T00:00:00Z', 'adjudicated')")
      .run('a'.repeat(40));
    old.close();
    open.pop();

    const store = openTemp();
    expect(store.migration).toEqual({ applied: [2, 3, 4], version: LATEST });
    const before = store.db.prepare('SELECT kind, marker, dry_run, posted_commit_id, posted_at, posted_body_sha256 FROM rounds WHERE id = 1').get();
    expect({ ...before }).toEqual({ kind: 'council', marker: null, dry_run: 0, posted_commit_id: null, posted_at: null, posted_body_sha256: null });

    const row = {
      id: 2,
      target_id: 1,
      round_no: 3,
      mode: 'pr',
      head_sha: 'b'.repeat(40),
      roster_json: '{}',
      started_at: '2026-11-13T00:00:00Z',
      status: 'adjudicated',
      kind: 'identity',
      marker: 'sabotage-council identity approval on o/r#7 at bbbbbbb',
      dry_run: 1,
      event_posted: 'APPROVE',
      review_id: 9_876_543_210,
      posted_commit_id: 'b'.repeat(40),
      posted_at: '2026-11-13T00:01:00Z',
      posted_body_sha256: 'f'.repeat(64),
    };
    const cols = Object.keys(row);
    store.db.prepare(`INSERT INTO rounds (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(row));
    const back = store.db.prepare(`SELECT ${cols.join(', ')} FROM rounds WHERE id = 2`).get();
    expect({ ...back }).toEqual(row);
    expect(store.db.prepare('SELECT id FROM rounds WHERE review_id = ?').get(9_876_543_210)).toMatchObject({ id: 2 });
  });

  it('enforces the new columns: kind, dry_run, the posted commit and body hash', () => {
    const store = openTemp();
    store.db.prepare("INSERT INTO targets (id, kind, repo, number) VALUES (1, 'pr', 'github.com/o/r', 7)").run();
    const ins = (extra: string, value: string | number): void => {
      store.db
        .prepare(`INSERT INTO rounds (target_id, round_no, mode, head_sha, roster_json, started_at, status, ${extra}) VALUES (1, 1, 'pr', ?, '{}', 'x', 'running', ?)`)
        .run('a'.repeat(40), value);
    };
    expect(() => ins('kind', 'solo')).toThrow(/CHECK constraint failed/);
    expect(() => ins('dry_run', 2)).toThrow(/CHECK constraint failed/);
    expect(() => ins('posted_commit_id', 'abc1234')).toThrow(/CHECK constraint failed/);
    expect(() => ins('posted_commit_id', 'G'.repeat(40))).toThrow(/CHECK constraint failed/);
    expect(() => ins('posted_body_sha256', 'e'.repeat(63))).toThrow(/CHECK constraint failed/);
    expect(() => ins('kind', 'identity')).not.toThrow();
  });
});

describe('store: migration 003 (P6 round 1: post claims, pending guards, canonical repo keys)', () => {
  /** A migrations dir holding only the shipped 001 and 002: a store written by the first P6 build. */
  function p6Migrations(): string {
    const target = join(dir, 'migrations-p6');
    mkdirSync(target);
    for (const f of ['001_initial.sql', '002_pr_rounds.sql']) copyFileSync(join(DEFAULT_MIGRATIONS_DIR, f), join(target, f));
    return target;
  }

  it('merges pr targets that differ only in letter case, moving their rounds, and lower-cases targets and credits', () => {
    const old = openTemp('council.db', p6Migrations());
    const ins = (sql: string, ...v: Array<string | number>): void => {
      old.db.prepare(sql).run(...v);
    };
    ins("INSERT INTO targets (id, kind, repo, number) VALUES (1, 'pr', 'github.com/Org/Repo', 5)");
    ins("INSERT INTO targets (id, kind, repo, number) VALUES (2, 'pr', 'github.com/org/repo', 5)");
    ins("INSERT INTO targets (id, kind, repo, number) VALUES (3, 'pr', 'github.com/Org/Repo', 6)");
    ins("INSERT INTO targets (id, kind, repo, branch) VALUES (4, 'diff', 'github.com/Org/Repo', 'main')");
    for (const [id, target] of [
      [1, 2],
      [2, 1],
      [3, 3],
    ] as const) {
      ins("INSERT INTO rounds (id, target_id, round_no, mode, head_sha, roster_json, started_at, status) VALUES (?, ?, 1, 'pr', ?, '{}', 'x', 'adjudicated')", id, target, 'a'.repeat(40));
    }
    const credit = "INSERT INTO credits (repo, num, review_id, commit_id, submitted_at, credited_by, credited_at) VALUES (?, 5, ?, 'c', 's', 'me', 'x')";
    ins(credit, 'github.com/Org/Repo', 1);
    ins(credit, 'github.com/org/repo', 1);
    ins(credit, 'github.com/ORG/REPO', 2);
    old.close();
    open.pop();

    const store = openTemp();
    expect(store.migration).toEqual({ applied: [3, 4], version: LATEST });
    const rows = (sql: string): unknown[] => store.db.prepare(sql).all().map((r) => ({ ...r }));
    expect(rows('SELECT id, kind, repo, number, branch FROM targets ORDER BY id')).toEqual([
      { id: 1, kind: 'pr', repo: 'github.com/org/repo', number: 5, branch: null },
      { id: 3, kind: 'pr', repo: 'github.com/org/repo', number: 6, branch: null },
      // A diff target is keyed by its remote as the user's git spells it: untouched.
      { id: 4, kind: 'diff', repo: 'github.com/Org/Repo', number: null, branch: 'main' },
    ]);
    expect(rows('SELECT id, target_id FROM rounds ORDER BY id')).toEqual([
      { id: 1, target_id: 1 },
      { id: 2, target_id: 1 },
      { id: 3, target_id: 3 },
    ]);
    expect(rows('SELECT repo, num, review_id FROM credits ORDER BY review_id')).toEqual([
      { repo: 'github.com/org/repo', num: 5, review_id: 1 },
      { repo: 'github.com/org/repo', num: 5, review_id: 2 },
    ]);
    expect(rows('SELECT post_owner, post_claimed_at FROM rounds WHERE id = 1')).toEqual([{ post_owner: null, post_claimed_at: null }]);
  });

  it('enforces the guard vocabulary: kind, status, a review for every guard but the approval race, a done time', () => {
    const store = openTemp();
    store.db.prepare("INSERT INTO targets (id, kind, repo, number) VALUES (1, 'pr', 'github.com/o/r', 7)").run();
    store.db.prepare("INSERT INTO rounds (id, target_id, round_no, mode, head_sha, roster_json, started_at, status) VALUES (1, 1, 1, 'pr', ?, '{}', 'x', 'adjudicated')").run('a'.repeat(40));
    const guard = (row: Record<string, string | number | null>): void => {
      const full = { round_id: 1, kind: 'approval-race', review_id: null, status: 'pending', created_at: 'x', done_at: null, ...row };
      store.db.prepare(`INSERT INTO post_guards (${Object.keys(full).join(', ')}) VALUES (${Object.keys(full).map(() => '?').join(', ')})`).run(...Object.values(full));
    };
    expect(() => guard({ kind: 'retract' })).toThrow(/CHECK constraint failed/);
    expect(() => guard({ status: 'failed' })).toThrow(/CHECK constraint failed/);
    expect(() => guard({ kind: 'dismiss-stale' })).toThrow(/CHECK constraint failed/);
    expect(() => guard({ status: 'done' })).toThrow(/CHECK constraint failed/);
    expect(() => guard({ round_id: 9 })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => guard({})).not.toThrow();
    expect(() => guard({ kind: 'withdraw-off-head', review_id: 5, status: 'done', done_at: 'y' })).not.toThrow();
  });
});
