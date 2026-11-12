import { spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly status: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Config passed with `-c` on every engine git call (plan 5.3). Command-line config outranks the repository's own
 * config file, so a repository cannot turn these back on. Hooks point at /dev/null, fsmonitor is off, no
 * transport may run, and the user's global attribute and exclude files are not read.
 */
export const GIT_ISOLATION_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.quotePath=false',
  'protocol.allow=never',
  'submodule.recurse=false',
  'commit.gpgSign=false',
  'log.showSignature=false',
  'gc.auto=0',
  'maintenance.auto=false',
];

/**
 * Attributes written to `info/attributes` of every git dir the engine owns. That file outranks the tree's own
 * `.gitattributes`, and `!attr` resets each attribute to unspecified. Without it a reviewed tree could hide a file
 * from the archive (`export-ignore`), rewrite one (`export-subst`, `ident`, eol conversion), or turn its diff into
 * "Binary files differ" (`-diff`), so the seats would not see what the git tree holds.
 */
export const NEUTRAL_ATTRIBUTES =
  '* !text !eol !crlf !ident !filter !working-tree-encoding !diff !merge !export-ignore !export-subst\n';

/** Environment for engine git calls: nothing inherited but the basics, and no user or system config. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR']) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
  };
}

export interface GitOptions {
  cwd?: string;
  gitDir?: string;
  workTree?: string;
  /** Exit statuses that are not errors (default: only 0). */
  okStatuses?: readonly number[];
  /** Write stdout straight to this file instead of buffering it (diffs can be large). */
  stdoutFile?: string;
  /** Extra environment on top of `gitEnv()`. */
  env?: NodeJS.ProcessEnv;
}

export interface GitResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export function runGit(args: readonly string[], options: GitOptions = {}): GitResult {
  const full: string[] = ['--no-pager'];
  for (const entry of GIT_ISOLATION_CONFIG) full.push('-c', entry);
  if (options.gitDir !== undefined) full.push(`--git-dir=${options.gitDir}`);
  if (options.workTree !== undefined) full.push(`--work-tree=${options.workTree}`);
  full.push(...args);
  const fd = options.stdoutFile === undefined ? undefined : openSync(options.stdoutFile, 'wx', 0o644);
  try {
    const result = spawnSync('git', full, {
      cwd: options.cwd,
      env: { ...gitEnv(), ...options.env },
      stdio: ['ignore', fd ?? 'pipe', 'pipe'],
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.error) throw new GitError(`git ${args.join(' ')}: ${result.error.message}`, args, null, '');
    const stderr = result.stderr.toString('utf8');
    const status = result.status ?? -1;
    if (!(options.okStatuses ?? [0]).includes(status)) {
      const detail = stderr.trim() === '' ? `exit status ${status}` : stderr.trim();
      throw new GitError(`git ${args.join(' ')} failed: ${detail}`, args, status, stderr);
    }
    return { status, stdout: result.stdout ?? Buffer.alloc(0), stderr };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function gitText(args: readonly string[], options: GitOptions = {}): string {
  return runGit(args, options).stdout.toString('utf8').trim();
}

/** A full 40-hex (SHA-1) or 64-hex (SHA-256) object id. Exact SHAs only: no refs, no abbreviations. */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * A bare repository the engine owns, reading a local repository's objects through `objects/info/alternates`.
 * It has no refs, hooks or config of the source, and its `info/attributes` neutralizes the tree's own
 * `.gitattributes` (see NEUTRAL_ATTRIBUTES). In P1 it stands in for the bare mirror of plan 5.3.
 */
export interface ShadowRepo {
  gitDir: string;
  /** The source repository as given. */
  source: string;
}

export function openShadow(source: string, gitDir: string): ShadowRepo {
  requireGit();
  let commonDir: string;
  let format: string;
  try {
    commonDir = gitText(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: source });
    format = gitText(['rev-parse', '--show-object-format'], { cwd: source });
  } catch (err) {
    throw new GitError(`${source} is not a readable git repository: ${(err as Error).message}`, [], null, '');
  }
  const objects = join(commonDir, 'objects');
  if (/[\r\n]/.test(objects)) throw new GitError(`unsupported object directory path: ${objects}`, [], null, '');
  initBare(gitDir, format);
  mkdirSync(join(gitDir, 'objects', 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'objects', 'info', 'alternates'), `${objects}\n`);
  return { gitDir, source };
}

/**
 * The oldest git the isolation holds on: `GIT_CONFIG_GLOBAL` arrived in 2.32. An older git ignores it and reads
 * the user's global config, so the engine refuses it instead.
 */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 32];

let gitChecked = false;

export function requireGit(): void {
  if (gitChecked) return;
  const out = gitText(['version']);
  const m = /(\d+)\.(\d+)/.exec(out);
  const [major, minor] = [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];
  const [wantMajor, wantMinor] = MIN_GIT_VERSION;
  if (major < wantMajor || (major === wantMajor && minor < wantMinor)) {
    throw new GitError(`git ${wantMajor}.${wantMinor} or later is required for config isolation; found "${out}"`, ['version'], 0, '');
  }
  gitChecked = true;
}

/** `git init --bare` with no template (no sample hooks) and the neutral attributes file. */
export function initBare(gitDir: string, objectFormat = 'sha1'): void {
  requireGit();
  runGit(['init', '--bare', '--quiet', '--template=', `--object-format=${objectFormat}`, gitDir]);
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'info', 'attributes'), NEUTRAL_ATTRIBUTES);
}

export function commitExists(shadow: ShadowRepo, sha: string): boolean {
  return runGit(['cat-file', '-e', `${sha}^{commit}`], { gitDir: shadow.gitDir, okStatuses: [0, 1, 128] }).status === 0;
}

export function isAncestor(shadow: ShadowRepo, ancestor: string, head: string): boolean {
  const { status } = runGit(['merge-base', '--is-ancestor', ancestor, head], { gitDir: shadow.gitDir, okStatuses: [0, 1] });
  return status === 0;
}

/** Resolves a ref (or a sha) in the source repository to a full commit id. */
export function resolveCommit(source: string, ref: string): string {
  if (ref.startsWith('-') || /[\0-\x1f\x7f]/.test(ref)) throw new GitError(`unsafe ref "${ref}"`, [], null, '');
  return gitText(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: source });
}

/** Diff options shared by PR.diff and FOLD.diff: no external diff, no textconv, renames found, plain text. */
export const DIFF_ARGS: readonly string[] = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '--submodule=short'];
