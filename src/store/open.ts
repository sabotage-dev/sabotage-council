import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate, readMigrations, type MigrateResult } from './migrate.js';
import { sqlite, type DatabaseSync } from './sqlite.js';

export interface Store {
  db: DatabaseSync;
  path: string;
  migration: MigrateResult;
  close(): void;
}

export interface OpenStoreOptions {
  /** Directory of `NNN_name.sql` files; defaults to the shipped migrations. */
  migrationsDir?: string | undefined;
}

/**
 * Opens (creating if needed) the run store at `path` (default `~/.local/share/sabotage-council/council.db`;
 * see paths.ts) with foreign keys on, and migrates it to the latest schema.
 */
export function openStore(path: string, options: OpenStoreOptions = {}): Store {
  const migrations = readMigrations(options.migrationsDir);
  const memory = path === ':memory:';
  if (!memory) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const { DatabaseSync } = sqlite();
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    if (!memory) db.exec('PRAGMA journal_mode = WAL');
    const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined;
    if (fk?.foreign_keys !== 1) throw new Error('could not enable foreign keys on the run store');
    const migration = migrate(db, migrations);
    return { db, path, migration, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
