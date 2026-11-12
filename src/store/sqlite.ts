import { createRequire } from 'node:module';
import type * as Sqlite from 'node:sqlite';

const require = createRequire(import.meta.url);
let loaded: typeof Sqlite | undefined;

/**
 * Loads the built-in `node:sqlite` (no flag needed from Node 22.13). Node prints a one-time ExperimentalWarning
 * for it on 22.x and early 24.x; that single warning is dropped so command output stays clean. Every other
 * warning passes through.
 */
export function sqlite(): typeof Sqlite {
  if (loaded) return loaded;
  const emitWarning = process.emitWarning;
  process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const message = typeof warning === 'string' ? warning : warning.message;
    if (message.startsWith('SQLite is an experimental feature')) return;
    (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  } as typeof process.emitWarning;
  try {
    loaded = require('node:sqlite') as typeof Sqlite;
  } finally {
    process.emitWarning = emitWarning;
  }
  return loaded;
}

export type DatabaseSync = Sqlite.DatabaseSync;
