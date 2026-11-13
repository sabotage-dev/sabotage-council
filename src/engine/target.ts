import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ContextSource } from '../root/build.js';
import { FULL_SHA, GitError, runGit } from '../root/git.js';

/*
 * Resolving what a `plan` or `diff` round reviews (plan 9.1, 9.2): the repository, the head (a snapshot commit when
 * the work is uncommitted), the base, and the target's store key (plan 3.6: plan targets by repo + path, diff
 * targets by repo + branch). Every git call runs through the engine's isolated runner (no hooks, no user config).
 */

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetError';
  }
}

export type RoundMode = 'plan' | 'diff';

export interface ResolvedTarget {
  mode: RoundMode;
  /** The work tree's top level (a realpath). */
  repoTop: string;
  /** `targets.repo`: the origin remote as `host/owner/name`, else the work tree's path. */
  repoKey: string;
  /** The `<repo>/` directory name inside the root. */
  repoName: string;
  /** The reviewed head, an exact sha: HEAD, an explicit ref, or a snapshot of uncommitted work. */
  head: string;
  /** Set when `head` is a snapshot commit of uncommitted work, with what it holds. */
  snapshot: string | null;
  /** diff only: the base side; the root holds the merge-base of base and head. */
  base: string | null;
  /** diff only: the branch the target is keyed by. */
  branch: string | null;
  /** plan only: the plan's path inside the repository. */
  planPath: string | null;
  /** What the brief names as the target: the plan path, or `<repo>@<branch>`. */
  label: string;
  /** The finding-id namespace (plan 7.3): `plan:<repoKey>:<path>` or `diff:<repoKey>:<branch>`. */
  targetKey: string;
  context: ContextSource[];
}

const ROOT_IDENTITY = ['-c', 'user.name=sabotage-council', '-c', 'user.email=sabotage-council@localhost'];
// Fixed dates: a snapshot of the same tree on the same parent is the same commit, so a re-run on unchanged work is
// the same head (plan 3.6 counts heads).
const SNAPSHOT_DATES = { GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z' };

function git(args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv, okStatuses?: readonly number[]): { status: number; out: string } {
  const r = runGit(args, { cwd, env, okStatuses });
  return { status: r.status, out: r.stdout.toString('utf8').trim() };
}

/** The work tree's top level, by realpath. */
export function repoTopOf(cwd: string): string {
  let top: string;
  try {
    top = git(['rev-parse', '--show-toplevel'], cwd).out;
  } catch (error) {
    throw new TargetError(`${cwd} is not inside a git work tree (${(error as Error).message})`);
  }
  if (top === '') throw new TargetError(`${cwd} is not inside a git work tree`);
  return realpathSync(top);
}

/** `git@github.com:o/r.git`, `https://github.com/o/r` and `ssh://git@github.com/o/r.git` all give `github.com/o/r`. */
export function normalizeRemote(url: string): string | null {
  const u = url.trim();
  let m = /^[A-Za-z0-9._-]+@([^:/]+):(.+)$/.exec(u);
  if (m?.[1] !== undefined && m[2] !== undefined) return `${m[1].toLowerCase()}/${stripGit(m[2])}`;
  m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(u);
  if (m?.[1] !== undefined && m[2] !== undefined) return `${m[1].toLowerCase()}/${stripGit(m[2])}`;
  return null;
}

function stripGit(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/, '');
}

/** The repository's store key and the name its tree gets inside the root. */
export function repoIdentity(top: string): { repoKey: string; repoName: string } {
  const remote = git(['config', '--get', 'remote.origin.url'], top, undefined, [0, 1]);
  const key = remote.status === 0 ? normalizeRemote(remote.out) : null;
  const rawName = key !== null ? (key.split('/').at(-1) ?? basename(top)) : basename(top);
  return { repoKey: key ?? top, repoName: safeName(rawName) };
}

/** A root directory name (build.ts NAME): letters, digits, `.`, `_`, `-`, not starting with `.` or `-`. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[.-]+/, '').slice(0, 100);
  return cleaned === '' ? 'repo' : cleaned;
}

function resolveSha(top: string, ref: string): string {
  if (ref.startsWith('-') || /[\0-\x1f\x7f\s]/.test(ref)) throw new TargetError(`unsafe ref "${ref}"`);
  const r = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], top, undefined, [0, 1]);
  if (r.status !== 0 || !FULL_SHA.test(r.out)) throw new TargetError(`${ref} does not resolve to a commit`);
  return r.out;
}

/**
 * Snapshots uncommitted work into a commit object without touching the user's index or branches (plan 9.1, 9.2):
 * a temporary index is filled from HEAD, then from the working tree (`paths` given: those files only, each with
 * `git hash-object`; else every tracked change and every untracked, non-ignored file), written with `write-tree`
 * and committed with `commit-tree` on HEAD. Returns null when the snapshot equals HEAD.
 */
export function snapshotWorkTree(top: string, headSha: string, paths?: readonly string[]): string | null {
  const dir = mkdtempSync(join(tmpdir(), 'sc-snapshot-'));
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    git(['read-tree', headSha], top, env);
    if (paths !== undefined) {
      for (const p of paths) {
        const abs = join(top, p);
        if (!existsSync(abs)) throw new TargetError(`${p} does not exist in the work tree`);
        const blob = git(['hash-object', '-w', '--', p], top).out;
        const mode = (statSync(abs).mode & 0o111) !== 0 ? '100755' : '100644';
        git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${p}`], top, env);
      }
    } else {
      git(['add', '--all', '--', '.'], top, env);
    }
    const tree = git(['write-tree'], top, env).out;
    const headTree = git(['rev-parse', `${headSha}^{tree}`], top).out;
    if (tree === headTree) return null;
    const commit = runGit([...ROOT_IDENTITY, 'commit-tree', tree, '-p', headSha, '-m', 'sabotage-council snapshot of uncommitted work'], {
      cwd: top,
      env: SNAPSHOT_DATES,
    });
    return commit.stdout.toString('utf8').trim();
  } catch (error) {
    if (error instanceof TargetError) throw error;
    throw new TargetError(`could not snapshot the uncommitted work: ${(error as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `--context <path>` or `--context <repo>@<ref>` (a local git repository at a ref, pinned to its commit). */
export function parseContext(arg: string, cwd: string): ContextSource {
  const at = arg.lastIndexOf('@');
  if (at > 0) {
    const repo = resolve(cwd, arg.slice(0, at));
    const ref = arg.slice(at + 1);
    if (ref !== '' && existsSync(repo) && statSync(repo).isDirectory()) {
      const isRepo = runGit(['rev-parse', '--git-dir'], { cwd: repo, okStatuses: [0, 128] }).status === 0;
      if (isRepo) return { repo, ref };
    }
  }
  const path = resolve(cwd, arg);
  if (!existsSync(path)) throw new TargetError(`context ${arg} is neither an existing path nor <repo>@<ref>`);
  return { path };
}

function insideTop(top: string, abs: string): string | null {
  const rel = relative(top, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * `plan <file>` (plan 9.1): the plan at its repo-relative path. The head is HEAD; when the plan file itself is
 * uncommitted (modified or untracked), the head is a snapshot holding HEAD plus that one file (`git hash-object`),
 * so the plan's revision has a sha. Other uncommitted files are not part of a plan round.
 */
export function resolvePlanTarget(cwd: string, file: string, contexts: readonly string[] = []): ResolvedTarget {
  const top = repoTopOf(cwd);
  const abs = resolve(cwd, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new TargetError(`${file} is not a file`);
  const real = realpathSync(abs);
  const rel = insideTop(top, real);
  if (rel === null) throw new TargetError(`${file} is not inside the repository at ${top}`);
  const head = resolveSha(top, 'HEAD');
  const snapshot = snapshotWorkTree(top, head, [rel]);
  const { repoKey, repoName } = repoIdentity(top);
  return {
    mode: 'plan',
    repoTop: top,
    repoKey,
    repoName,
    head: snapshot ?? head,
    snapshot: snapshot === null ? null : `HEAD ${head.slice(0, 7)} plus the uncommitted ${rel}`,
    base: null,
    branch: null,
    planPath: rel,
    label: rel,
    targetKey: `plan:${repoKey}:${rel}`,
    context: contexts.map((c) => parseContext(c, cwd)),
  };
}

/** The default branch: `origin/HEAD`, else a local `main`, else `master`. */
export function defaultBranch(top: string): string {
  const sym = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], top, undefined, [0, 1, 128]);
  if (sym.status === 0 && sym.out.startsWith('refs/remotes/')) return sym.out.slice('refs/remotes/'.length);
  for (const name of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`], top, undefined, [0, 1]).status === 0) return name;
  }
  throw new TargetError('no default branch found (origin/HEAD, main or master); give the range as <base>..<head>');
}

function currentBranch(top: string): string | null {
  const r = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], top, undefined, [0, 1, 128]);
  return r.status === 0 && r.out !== '' ? r.out : null;
}

/**
 * `diff [<base>..<head>]` (plan 9.2). Default: the merge-base with the default branch .. HEAD, with uncommitted work
 * (tracked changes and untracked, non-ignored files) snapshotted to a commit object. An explicit head is taken as
 * committed. The target is keyed by repo + branch: the current branch, or the head ref as given.
 */
export function resolveDiffTarget(cwd: string, range?: string): ResolvedTarget {
  const top = repoTopOf(cwd);
  const { repoKey, repoName } = repoIdentity(top);
  let base: string;
  let head: string;
  let branch: string;
  let snapshot: string | null = null;
  if (range === undefined || range === '') {
    const headSha = resolveSha(top, 'HEAD');
    base = resolveSha(top, defaultBranch(top));
    const snap = snapshotWorkTree(top, headSha);
    head = snap ?? headSha;
    if (snap !== null) snapshot = `HEAD ${headSha.slice(0, 7)} plus the uncommitted work tree`;
    branch = currentBranch(top) ?? `detached-${headSha.slice(0, 7)}`;
  } else {
    const parts = range.split('..');
    const [from, to] = parts;
    if (parts.length !== 2 || range.includes('...') || !from || !to) throw new TargetError(`a diff range is <base>..<head>, got "${range}"`);
    base = resolveSha(top, from);
    head = resolveSha(top, to);
    branch = to;
  }
  if (/\s/.test(branch)) throw new TargetError(`branch "${branch}" holds whitespace`);
  return {
    mode: 'diff',
    repoTop: top,
    repoKey,
    repoName,
    head,
    snapshot,
    base,
    branch,
    planPath: null,
    label: `${repoName}@${branch}`,
    targetKey: `diff:${repoKey}:${branch}`,
    context: [],
  };
}

export { GitError };
