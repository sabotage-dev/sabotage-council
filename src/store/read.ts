import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMigrations } from './migrate.js';
import { sqlite, type DatabaseSync } from './sqlite.js';

/*
 * A read-only view of the run store, for the commands that only read it (`stats`, and the scorecard line of
 * `seats list`). It never migrates and never changes the store's contents or schema: a store whose schema is behind
 * this build is refused with the command that upgrades it, and one ahead of this build is refused too.
 *
 * SQLite reads a WAL-mode database through its `-wal` and `-shm` files, and a read-only connection creates them when
 * they are missing. When neither exists, no connection has the store open and every write is in the main file, so the
 * store is opened `immutable` (SQLite creates nothing beside it). When they exist (a writer has it open), the
 * connection opens read-only through them and sees the writer's last commit. Where SQLite cannot take the immutable
 * URI (Node 22.13 and 22.14, whose node:sqlite takes no URI filename), it falls back to the plain read-only open,
 * which leaves `-wal` and `-shm` beside a closed store; the store's contents stay unchanged.
 */

export class StoreReadError extends Error {
  constructor(
    message: string,
    readonly why: 'behind' | 'ahead' | 'changed',
  ) {
    super(message);
    this.name = 'StoreReadError';
  }
}

export interface ReadStore {
  db: DatabaseSync;
  path: string;
  /** The store's schema version (equal to this build's). */
  version: number;
  close(): void;
}

function open(path: string): DatabaseSync {
  const { DatabaseSync } = sqlite();
  if (!existsSync(`${path}-wal`) && !existsSync(`${path}-shm`)) {
    try {
      const db = new DatabaseSync(`${pathToFileURL(path).href}?mode=ro&immutable=1`, { readOnly: true });
      db.prepare('SELECT count(*) FROM sqlite_master').get();
      return db;
    } catch {
      // No URI filenames here: the plain read-only open below.
    }
  }
  return new DatabaseSync(path, { readOnly: true });
}

/** Opens the store read-only and checks its schema against this build's migrations (see the file comment). */
export function openStoreReadOnly(path: string, options: { migrationsDir?: string | undefined } = {}): ReadStore {
  const full = resolve(path);
  const migrations = readMigrations(options.migrationsDir);
  const latest = migrations.at(-1)?.version ?? 0;
  const db = open(full);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const hasTable = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get() !== undefined;
    const rows = hasTable ? (db.prepare('SELECT version, name, sha256 FROM schema_version ORDER BY version').all() as Array<{ version: number; name: string; sha256: string }>) : [];
    const version = Math.max(0, ...rows.map((r) => Number(r.version)));
    const known = new Map(migrations.map((m) => [m.version, m]));
    if (rows.some((r) => !known.has(Number(r.version)))) {
      throw new StoreReadError(
        `the run store at ${full} has schema version ${version}, newer than this build reads (${latest}): it was written by a newer sabotage-council; upgrade this one to read it`,
        'ahead',
      );
    }
    const changed = rows.find((r) => known.get(Number(r.version))?.sha256 !== r.sha256);
    if (changed) throw new StoreReadError(`the run store at ${full} applied migration ${changed.version} (${changed.name}) as a different text than this build ships`, 'changed');
    if (rows.length < migrations.length) {
      throw new StoreReadError(
        `the run store at ${full} is at schema version ${version}; this build reads version ${latest}, and this command never migrates the store: run \`sabotage-council doctor --db ${full}\` once to upgrade it (doctor applies the pending migrations), then run this again`,
        'behind',
      );
    }
    return { db, path: full, version, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
