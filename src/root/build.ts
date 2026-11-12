import { cpSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { extractTree, listTree } from './archive.js';
import { dataLines, ITEM_ID, renderPreviousReviews, renderPrMd, type EarlierItem, type PrData } from './data-files.js';
import { CHANGED_FILES_UNKNOWN, detectFold, type FoldPlan } from './fold.js';
import { commitExists, DIFF_ARGS, FULL_SHA, openShadow, resolveCommit, runGit, type ShadowRepo } from './git.js';
import { FileNameError } from './names.js';
import { sanitizedPathMap, sanitizeTrees, type SanitizedEntry } from './sanitize.js';
import { neutralizeSymlinks, symlinkText, type NeutralizedLink } from './symlinks.js';
import { lstatOrNull, walk } from './walk.js';

/** Fixed names inside a root (plan 5.3). */
export const ROOT_NAMES = {
  base: '_base',
  context: 'context',
  brief: 'BRIEF.md',
  prDiff: 'PR.diff',
  foldDiff: 'FOLD.diff',
  commitsLog: 'COMMITS.log',
  prMd: 'PR.md',
  previousReviews: 'PREVIOUS-REVIEWS.md',
} as const;

const RESERVED = new Set(
  [...Object.values(ROOT_NAMES), '_repo-agent-config'].map((n) => n.toLowerCase()),
);

export class RootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RootError';
  }
}

/** A context entry copied from a local file or directory. */
export interface ContextFromPath {
  name?: string | undefined;
  path: string;
}

/** A context entry archived from a local git repository at a ref, pinned to the commit it resolves to. */
export interface ContextFromRepo {
  name?: string | undefined;
  repo: string;
  ref: string;
}

export type ContextSource = ContextFromPath | ContextFromRepo;

/** What a root is built from. Forge reads are P6, so the PR text and earlier items arrive as plain data. */
export interface RootInputs {
  /** A local git repository (a work tree or a bare repository). */
  repo: string;
  /** The `<repo>/` directory name inside the root. */
  name: string;
  /** The head commit, as an exact sha. */
  head: string;
  /** The base commit (e.g. the PR's base tip). `_base/` holds the merge-base of base and head. */
  base?: string | undefined;
  /** Delta rounds: the baseline head, reviewed in an earlier round (plan 3.6). */
  baseline?: string | undefined;
  pr?: PrData | undefined;
  previousReviews?: readonly EarlierItem[] | undefined;
  context?: readonly ContextSource[] | undefined;
}

/** What the integrity check expects at a root-relative path. */
export interface ExpectedEntry {
  kind: 'file' | 'symlink';
  size: number;
  /** `<repo>@<sha>`, `context:<name>` or `engine`, for messages. */
  origin: string;
}

export interface ContextEntry {
  name: string;
  kind: 'path' | 'git';
  /** A short description for the brief, e.g. `docs-repo@main`; never an absolute path. */
  label: string;
  /** The pinned commit for git entries; null for local paths. */
  sha: string | null;
  isDir: boolean;
}

/** The facts about a root the brief needs (plan 3.9), independent of where the root lives. */
export interface RootLayout {
  repoDir: string;
  head: string;
  /** The merge-base held in `_base/`; null when no base was given. */
  mergeBase: string | null;
  fold: FoldPlan | null;
  files: { prDiff: boolean; foldDiff: boolean; commitsLog: boolean; prMd: boolean; previousReviews: boolean };
  context: readonly ContextEntry[];
  /** The ids of the items in PREVIOUS-REVIEWS.md, in order; the brief asks for a row on each open one. */
  earlierItems: readonly { id: string; closedContext: boolean }[];
}

export interface BuiltRoot extends RootLayout {
  root: string;
  neutralized: NeutralizedLink[];
  sanitized: SanitizedEntry[];
  /** Root-relative path, after the sanitizer, to what the integrity check expects there. */
  expected: Map<string, ExpectedEntry>;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function checkName(name: string, what: string): void {
  if (!NAME.test(name)) throw new RootError(`${what} "${name}" must be 1-100 characters: letters, digits, ".", "_" or "-", not starting with "." or "-"`);
  if (RESERVED.has(name.toLowerCase())) throw new RootError(`${what} "${name}" is a reserved root name`);
}

function checkSha(sha: string | undefined, what: string): void {
  if (sha !== undefined && !FULL_SHA.test(sha)) throw new RootError(`${what} must be an exact full sha, got "${sha}"`);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** The root's layout, for the brief. */
export function layoutOf(built: BuiltRoot): RootLayout {
  const { repoDir, head, mergeBase, fold, files, context, earlierItems } = built;
  return { repoDir, head, mergeBase, fold, files, context, earlierItems };
}

/**
 * Builds a review root (plan 5.3) in `rootDir`, which must not exist or be empty:
 * 1. `<repo>/` at the head and `_base/` at the merge-base, archived through a temp file;
 * 2. `PR.diff` and `FOLD.diff` (delta rounds); `COMMITS.log`, `PR.md` and `PREVIOUS-REVIEWS.md` with every line
 *    prefixed `DATA:`;
 * 3. `context/` entries from local paths or `repo@ref`;
 * 4. symlink neutralization over `<repo>/`, `_base/` and `context/`, right after extraction;
 * 5. the sanitizer over the same trees.
 * The brief, the integrity check, the tree hash and the git commit follow (prepareRoot, sealRoot).
 */
export function buildRoot(rootDir: string, inputs: RootInputs): BuiltRoot {
  checkName(inputs.name, 'repo name');
  checkSha(inputs.head, 'head');
  checkSha(inputs.base, 'base');
  checkSha(inputs.baseline, 'baseline');
  const contextNames = new Set<string>();
  for (const c of inputs.context ?? []) {
    const name = c.name ?? defaultContextName(c);
    checkName(name, 'context name');
    if (contextNames.has(name.toLowerCase())) throw new RootError(`duplicate context name "${name}"`);
    contextNames.add(name.toLowerCase());
  }
  const items = inputs.previousReviews ?? [];
  const ids = new Set<string>();
  for (const item of items) {
    if (!ITEM_ID.test(item.id)) throw new RootError(`earlier item id "${item.id}" is malformed`);
    if (ids.has(item.id)) throw new RootError(`duplicate earlier item id "${item.id}"`);
    ids.add(item.id);
  }

  const root = resolve(rootDir);
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).length > 0) throw new RootError(`root directory ${root} is not empty; roots are never reused`);

  const work = mkdtempSync(join(tmpdir(), 'sabotage-council-build-'));
  try {
    return build(root, work, inputs, items);
  } catch (err) {
    // A name that is not valid UTF-8, or two entries with one decoded path: the build fails closed (FileNameError).
    if (err instanceof FileNameError) throw new RootError(`the root cannot be built: ${err.message}`);
    throw err;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function defaultContextName(c: ContextSource): string {
  return 'repo' in c ? basename(resolve(c.repo)).replace(/\.git$/, '') : basename(resolve(c.path));
}

function build(root: string, work: string, inputs: RootInputs, items: readonly EarlierItem[]): BuiltRoot {
  const expected = new Map<string, ExpectedEntry>();
  let tarCount = 0;
  const shadowFor = (repo: string): ShadowRepo => openShadow(repo, join(work, `shadow-${tarCount++}.git`));
  const extract = (shadow: ShadowRepo, sha: string, dest: string, origin: string): void => {
    // Listed (and every name checked) before anything is written, so a name the root refuses never reaches the disk.
    const entries = listTree(shadow, sha);
    extractTree(shadow, sha, join(root, dest), join(work, `tree-${tarCount++}.tar`));
    for (const entry of entries) {
      if (entry.size === null) continue; // a submodule: git archive writes no content for it
      const kind = entry.mode === '120000' ? 'symlink' : 'file';
      expected.set(`${dest}/${entry.path}`, { kind, size: entry.size, origin });
    }
  };
  const engineFile = (name: string, content: string): void => {
    writeFileSync(join(root, name), content, { flag: 'wx' });
    expected.set(name, { kind: 'file', size: Buffer.byteLength(content), origin: 'engine' });
  };
  const gitToFile = (shadow: ShadowRepo, args: readonly string[], name: string, emptyText: string): void => {
    const file = join(root, name);
    runGit(args, { gitDir: shadow.gitDir, stdoutFile: file });
    const size = statSync(file).size;
    if (size === 0) writeFileSync(file, emptyText); // never a zero-byte engine file (integrity, plan 5.3)
    expected.set(name, { kind: 'file', size: size === 0 ? Buffer.byteLength(emptyText) : size, origin: 'engine' });
  };

  const shadow = shadowFor(inputs.repo);
  for (const [sha, what] of [
    [inputs.head, 'head'],
    [inputs.base, 'base'],
  ] as const) {
    if (sha !== undefined && !commitExists(shadow, sha)) throw new RootError(`${what} ${sha} is not a commit in ${inputs.repo}`);
  }

  extract(shadow, inputs.head, inputs.name, `${inputs.name}@${short(inputs.head)}`);

  let mergeBase: string | null = null;
  if (inputs.base !== undefined) {
    const mb = runGit(['merge-base', inputs.base, inputs.head], { gitDir: shadow.gitDir, okStatuses: [0, 1] });
    mergeBase = mb.stdout.toString('utf8').trim();
    if (mb.status !== 0 || !FULL_SHA.test(mergeBase)) {
      throw new RootError(`base ${short(inputs.base)} and head ${short(inputs.head)} have no merge-base`);
    }
    extract(shadow, mergeBase, ROOT_NAMES.base, `${inputs.name}@${short(mergeBase)}`);
    gitToFile(shadow, [...DIFF_ARGS, mergeBase, inputs.head], ROOT_NAMES.prDiff, `(no changes between ${short(mergeBase)} and ${short(inputs.head)})\n`);
    // Commit messages are PR text (plan 6.3): every line is prefixed DATA: before the file is written and sized.
    const log = runGit(
      ['log', '--no-color', '--no-decorate', '--no-mailmap', '--date=iso-strict', '--pretty=medium', `${mergeBase}..${inputs.head}`],
      { gitDir: shadow.gitDir },
    ).stdout.toString('utf8');
    const commits = log === '' ? `(no commits between ${short(mergeBase)} and ${short(inputs.head)})` : log;
    engineFile(ROOT_NAMES.commitsLog, `${dataLines(commits).join('\n')}\n`);
  }

  let fold: FoldPlan | null = null;
  if (inputs.baseline !== undefined) {
    fold = detectFold(shadow, inputs.baseline, inputs.head);
    if (fold.kind === 'delta') {
      gitToFile(shadow, [...DIFF_ARGS, inputs.baseline, inputs.head], ROOT_NAMES.foldDiff, '(empty fold)\n');
    }
  }

  if (inputs.pr !== undefined) engineFile(ROOT_NAMES.prMd, renderPrMd(inputs.pr));
  if (items.length > 0) engineFile(ROOT_NAMES.previousReviews, renderPreviousReviews(items));

  const context: ContextEntry[] = [];
  for (const source of inputs.context ?? []) {
    const name = source.name ?? defaultContextName(source);
    const dest = `${ROOT_NAMES.context}/${name}`;
    mkdirSync(join(root, ROOT_NAMES.context), { recursive: true });
    if ('repo' in source) {
      let sha: string;
      try {
        sha = resolveCommit(source.repo, source.ref);
      } catch (err) {
        throw new RootError(`context ${name}: ${source.ref} does not resolve to a commit in ${source.repo} (${(err as Error).message})`);
      }
      extract(shadowFor(source.repo), sha, dest, `context:${name}@${short(sha)}`);
      const label = `${defaultContextName(source)}@${source.ref}`;
      context.push({ name, kind: 'git', label, sha, isDir: true });
    } else {
      context.push({ name, kind: 'path', label: `local path ${basename(resolve(source.path))}`, sha: null, isDir: copyPath(root, source.path, dest, expected, name) });
    }
  }

  // Symlinks first (plan 5.3), then the sanitizer (plan 6.2), over the same three trees.
  const trees = [inputs.name, ROOT_NAMES.base, ROOT_NAMES.context];
  const neutralized = neutralizeSymlinks(root, trees);
  for (const link of neutralized) {
    const prev = expected.get(link.path);
    if (prev !== undefined) expected.set(link.path, { kind: 'file', size: Buffer.byteLength(symlinkText(link.target)), origin: prev.origin });
  }
  const sanitized = sanitizeTrees(root, trees);
  const finalPath = sanitizedPathMap(sanitized);
  const mapped = new Map<string, ExpectedEntry>();
  for (const [path, entry] of expected) mapped.set(finalPath(path), entry);
  // The fallback's changed files, named as the seats see them: under <repo>/, where the sanitizer put them.
  if (fold?.kind === 'fallback' && fold.changedFiles !== CHANGED_FILES_UNKNOWN) {
    fold = { ...fold, changedFiles: fold.changedFiles.map((p) => finalPath(`${inputs.name}/${p}`)) };
  }

  return {
    root,
    repoDir: inputs.name,
    head: inputs.head,
    mergeBase,
    fold,
    files: {
      prDiff: mergeBase !== null,
      foldDiff: fold?.kind === 'delta',
      commitsLog: mergeBase !== null,
      prMd: inputs.pr !== undefined,
      previousReviews: items.length > 0,
    },
    context,
    earlierItems: items.map((i) => ({ id: i.id, closedContext: i.closedContext === true })),
    neutralized,
    sanitized,
    expected: mapped,
  };
}

const isGitDir = (name: string): boolean => name.toLowerCase() === '.git';

/**
 * Copies a local file or directory into the root. Links are copied as links (never followed) and judged by the
 * symlink pass like any other. `.git` entries are skipped: they hold another repository's config and hooks, not
 * context. Returns whether the entry is a directory.
 */
function copyPath(root: string, source: string, dest: string, expected: Map<string, ExpectedEntry>, name: string): boolean {
  const src = resolve(source);
  const stats = lstatOrNull(src);
  if (stats === null) throw new RootError(`context ${name}: ${source} does not exist`);
  if (isGitDir(basename(src))) throw new RootError(`context ${name}: a .git directory is not context`);
  const origin = `context:${name}`;
  const record = (rel: string, kind: 'file' | 'symlink', size: number): void => {
    expected.set(rel, { kind, size, origin });
  };
  if (stats.isDirectory()) {
    for (const entry of walk(src, '', (e) => !isGitDir(basename(e.rel)))) {
      if (entry.rel.split('/').some(isGitDir)) continue;
      if (entry.kind === 'file') record(`${dest}/${entry.rel}`, 'file', entry.stats.size);
      else if (entry.kind === 'symlink') record(`${dest}/${entry.rel}`, 'symlink', Buffer.byteLength(readlinkSync(entry.abs)));
      else if (entry.kind === 'other') throw new RootError(`context ${name}: ${entry.rel} is not a regular file, directory or link`);
    }
  } else if (stats.isSymbolicLink()) {
    record(dest, 'symlink', Buffer.byteLength(readlinkSync(src)));
  } else if (stats.isFile()) {
    record(dest, 'file', stats.size);
  } else {
    throw new RootError(`context ${name}: ${source} is not a regular file, directory or link`);
  }
  try {
    cpSync(src, join(root, dest), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      filter: (from) => from === src || !isGitDir(basename(from)),
    });
  } catch (err) {
    throw new RootError(`context ${name}: copying ${source} failed: ${(err as Error).message}`);
  }
  return stats.isDirectory();
}

