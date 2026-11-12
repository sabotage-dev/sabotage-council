import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from './sqlite.js';

/** Shipped migrations. Same relative path from `src/store/` and `dist/store/`. */
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
  sha256: string;
}

export interface MigrateResult {
  /** Versions applied by this call, in order. Empty when the store was already current. */
  applied: number[];
  /** Schema version after the call. */
  version: number;
}

const FILE_PATTERN = /^(\d{3})_([a-z0-9_]+)\.sql$/;

/**
 * Reads `NNN_name.sql` files. Versions must run 1..N with no gaps or duplicates; a `.sql` file with any other
 * name is an error rather than silently skipped.
 */
export function readMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.sql')) continue;
    const match = FILE_PATTERN.exec(file);
    if (!match) throw new Error(`migration file "${file}" is not named NNN_name.sql`);
    const sql = readFileSync(join(dir, file), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? '',
      sql,
      sha256: createHash('sha256').update(sql).digest('hex'),
    });
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`migrations must be numbered 1..N without gaps or duplicates; found ${m.version} at position ${i + 1}`);
    }
  });
  return migrations;
}

interface AppliedRow {
  version: number;
  name: string;
  sha256: string;
}

/**
 * Applies pending migrations in one IMMEDIATE transaction, so two processes cannot both apply them and a failed
 * migration leaves the store unchanged. Idempotent: a current store applies nothing. Fails closed when the store
 * holds a migration this build does not have (a newer build wrote it) or one whose text has changed since it was
 * applied.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = readMigrations()): MigrateResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      sha256     TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT`);

    const rows = db.prepare('SELECT version, name, sha256 FROM schema_version ORDER BY version').all() as unknown as AppliedRow[];
    const known = new Map(migrations.map((m) => [m.version, m]));
    for (const row of rows) {
      const migration = known.get(row.version);
      if (!migration) {
        throw new Error(`the store has schema version ${row.version}, which this build does not know (written by a newer build?)`);
      }
      if (migration.sha256 !== row.sha256) {
        throw new Error(`migration ${row.version} (${row.name}) changed after it was applied; add a new migration instead`);
      }
    }

    const done = new Set(rows.map((r) => r.version));
    const applied: number[] = [];
    const record = db.prepare('INSERT INTO schema_version (version, name, sha256, applied_at) VALUES (?, ?, ?, ?)');
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      db.exec(migration.sql);
      record.run(migration.version, migration.name, migration.sha256, new Date().toISOString());
      applied.push(migration.version);
    }

    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error(`migrations left ${violations.length} foreign key violation(s)`);

    db.exec('COMMIT');
    const version = Math.max(0, ...rows.map((r) => r.version), ...applied);
    return { applied, version };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite may already have rolled back; the original error is the one to report.
    }
    throw error;
  }
}
