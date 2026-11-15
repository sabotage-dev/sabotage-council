import { existsSync, realpathSync } from 'node:fs';
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
 * store is opened `immutable` (SQLite creates nothing beside it). When both exist (a writer has it open), the
 * connection opens read-only through them and sees the writer's last commit. When only one exists (a crash or a
 * partial copy left it; a writer always has both), the plain open would create the other, so the store is refused,
 * naming the stray file and `doctor --db`, whose read-write open takes in what a `-wal` holds and removes both files
 * when it closes. SQLite names `-wal` and `-shm` after the file a symlink points to, so the probe and the open use the
 * store's real path: a store reached through a symlink, with a writer beside its target, is never opened `immutable`.
 * Every Node this package runs on (22.15 and later) takes the immutable URI. If an open fails anyway (a file that is
 * not a database, an SQLite that refuses the URI), the store is refused with the reason: there is no fallback to the
 * plain read-only open, which would create `-wal` and `-shm` beside a closed store, so the promise that these
 * commands create nothing beside a closed store holds.
 */

export class StoreReadError extends Error {
  constructor(
    message: string,
    readonly why: 'behind' | 'ahead' | 'changed' | 'unreadable',
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

/** How a connection is made: node:sqlite's `DatabaseSync`, unless a test puts another in its place. */
export type OpenDatabase = (filename: string, options: { readOnly: true }) => DatabaseSync;

const openWithSqlite: OpenDatabase = (filename, options) => new (sqlite().DatabaseSync)(filename, options);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Opens `filename` and reads its schema table once, so a file SQLite cannot read fails here, with the reason. */
function tryOpen(filename: string, openDatabase: OpenDatabase): { db: DatabaseSync } | { error: unknown } {
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(filename, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    return { db };
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Closing a connection that failed its first read: nothing more to undo.
    }
    return { error };
  }
}

/** The path with every symlink followed; the path as given when that fails (the open then fails, with the reason). */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Opens the store at `path` (absolute, as the user named it) read-only, as the file comment says. */
function open(path: string, openDatabase: OpenDatabase): DatabaseSync {
  const real = realPath(path);
  const wal = existsSync(`${real}-wal`);
  const shm = existsSync(`${real}-shm`);
  if (wal !== shm) {
    const [stray, missing] = wal ? [`${real}-wal`, `${real}-shm`] : [`${real}-shm`, `${real}-wal`];
    throw new StoreReadError(
      `cannot read the run store at ${path}: ${stray} is there without ${missing} (a writer that has the store open keeps both; a crash or a partial copy leaves one), and reading it would create ${missing} beside it: run \`sabotage-council doctor --db ${path}\` once (it opens the store for writing, takes in any commits the -wal holds, and removes both files when it closes), then run this again`,
      'unreadable',
    );
  }
  if (wal) {
    // A writer has the store open: read through its -wal and -shm, which exist already.
    const plain = tryOpen(real, openDatabase);
    if ('db' in plain) return plain.db;
    throw new StoreReadError(`cannot read the run store at ${path}: SQLite could not open it read-only through its -wal and -shm (${reasonOf(plain.error)})`, 'unreadable');
  }
  const immutable = tryOpen(`${pathToFileURL(real).href}?mode=ro&immutable=1`, openDatabase);
  if ('db' in immutable) return immutable.db;
  throw new StoreReadError(
    `cannot read the run store at ${path}: SQLite could not open it immutable (${reasonOf(immutable.error)}), and this command never falls back to an open that could create -wal and -shm files beside a closed store`,
    'unreadable',
  );
}

/** Opens the store read-only and checks its schema against this build's migrations (see the file comment). */
export function openStoreReadOnly(path: string, options: { migrationsDir?: string | undefined; openDatabase?: OpenDatabase | undefined } = {}): ReadStore {
  const full = resolve(path);
  const migrations = readMigrations(options.migrationsDir);
  const latest = migrations.at(-1)?.version ?? 0;
  const db = open(full, options.openDatabase ?? openWithSqlite);
  try {
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
