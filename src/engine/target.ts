import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { basename, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import type { ContextSource } from '../root/build.js';
import { FULL_SHA, GitError, runGit } from '../root/git.js';
import { decodeName, splitNul } from '../root/names.js';

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
  /** Things the user must hear before the round runs: for example untracked files left out of the snapshot. */
  warnings: string[];
  /** The committed head the work sits on (the head itself unless `head` is a snapshot). */
  headCommit: string;
  /** The uncommitted work's tree when `head` is a snapshot of it; else null. */
  snapshotTree: string | null;
  /** plan: the plan path plus in-repository context paths the fold covers (fold row 11); diff: null (the whole tree). */
  foldPaths: string[] | null;
  /** What numbering compares (3.6): the head for diff targets; the content of `foldPaths` for plan targets. */
  revision: string;
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
 * Untracked files whose names look like secrets (fold row 2). They are never put in a snapshot: the root goes to
 * three model vendors. Basenames only: `.env` and `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, and SSH key names
 * (`id_<word>`, `id_<word>.pub`).
 */
export const SECRET_NAME = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|id_[a-z0-9]+(?:\.pub)?)$/i;

/**
 * The user's own global excludes file, which the engine's isolated git calls never read (`core.excludesFile=/dev/null`):
 * `core.excludesFile` from the user's global git config, else git's default `$XDG_CONFIG_HOME/git/ignore` (or
 * `~/.config/git/ignore`). Null when there is none. `git config --get` runs no hook and no filter.
 */
export function userExcludesFile(env: NodeJS.ProcessEnv = process.env): string | null {
  const pick: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL']) if (env[k] !== undefined) pick[k] = env[k];
  const r = spawnSync('git', ['config', '--global', '--path', '--get', 'core.excludesFile'], { env: { ...pick, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
  const configured = r.status === 0 ? r.stdout.trim() : '';
  const home = env['HOME'] ?? '';
  const xdg = env['XDG_CONFIG_HOME'] !== undefined && env['XDG_CONFIG_HOME'] !== '' ? env['XDG_CONFIG_HOME'] : home === '' ? '' : join(home, '.config');
  const candidate = configured !== '' ? configured : xdg === '' ? '' : join(xdg, 'git', 'ignore');
  return candidate !== '' && existsSync(candidate) && statSync(candidate).isFile() ? candidate : null;
}

export interface SnapshotTree {
  /** The work tree's tree object; null when it equals the head's tree. */
  tree: string | null;
  /** Untracked files left out because their names look like secrets. */
  skipped: string[];
  warnings: string[];
}

/**
 * The tree of the uncommitted work, built in a temporary index so the user's index and branches are never touched
 * (plan 9.1, 9.2): filled from `headSha`, then (`paths` given) those files only, each with `git hash-object`; else
 * every tracked change (`add --update`) and every untracked file git lists with the user's own excludes honoured
 * (the repository's `.gitignore` files, `.git/info/exclude` and the user's global excludes file, fold row 2), minus
 * files whose names look like secrets, which are named in a warning.
 */
export function snapshotTree(top: string, headSha: string, options: { paths?: readonly string[] | undefined; env?: NodeJS.ProcessEnv | undefined } = {}): SnapshotTree {
  const dir = mkdtempSync(join(tmpdir(), 'sc-snapshot-'));
  const skipped: string[] = [];
  const warnings: string[] = [];
  try {
    const env = { GIT_INDEX_FILE: join(dir, 'index') };
    git(['read-tree', headSha], top, env);
    if (options.paths !== undefined) {
      for (const p of options.paths) {
        const abs = join(top, p);
        if (!existsSync(abs)) throw new TargetError(`${p} does not exist in the work tree`);
        const blob = git(['hash-object', '-w', '--', p], top).out;
        const mode = (statSync(abs).mode & 0o111) !== 0 ? '100755' : '100644';
        git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${p}`], top, env);
      }
    } else {
      // No pathspec: `add --update -- .` fails ("did not match any file(s)") when the head tracks no file.
      git(['add', '--update'], top, env);
      const excludes = userExcludesFile(options.env);
      const listed = runGit(['-c', `core.excludesFile=${excludes ?? '/dev/null'}`, 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: top, env });
      const untracked = splitNul(listed.stdout).map((raw) => decodeName(raw, 'the untracked files'));
      const add: string[] = [];
      for (const p of untracked) {
        if (SECRET_NAME.test(posix.basename(p))) skipped.push(p);
        else add.push(p);
      }
      for (let i = 0; i < add.length; i += 200) git(['update-index', '--add', '--', ...add.slice(i, i + 200)], top, env);
      if (skipped.length > 0) {
        warnings.push(
          `left out of the snapshot, as their names look like secrets (commit them or rename them to include them): ${skipped.map((x) => JSON.stringify(x)).join(', ')}`,
        );
      }
    }
    const tree = git(['write-tree'], top, env).out;
    const headTree = git(['rev-parse', `${headSha}^{tree}`], top).out;
    return { tree: tree === headTree ? null : tree, skipped, warnings };
  } catch (error) {
    if (error instanceof TargetError) throw error;
    throw new TargetError(`could not snapshot the uncommitted work: ${(error as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A snapshot commit: `tree` on `parent`, with fixed dates, so the same work on the same parent is the same head. */
export function commitSnapshot(top: string, tree: string, parent: string): string {
  const commit = runGit([...ROOT_IDENTITY, 'commit-tree', tree, '-p', parent, '-m', SNAPSHOT_MESSAGE], { cwd: top, env: SNAPSHOT_DATES });
  return commit.stdout.toString('utf8').trim();
}

export const SNAPSHOT_MESSAGE = 'sabotage-council snapshot of uncommitted work';

/** Snapshots uncommitted work into a commit on HEAD (plan 9.1, 9.2); null when there is nothing uncommitted. */
export function snapshotWorkTree(top: string, headSha: string, paths?: readonly string[], env?: NodeJS.ProcessEnv): string | null {
  const t = snapshotTree(top, headSha, { paths, env });
  return t.tree === null ? null : commitSnapshot(top, t.tree, headSha);
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
 * so the plan's revision has a sha. Other uncommitted files are not part of a plan round. The fold and the round
 * number follow the plan, not the repository (fold row 11): `foldPaths` is the plan plus any `--context` path inside
 * the repository, and `revision` hashes their content at the head, so an unrelated commit is not a new revision.
 */
export function resolvePlanTarget(cwd: string, file: string, contexts: readonly string[] = []): ResolvedTarget {
  const top = repoTopOf(cwd);
  const abs = resolve(cwd, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new TargetError(`${file} is not a file`);
  const real = realpathSync(abs);
  const rel = insideTop(top, real);
  if (rel === null) throw new TargetError(`${file} is not inside the repository at ${top}`);
  const headCommit = resolveSha(top, 'HEAD');
  const snap = snapshotTree(top, headCommit, { paths: [rel] });
  const head = snap.tree === null ? headCommit : commitSnapshot(top, snap.tree, headCommit);
  const { repoKey, repoName } = repoIdentity(top);
  const context = contexts.map((c) => parseContext(c, cwd));
  const inRepo = context.flatMap((c) => ('path' in c ? [insideTop(top, realpathSync(c.path))] : [])).filter((p): p is string => p !== null);
  const foldPaths = [rel, ...inRepo];
  return {
    mode: 'plan',
    repoTop: top,
    repoKey,
    repoName,
    head,
    headCommit,
    snapshotTree: snap.tree,
    snapshot: snap.tree === null ? null : `HEAD ${headCommit.slice(0, 7)} plus the uncommitted ${rel}`,
    base: null,
    branch: null,
    planPath: rel,
    label: rel,
    targetKey: `plan:${repoKey}:${rel}`,
    context,
    warnings: [],
    foldPaths,
    revision: contentRevision(top, head, foldPaths),
  };
}

/** The content of some repository paths at a commit, as one hash (a missing path counts as missing). */
export function contentRevision(top: string, commit: string, paths: readonly string[]): string {
  const parts = paths.map((p) => {
    const r = git(['rev-parse', '--verify', '--quiet', `${commit}:${p}`], top, undefined, [0, 1, 128]);
    return `${p}\0${r.status === 0 ? r.out : 'missing'}`;
  });
  return `content:${createHash('sha256').update(parts.join('\n')).digest('hex')}`;
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

function refExists(top: string, ref: string): boolean {
  return git(['show-ref', '--verify', '--quiet', ref], top, undefined, [0, 1, 128]).status === 0;
}

/**
 * The branch a diff target is keyed by (fold row 10), never the ref string `HEAD` or a raw sha: `HEAD` (or no range)
 * is the checked-out branch; a local or remote-tracking branch name is itself; anything else (a sha, a tag, a
 * detached HEAD) is keyed by the resolved base, so successive rounds on it converge.
 */
export function diffBranchKey(top: string, headToken: string | null, base: string): string {
  if (headToken === null || headToken === 'HEAD' || headToken === '@') return currentBranch(top) ?? `detached-from-${base.slice(0, 12)}`;
  if (refExists(top, `refs/heads/${headToken}`) || refExists(top, `refs/remotes/${headToken}`)) return headToken;
  return `from-${base.slice(0, 12)}`;
}

export interface DiffOptions {
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * With an explicit `<base>..<head>`, include the uncommitted work tree (fold row 10). Only when the range's head is
   * the checked-out commit. Without a range, uncommitted work is always included.
   */
  uncommitted?: boolean | undefined;
}

/**
 * `diff [<base>..<head>]` (plan 9.2). Default: the merge-base with the default branch .. HEAD, with uncommitted work
 * (tracked changes and untracked, non-ignored files) snapshotted to a commit object. An explicit range reviews the
 * committed head, and includes uncommitted work only with `uncommitted` (the warnings say which). The target is
 * keyed by `diffBranchKey`.
 */
export function resolveDiffTarget(cwd: string, range?: string, options: DiffOptions = {}): ResolvedTarget {
  const top = repoTopOf(cwd);
  const { repoKey, repoName } = repoIdentity(top);
  const checkedOut = resolveSha(top, 'HEAD');
  let base: string;
  let headCommit: string;
  let headToken: string | null = null;
  let include: boolean;
  if (range === undefined || range === '') {
    if (options.uncommitted === true) throw new TargetError('--uncommitted applies to an explicit <base>..<head> range; without one, uncommitted work is always included');
    base = resolveSha(top, defaultBranch(top));
    headCommit = checkedOut;
    include = true;
  } else {
    const parts = range.split('..');
    const [from, to] = parts;
    if (parts.length !== 2 || range.includes('...') || !from || !to) throw new TargetError(`a diff range is <base>..<head>, got "${range}"`);
    base = resolveSha(top, from);
    headCommit = resolveSha(top, to);
    headToken = to;
    include = options.uncommitted === true;
    if (include && headCommit !== checkedOut) throw new TargetError(`--uncommitted needs the range's head to be the checked-out commit ${checkedOut.slice(0, 7)}; ${to} is ${headCommit.slice(0, 7)}`);
  }
  const warnings: string[] = [];
  let snap: SnapshotTree = { tree: null, skipped: [], warnings: [] };
  if (headCommit === checkedOut) {
    snap = snapshotTree(top, headCommit, { env: options.env });
    if (include) warnings.push(...snap.warnings);
    else if (snap.tree !== null) {
      warnings.push(`the work tree has uncommitted changes this round does not include: an explicit range reviews committed history (add --uncommitted to include them)`);
    }
  }
  const tree = include ? snap.tree : null;
  const head = tree === null ? headCommit : commitSnapshot(top, tree, headCommit);
  const branch = diffBranchKey(top, headToken, base);
  if (/\s/.test(branch)) throw new TargetError(`branch "${branch}" holds whitespace`);
  return {
    mode: 'diff',
    repoTop: top,
    repoKey,
    repoName,
    head,
    headCommit,
    snapshotTree: tree,
    snapshot: tree === null ? null : `${headCommit.slice(0, 7)} plus the uncommitted work tree`,
    base,
    branch,
    planPath: null,
    label: `${repoName}@${branch}`,
    targetKey: `diff:${repoKey}:${branch}`,
    context: [],
    warnings,
    foldPaths: null,
    revision: head,
  };
}

/**
 * When `sha` is a snapshot commit the engine made (its identity, message and one parent), its parent; else null.
 */
export function snapshotParent(top: string, sha: string): string | null {
  const r = git(['cat-file', 'commit', sha], top, undefined, [0, 1, 128]);
  if (r.status !== 0) return null;
  const [header = '', ...rest] = r.out.split('\n\n');
  const parents = header.split('\n').filter((l) => l.startsWith('parent ')).map((l) => l.slice('parent '.length));
  const ours = /^author sabotage-council <sabotage-council@localhost> /m.test(header) && rest.join('\n\n').trim() === SNAPSHOT_MESSAGE;
  return ours && parents.length === 1 ? (parents[0] ?? null) : null;
}

export function isAncestorIn(top: string, ancestor: string, head: string): boolean {
  return git(['merge-base', '--is-ancestor', ancestor, head], top, undefined, [0, 1, 128]).status === 0;
}

/**
 * A follow-up round on uncommitted work (fold row 10): every snapshot sits on the commit it was taken from, so the
 * next snapshot is a sibling of the last reviewed one, not its descendant. When the baseline is a snapshot whose
 * parent is an ancestor of this head (the work went on, or was committed), its tree is still the reviewed content:
 * the fold is the delta between the two trees, not a rebase.
 */
export function baselineIsSnapshot(top: string, baseline: string | null, head: string): boolean {
  if (baseline === null) return false;
  const parent = snapshotParent(top, baseline);
  return parent !== null && isAncestorIn(top, parent, head);
}

export { GitError };
