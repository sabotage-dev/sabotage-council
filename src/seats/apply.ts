import { randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseConfigText, type AdapterRegistry, type ConfigIssue } from '../config/index.js';
import { SEAT_COUNT } from '../config/vocab.js';
import { unifiedDiff } from './diff.js';
import { preservingEditor, SeatEditError, type SeatEdit, type SeatEditor } from './edit.js';

/*
 * Applying a seat edit to the user's config file (plan 8.4): the edited text must pass the config loader (every rule
 * of plan 5.2: exactly three seats, unique ids, models in the adapter's list, fallbacks a different occupant) before
 * anything is written. Then a timestamped backup is written beside the file (mode 0600), and the file is replaced
 * atomically (a temp file in the same directory, then a rename). `--dry-run` prints the diff and writes nothing.
 */

export class SeatApplyError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'SeatApplyError';
  }
}

export interface ApplyOptions {
  registry?: AdapterRegistry | undefined;
  dryRun: boolean;
  /** The seam (default: the editor that keeps every other byte). */
  editor?: SeatEditor | undefined;
  /** Tests pin the backup's timestamp. */
  now?: Date | undefined;
}

export interface ApplyResult {
  /** The file edited: the config path's realpath (a symlinked config keeps its link). */
  path: string;
  diff: string;
  written: boolean;
  backup: string | null;
  /** The edit changed nothing. */
  unchanged: boolean;
}

function formatIssue(issue: ConfigIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

/** D10 in plain words, for the command that would break it. */
function seatCountHint(op: SeatEdit, errors: readonly ConfigIssue[]): string | null {
  const m = errors.map((e) => /exactly \d+ seats are required \(D10\); found (\d+)/.exec(e.message)).find((x) => x !== null);
  if (!m) return null;
  const found = Number(m[1]);
  if (op.kind === 'remove' && found < SEAT_COUNT) {
    return `seats are fixed at ${SEAT_COUNT} (D10): removing seat "${op.seat}" would leave ${found}; to replace its occupant, use \`seats swap ${op.seat} --backend <backend> --model <model>\``;
  }
  if (op.kind === 'add' && found > SEAT_COUNT) {
    return `seats are fixed at ${SEAT_COUNT} (D10): \`seats add\` works only below ${SEAT_COUNT} seats; to change a seat's occupant, use \`seats swap <seat> --backend <backend> --model <model>\``;
  }
  return `seats are fixed at ${SEAT_COUNT} (D10): after this edit the file would have ${found}`;
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Writes `bytes` to a new file (never an existing one) with `mode`. */
function writeNew(path: string, bytes: string | Buffer, mode: number): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
  try {
    writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export async function applySeatEdit(configPath: string, op: SeatEdit, options: ApplyOptions): Promise<ApplyResult> {
  let real: string;
  try {
    real = realpathSync(configPath);
  } catch (error) {
    throw new SeatApplyError((error as NodeJS.ErrnoException).code === 'ENOENT' ? `no config file at ${configPath}` : `cannot read ${configPath}: ${(error as Error).message}`);
  }
  if (!lstatSync(real).isFile()) throw new SeatApplyError(`${configPath} is not a regular file; refusing to edit it`);
  const original = readFileSync(real);
  const text = original.toString('utf8');
  if (Buffer.compare(Buffer.from(text, 'utf8'), original) !== 0) throw new SeatApplyError(`${configPath} is not valid UTF-8; refusing to edit it`);

  let edited: string;
  try {
    edited = (options.editor ?? preservingEditor).edit(text, op);
  } catch (error) {
    if (error instanceof SeatEditError) throw new SeatApplyError(`cannot edit ${configPath} safely: ${error.message}`);
    throw error;
  }
  const diff = unifiedDiff(text, edited, basename(real));
  if (edited === text) return { path: real, diff, written: false, backup: null, unchanged: true };

  const loaded = await parseConfigText(edited, { registry: options.registry });
  if (!loaded.ok) {
    const hint = seatCountHint(op, loaded.errors);
    throw new SeatApplyError(`refused: the config loader would reject the edited file (${loaded.errors.length} error(s)); nothing was written`, [
      ...(hint !== null ? [hint] : []),
      ...loaded.errors.map(formatIssue),
    ]);
  }
  if (options.dryRun) return { path: real, diff, written: false, backup: null, unchanged: false };

  const dir = dirname(real);
  let backup = join(dir, `${basename(real)}.bak-${stamp(options.now ?? new Date())}`);
  for (let n = 2; ; n++) {
    try {
      writeNew(backup, original, 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99) throw error;
      backup = join(dir, `${basename(real)}.bak-${stamp(options.now ?? new Date())}-${n}`);
    }
  }
  const tmp = join(dir, `.${basename(real)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeNew(tmp, edited, statSync(real).mode & 0o777);
    // The file must still be what was read and checked: another writer in between is refused, never overwritten.
    if (Buffer.compare(readFileSync(real), original) !== 0) throw new SeatApplyError(`${configPath} changed while it was being edited; nothing was written (run the command again)`);
    renameSync(tmp, real);
  } catch (error) {
    rmSync(tmp, { force: true });
    rmSync(backup, { force: true });
    throw error;
  }
  return { path: real, diff, written: true, backup, unchanged: false };
}
