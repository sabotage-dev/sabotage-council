import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { builtinAdapters, type SeatAdapters } from '../adapters/index.js';
import type { AdapterRegistry } from '../config/index.js';
import { CONFIG_ENV, DB_ENV, resolveConfigPath, resolveDbPath, resolveRootsPath, ROOTS_ENV } from '../paths.js';
import { packageInfo } from '../version.js';
import { runDoctor } from './doctor.js';
import type { MirrorSource } from '../forge/mirror.js';
import type { PrRef } from '../forge/pr.js';
import { creditCommand, postCommand, roundStartPr } from './pr.js';
import { adjudicateCommand, defaultStartWorker, roundRun, roundShow, roundStart, roundWait, type StorePaths } from './round.js';

export interface ProgramIo {
  /** Command output, one line per call. */
  write: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Receives a command's exit code. */
  setExitCode: (code: number) => void;
  /** Seat adapters for `doctor`'s per-seat preflight and for rounds. Absent: no seat is preflighted. */
  adapters?: SeatAdapters | undefined;
  /** Model-id validation when `round start` loads the config. Default: the adapters' own `listModels()`. */
  registry?: AdapterRegistry | undefined;
  /** Where `round start` resolves its target. Default: the process's cwd. */
  cwd?: string | undefined;
  /** Starts a prepared round's worker. Default: a detached `round run <id>` of this binary. */
  startWorker?: ((roundId: number, paths: StorePaths) => void) | undefined;
  /** `round wait` poll interval (tests). Default 2000 ms. */
  waitPollMs?: number | undefined;
  /** pr mode: the `gh` binary (tests: a stub replaying recorded JSON). Default `gh` on PATH. */
  ghBin?: string | undefined;
  /** pr mode: where the mirror fetches from (tests: a local repository). Default the GitHub https URL. */
  mirrorSource?: ((ref: PrRef) => MirrorSource) | undefined;
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
    .option('--deep', 'also preflight every seat against a canary root of planted hooks, rules and MCP config (still no model calls); exit 1 if a seat loads one, 2 if nothing loads but a seat is unproven')
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

  const storeOptions = (cmd: Command): Command =>
    cmd
      .option('--config <path>', `config file (default: $${CONFIG_ENV}, else ~/.config/sabotage-council/config.toml)`)
      .option('--db <path>', `run store (default: $${DB_ENV}, else ~/.local/share/sabotage-council/council.db); round dirs go beside it`)
      .option('--roots <dir>', `where review roots are built (default: $${ROOTS_ENV}, else ~/.cache/sabotage-council/roots)`);
  // Absolute before anything is handed on: the worker runs with the round dir as its cwd (fold row 13).
  const pathsOf = (opts: { config?: string; db?: string; roots?: string }): StorePaths => {
    const cwd = io.cwd ?? process.cwd();
    return {
      configPath: resolve(cwd, resolveConfigPath(opts.config, io.env)),
      dbPath: resolve(cwd, resolveDbPath(opts.db, io.env)),
      rootsPath: resolve(cwd, resolveRootsPath(opts.roots, io.env)),
    };
  };
  const roundIo = { write: io.write, env: io.env, setExitCode: io.setExitCode, adapters: io.adapters, registry: io.registry, cwd: io.cwd, startWorker: io.startWorker };
  const prIo = { ...roundIo, ghBin: io.ghBin, mirrorSource: io.mirrorSource };
  const collect = (value: string, previous: string[]): string[] => [...previous, value];
  type StartOpts = { config?: string; db?: string; roots?: string; json?: boolean; fact: string[]; question: string[] };

  const round = program.command('round').description('run a council round and read its result');
  const start = round.command('start').description('prepare a round (target, number, root, brief), start its legs in the background, and print its id');
  storeOptions(
    start
      .command('plan')
      .argument('<file>', 'the plan, inside a git repository (an uncommitted plan is snapshotted)')
      .description('the council pokes holes in a written plan (plan 9.1)')
      .option('--context <path|repo@ref>', 'more context in the root: a local path, or a local repository at a ref (repeatable)', collect, [])
      .option('--fact <text>', 'an established fact the seats must not refile (repeatable)', collect, [])
      .option('--question <text>', 'a question for the seats, at most 3 (replaces the plan defaults; repeatable)', collect, [])
      .option('--json', 'print the round as JSON instead of the bare id'),
  ).action(async (file: string, opts: StartOpts & { context: string[] }) => {
    await roundStart(roundIo, pathsOf(opts), { mode: 'plan', target: file, context: opts.context, facts: opts.fact, questions: opts.question, json: opts.json === true });
  });
  storeOptions(
    start
      .command('diff')
      .argument('[range]', '<base>..<head>; default: the merge-base with the default branch .. HEAD, uncommitted work snapshotted')
      .description('the council reviews a branch diff (plan 9.2)')
      .option('--uncommitted', "with an explicit range whose head is the checked-out commit: include the uncommitted work tree")
      .option(
        '--series <name>',
        'name the review series: rounds with this name in the repository number and carry earlier items together, whatever the head (default: the branch; a sha, tag or detached HEAD is keyed by its commit, so a later commit starts a new series)',
      )
      .option('--fact <text>', 'an established fact the seats must not refile (repeatable)', collect, [])
      .option('--question <text>', 'a question for the seats, at most 3 (repeatable)', collect, [])
      .option('--json', 'print the round as JSON instead of the bare id'),
  ).action(async (range: string | undefined, opts: StartOpts & { uncommitted?: boolean; series?: string }) => {
    await roundStart(roundIo, pathsOf(opts), {
      mode: 'diff',
      target: range,
      context: [],
      facts: opts.fact,
      questions: opts.question,
      json: opts.json === true,
      uncommitted: opts.uncommitted === true,
      series: opts.series,
    });
  });

  storeOptions(
    start
      .command('pr')
      .argument('<target>', 'owner/repo#num, or https://github.com/owner/repo/pull/num')
      .description('the council reviews a GitHub pull request (plan 9.3); post its review afterwards with `post`')
      .option('--dry-run', 'the round can render its review but never post it (a closed PR takes only this)')
      .option('--no-identity', 'run a council round even when the identity path (plan 3.10) would apply')
      .option('--fact <text>', 'an established fact the seats must not refile (repeatable)', collect, [])
      .option('--question <text>', 'a question for the seats, at most 3 (repeatable)', collect, [])
      .option('--json', 'print the round as JSON instead of the bare id'),
  ).action(async (target: string, opts: StartOpts & { dryRun?: boolean; identity?: boolean }) => {
    const paths = pathsOf(opts);
    await roundStartPr(
      prIo,
      paths,
      { target, dryRun: opts.dryRun === true, identity: opts.identity !== false, facts: opts.fact, questions: opts.question, json: opts.json === true },
      io.startWorker ?? defaultStartWorker(io.env),
    );
  });

  const roundId = (value: string): number => {
    if (!/^[1-9][0-9]*$/.test(value)) throw new InvalidArgumentError('a round id is a positive integer');
    return Number(value);
  };
  const minutes = (value: string): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('minutes must be a positive number');
    return n;
  };

  storeOptions(
    round
      .command('wait')
      .argument('<id>', 'the round id', roundId)
      .description('block until the legs settle, then print the JSON summary for the main loop (exit 0 settled, 1 failed, 3 still running at --timeout)')
      .option('--timeout <minutes>', 'stop waiting after this long', minutes),
  ).action(async (id: number, opts: { config?: string; db?: string; roots?: string; timeout?: number }) => {
    await roundWait(roundIo, pathsOf(opts), id, opts.timeout, io.waitPollMs);
  });
  storeOptions(
    round
      .command('show')
      .argument('<id>', 'the round id', roundId)
      .description("print the round's summary (running, settled or adjudicated)")
      .option('--json', 'the JSON summary round wait prints'),
  ).action((id: number, opts: { config?: string; db?: string; roots?: string; json?: boolean }) => {
    roundShow(roundIo, pathsOf(opts), id, opts.json === true);
  });
  storeOptions(
    round
      .command('run', { hidden: true })
      .argument('<id>', 'the round id', roundId)
      .description('the background worker round start launches: run the legs of a prepared round'),
  ).action(async (id: number, opts: { config?: string; db?: string; roots?: string }) => {
    await roundRun(roundIo, pathsOf(opts), id);
  });

  storeOptions(
    program
      .command('adjudicate')
      .argument('<id>', 'the round id', roundId)
      .argument('<file>', 'ADJUDICATION.json (plan 7.3)')
      .description("validate the main loop's adjudication against the round, store it, and print the effective verdict")
      .option('--check', 'validate only and print what would be stored, with every majority override and its proof; store nothing')
      .option('--json', 'print the result as JSON'),
  ).action((id: number, file: string, opts: { config?: string; db?: string; roots?: string; json?: boolean; check?: boolean }) => {
    adjudicateCommand(roundIo, pathsOf(opts), id, file, opts.json === true, opts.check === true);
  });

  const expectHash = (value: string): string => {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new InvalidArgumentError('the expected body hash is the 64 lower-case hex sha256 a dry run printed');
    return value;
  };
  storeOptions(
    program
      .command('post')
      .argument('<id>', 'the round id of an adjudicated pr round (or an identity round)', roundId)
      .description("render the round's GitHub review (--dry-run) or post it (--post): one review on the reviewed head (plan 3.7)")
      .option('--dry-run', 'print the exact body and event that would be posted; post nothing')
      .option('--post', 'post the review a dry run showed; refused if it changed since, the head moved, the round was started with --dry-run, or the body fails validation')
      .option('--expect <sha256>', 'with --post: the body sha256 of the dry run the user approved; only that review posts', expectHash)
      .option('--json', 'print the result as JSON'),
  ).action(async (id: number, opts: { config?: string; db?: string; roots?: string; dryRun?: boolean; post?: boolean; expect?: string; json?: boolean }) => {
    if ((opts.dryRun === true) === (opts.post === true)) {
      io.write('error: give exactly one of --dry-run or --post');
      io.setExitCode(1);
      return;
    }
    if (opts.expect !== undefined && opts.post !== true) {
      io.write('error: --expect goes with --post');
      io.setExitCode(1);
      return;
    }
    await postCommand(prIo, pathsOf(opts), id, opts.post === true ? 'post' : 'dry-run', opts.json === true, opts.expect);
  });

  const reviewId = (value: string): number => {
    if (!/^[1-9][0-9]{0,15}$/.test(value)) throw new InvalidArgumentError('a review id is a positive integer');
    return Number(value);
  };
  storeOptions(
    program
      .command('credit')
      .argument('<pr>', 'owner/repo#num')
      .argument('<review-id>', 'the review to credit as a council round', reviewId)
      .description('count an unmarked review you vouch for as a council round on its own head (plan 3.6 step 4)')
      .option('--note <text>', 'why the review is credited'),
  ).action(async (pr: string, id: number, opts: { config?: string; db?: string; roots?: string; note?: string }) => {
    await creditCommand(prIo, pathsOf(opts), pr, id, opts.note);
  });

  return program;
}
