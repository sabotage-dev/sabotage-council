import { Command } from 'commander';
import { builtinAdapters, type SeatAdapters } from '../adapters/index.js';
import { CONFIG_ENV, DB_ENV, resolveConfigPath, resolveDbPath } from '../paths.js';
import { packageInfo } from '../version.js';
import { runDoctor } from './doctor.js';

export interface ProgramIo {
  /** Command output, one line per call. */
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Receives a command's exit code. */
  setExitCode: (code: number) => void;
  /** Seat adapters for `doctor`'s per-seat preflight. Absent: no seat is preflighted. */
  adapters?: SeatAdapters | undefined;
}

const defaultIo: ProgramIo = {
  write: (line) => process.stdout.write(`${line}\n`),
  env: process.env,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  adapters: builtinAdapters(),
};

export function buildProgram(io: ProgramIo = defaultIo): Command {
  const program = new Command('sabotage-council')
    .description('A three-seat review council for code and plans.')
    .version(packageInfo().version);

  program
    .command('doctor')
    .description('check Node, the config, the run store and each seat\'s preflight (no model calls)')
    .option('--config <path>', `config file (default: $${CONFIG_ENV}, else ~/.config/sabotage-council/config.toml)`)
    .option('--db <path>', `run store (default: $${DB_ENV}, else ~/.local/share/sabotage-council/council.db)`)
    .option('--deep', 'also preflight every seat against a canary root of planted hooks, rules and MCP config (still no model calls)')
    .action(async (opts: { config?: string; db?: string; deep?: boolean }) => {
      const code = await runDoctor({
        configPath: resolveConfigPath(opts.config, io.env),
        dbPath: resolveDbPath(opts.db, io.env),
        adapters: io.adapters,
        env: io.env,
        deep: opts.deep === true,
        write: io.write,
      });
      io.setExitCode(code);
    });

  return program;
}
