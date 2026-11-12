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

/** A migrations dir holding the shipped 001 plus extra files. */
function migrationsWith(extra: Record<string, string>): string {
  const target = join(dir, `migrations-${Object.keys(extra).join('-').replace(/[^a-z0-9]/gi, '')}`);
  mkdirSync(target);
  copyFileSync(join(DEFAULT_MIGRATIONS_DIR, '001_initial.sql'), join(target, '001_initial.sql'));
  for (const [file, sql] of Object.entries(extra)) writeFileSync(join(target, file), sql);
  return target;
}

describe('store: migrations', () => {
  it('migrates a fresh database: every table of plan 8.1, version 1, foreign keys on', () => {
    const store = openTemp('nested/dirs/council.db');
    expect(existsSync(join(dir, 'nested/dirs/council.db'))).toBe(true);
    expect(store.migration).toEqual({ applied: [1], version: 1 });
    expect(tables(store)).toEqual([...CORE_TABLES, 'schema_version'].sort());
    const versions = store.db.prepare('SELECT version, name FROM schema_version').all();
    expect(versions.map((r) => ({ ...r }))).toEqual([{ version: 1, name: 'initial' }]);
    expect({ ...store.db.prepare('PRAGMA foreign_keys').get() }).toEqual({ foreign_keys: 1 });
  });

  it('re-running migrations is a no-op, in the same connection and after reopening', () => {
    const first = openTemp();
    const before = first.db.prepare('SELECT version, applied_at FROM schema_version').all().map((r) => ({ ...r }));
    expect(migrate(first.db)).toEqual({ applied: [], version: 1 });
    first.close();
    open.splice(open.indexOf(first), 1);

    const again = openTemp();
    expect(again.migration).toEqual({ applied: [], version: 1 });
    expect(again.db.prepare('SELECT version, applied_at FROM schema_version').all().map((r) => ({ ...r }))).toEqual(before);
    expect(tables(again)).toEqual([...CORE_TABLES, 'schema_version'].sort());
  });

  it('applies only the new migration to an existing store', () => {
    openTemp().close();
    open.pop();
    const migrations = migrationsWith({ '002_add_note.sql': 'ALTER TABLE targets ADD COLUMN note TEXT;' });
    const store = openTemp('council.db', migrations);
    expect(store.migration).toEqual({ applied: [2], version: 2 });
  });

  it('rolls back a failing migration and leaves the store at its old version', () => {
    openTemp().close();
    open.pop();
    const migrations = migrationsWith({ '002_broken.sql': 'CREATE TABLE half (x INTEGER);\nTHIS IS NOT SQL;' });
    expect(() => openTemp('council.db', migrations)).toThrow();
    const store = openTemp();
    expect(store.migration).toEqual({ applied: [], version: 1 });
    expect(tables(store)).not.toContain('half');
  });

  it('leaves the connection outside a transaction after a failed migration', () => {
    const store = openTemp();
    const broken = readMigrations(migrationsWith({ '002_broken.sql': 'CREATE TABLE half (x INTEGER);\nTHIS IS NOT SQL;' }));
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
    const migrations = migrationsWith({ '002_add_note.sql': 'ALTER TABLE targets ADD COLUMN note TEXT;' });
    openTemp('council.db', migrations).close();
    open.pop();
    expect(() => openTemp()).toThrow(/schema version 2, which this build does not know/);
  });

  it('rejects badly named or non-contiguous migration files', () => {
    expect(() => readMigrations(migrationsWith({ 'two.sql': 'SELECT 1;' }))).toThrow(/not named NNN_name\.sql/);
    expect(() => readMigrations(migrationsWith({ '003_gap.sql': 'SELECT 1;' }))).toThrow(/without gaps or duplicates/);
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
