import { Command } from 'commander';
import { CONFIG_ENV, DB_ENV, resolveConfigPath, resolveDbPath } from '../paths.js';
import { packageInfo } from '../version.js';
import { runDoctor } from './doctor.js';

export interface ProgramIo {
  /** Command output, one line per call. */
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Receives a command's exit code. */
  setExitCode: (code: number) => void;
}

const defaultIo: ProgramIo = {
  write: (line) => process.stdout.write(`${line}\n`),
  env: process.env,
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function buildProgram(io: ProgramIo = defaultIo): Command {
  const program = new Command('sabotage-council')
    .description('A three-seat review council for code and plans.')
    .version(packageInfo().version);

  program
    .command('doctor')
    .description('check Node, the config, the run store and the seats (no CLI or model calls)')
    .option('--config <path>', `config file (default: $${CONFIG_ENV}, else ~/.config/sabotage-council/config.toml)`)
    .option('--db <path>', `run store (default: $${DB_ENV}, else ~/.local/share/sabotage-council/council.db)`)
    .action(async (opts: { config?: string; db?: string }) => {
      const code = await runDoctor({
        configPath: resolveConfigPath(opts.config, io.env),
        dbPath: resolveDbPath(opts.db, io.env),
        write: io.write,
      });
      io.setExitCode(code);
    });

  return program;
}
