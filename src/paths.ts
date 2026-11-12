import { homedir } from 'node:os';
import { join } from 'node:path';

/** Environment variable that overrides the config path (a `--config` flag wins over it). */
export const CONFIG_ENV = 'SABOTAGE_COUNCIL_CONFIG';
/** Environment variable that overrides the run store path (a `--db` flag wins over it). */
export const DB_ENV = 'SABOTAGE_COUNCIL_DB';

export function defaultConfigPath(home: string = homedir()): string {
  return join(home, '.config', 'sabotage-council', 'config.toml');
}

export function defaultDbPath(home: string = homedir()): string {
  return join(home, '.local', 'share', 'sabotage-council', 'council.db');
}

/** Flag, then environment variable, then the default under the home directory. */
export function resolveConfigPath(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(flag) ?? nonEmpty(env[CONFIG_ENV]) ?? defaultConfigPath();
}

/** Flag, then environment variable, then the default under the home directory. */
export function resolveDbPath(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return nonEmpty(flag) ?? nonEmpty(env[DB_ENV]) ?? defaultDbPath();
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}
