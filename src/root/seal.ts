import { writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildRoot, layoutOf, RootError, ROOT_NAMES, type BuiltRoot, type RootInputs, type RootLayout } from './build.js';
import { initBare, runGit } from './git.js';
import { diffManifests, hashManifest, manifestOf, type ManifestChange, type ManifestEntry } from './hash.js';
import { assertIntegrity } from './integrity.js';
import { lstatOrNull } from './walk.js';

export interface SealedRoot {
  root: string;
  /** The root's git dir. It lives outside the root, so a leg cannot rewrite its config or hooks. */
  gitDir: string;
  /** Tree hash after symlinks, sanitizer and brief (plan 3.1 step 3, 5.3). */
  treeHash: string;
  manifest: ManifestEntry[];
  /** The commit holding the sealed root. */
  commit: string;
}

export interface SealOptions {
  /** Default: `<root>.git`, beside the root. */
  gitDir?: string | undefined;
}

const ROOT_IDENTITY = ['-c', 'user.name=sabotage-council', '-c', 'user.email=sabotage-council@localhost'];
const ROOT_DATES = { GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z' };

/**
 * Seals a built root whose brief is written: integrity check, tree hash, then `git init` and one commit so
 * `git status --ignored` can find residue later (plan 5.3). The git dir sits outside the root: a git dir inside
 * the root could be rewritten by a leg (config, filters, fsmonitor) and run code at the residue sweep.
 * Every file is added with `--force`, so a tree's own `.gitignore` hides nothing from the commit.
 */
export function sealRoot(built: BuiltRoot, promises: readonly string[], options: SealOptions = {}): SealedRoot {
  const root = built.root;
  assertIntegrity(root, built.expected, promises);
  const manifest = manifestOf(root);
  const treeHash = hashManifest(manifest);
  const gitDir = resolve(options.gitDir ?? `${root}.git`);
  const rel = relative(root, gitDir);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) throw new RootError(`the root's git dir must be outside the root: ${gitDir}`);
  if (lstatOrNull(gitDir) !== null) throw new RootError(`the root's git dir already exists: ${gitDir}`);
  initBare(gitDir);
  const git = { gitDir, workTree: root, cwd: root };
  runGit(['add', '--all', '--force', '--', '.'], git);
  runGit([...ROOT_IDENTITY, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', 'sabotage-council root'], { ...git, env: ROOT_DATES });
  const commit = runGit(['rev-parse', 'HEAD'], git).stdout.toString('utf8').trim();
  return { root, gitDir, treeHash, manifest, commit };
}

export interface ResidueReport {
  treeHash: string;
  /** The tree hash still equals the sealed one. */
  unchanged: boolean;
  /** What changed, from the manifests (covers ignored paths and empty directories). */
  changes: ManifestChange[];
  /** `git status --porcelain --ignored` lines (`XY path`), as a second view. */
  gitStatus: string[];
  /** Set when git status could not run; the manifest comparison still stands. */
  gitStatusError: string | null;
}

/**
 * The residue sweep (plan 3.1 step 7), called by later phases after the legs: recompute the tree hash and list
 * what changed. Any change fails every leg that could have made it.
 */
export function sweepResidue(sealed: SealedRoot): ResidueReport {
  const manifest = manifestOf(sealed.root);
  const treeHash = hashManifest(manifest);
  const changes = diffManifests(sealed.manifest, manifest);
  let gitStatus: string[] = [];
  let gitStatusError: string | null = null;
  try {
    const out = runGit(
      ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all', '--ignore-submodules=all', '--no-renames'],
      { gitDir: sealed.gitDir, workTree: sealed.root, cwd: sealed.root },
    );
    gitStatus = out.stdout
      .toString('utf8')
      .split('\0')
      .filter((l) => l !== '');
  } catch (err) {
    gitStatusError = (err as Error).message;
  }
  return { treeHash, unchanged: treeHash === sealed.treeHash, changes, gitStatus, gitStatusError };
}

export interface BriefLike {
  text: string;
  /** Root-relative paths the brief promises; a trailing `/` means a directory. */
  promises: readonly string[];
}

export interface PreparedRoot<B extends BriefLike> {
  built: BuiltRoot;
  brief: B;
  sealed: SealedRoot;
}

/**
 * The whole root lifecycle in plan order (3.1 steps 2-3): build (archive, symlinks, sanitizer), write the brief
 * inside the root, then check integrity and hash, so the hash covers the brief.
 */
export function prepareRoot<B extends BriefLike>(
  rootDir: string,
  inputs: RootInputs,
  makeBrief: (layout: RootLayout) => B,
  options: SealOptions = {},
): PreparedRoot<B> {
  const built = buildRoot(rootDir, inputs);
  const brief = makeBrief(layoutOf(built));
  writeFileSync(join(built.root, ROOT_NAMES.brief), brief.text, { flag: 'wx' });
  const sealed = sealRoot(built, [...brief.promises, ROOT_NAMES.brief], options);
  return { built, brief, sealed };
}
