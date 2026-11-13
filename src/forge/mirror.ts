import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { commitExists, FULL_SHA, initBare, runGit, type ShadowRepo } from '../root/git.js';
import { decodeName, splitNul } from '../root/names.js';
import { ForgeError } from './github.js';
import { PR_FILES_MAX, type PrFile, type PrRef } from './pr.js';

/*
 * The bare mirror a PR root is built from (plan 5.3): one per repository, owned by the engine, under the run store's
 * data dir (`<data dir>/mirrors/github.com/<owner>/<repo>.git`). It holds objects and the engine's own refs only: no
 * work tree, no hooks (the engine's git isolation sets `core.hooksPath=/dev/null` on every call), and every fetch
 * names the exact refs it wants. Root builds read it through an alternates-only shadow like any local repository.
 *
 * Fetches allow exactly one protocol: https for a GitHub URL, or `file` for a local path the caller named (the
 * tests' stand-in remote). The URL never comes from PR data. A private repository authenticates through
 * `gh auth git-credential` as git's only credential helper. The engine never reads, stores or logs a GitHub token,
 * and never writes one to a root; but a setup that authenticates `gh` only by `GH_TOKEN` (or `GITHUB_TOKEN`) needs
 * that variable in the helper's environment, since `gh auth git-credential` reads it from there. So the token
 * reaches git's environment for the fetch, as it reaches `gh`'s for the API calls (P6 round 1 row 7).
 */

export interface MirrorSource {
  /** Where to fetch from: `https://github.com/<owner>/<repo>.git`, or (tests) a local repository path. */
  url: string;
  /** The `gh` binary for the credential helper on https. Default `gh`. */
  ghBin?: string | undefined;
  /** Environment for the credential helper (gh reads the user's login from it). */
  env?: NodeJS.ProcessEnv | undefined;
}

export const githubUrl = (ref: Pick<PrRef, 'owner' | 'repo'>): string => `https://github.com/${ref.owner}/${ref.repo}.git`;

/**
 * The default source of a PR's mirror: the GitHub https URL, with `gh` as the credential helper running with the
 * same environment (and the same `gh`) as the API calls, so a `GH_TOKEN`-only setup that can read the PR can also
 * fetch it (row 7).
 */
export function defaultMirrorSource(ref: Pick<PrRef, 'owner' | 'repo'>, env: NodeJS.ProcessEnv, ghBin?: string): MirrorSource {
  return { url: githubUrl(ref), env, ghBin };
}

export function mirrorPath(mirrorsDir: string, ref: Pick<PrRef, 'owner' | 'repo'>): string {
  for (const s of [ref.owner, ref.repo]) {
    if (!/^[A-Za-z0-9_.-]+$/.test(s) || s === '.' || s === '..') throw new ForgeError(`unsafe repository name part "${s}"`);
  }
  return join(mirrorsDir, 'github.com', ref.owner.toLowerCase(), `${ref.repo.toLowerCase()}.git`);
}

/** Creates the bare mirror on first use. */
export function ensureMirror(gitDir: string): ShadowRepo {
  if (!existsSync(join(gitDir, 'HEAD'))) {
    mkdirSync(dirname(gitDir), { recursive: true, mode: 0o700 });
    initBare(gitDir);
  }
  return { gitDir, source: gitDir };
}

/**
 * Variables the credential helper (`gh auth git-credential`) may read: its token and config, and the proxy and CA
 * settings of its https call. Nothing else of the user's environment reaches a fetch. The values are passed through
 * to the helper only: never logged, stored, or written anywhere.
 */
const HELPER_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE'];

/** The git config and environment of one fetch from a source (exported for the credential-helper test). */
export function fetchConfig(source: MirrorSource): { args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {};
  if (source.url.startsWith('https://')) {
    for (const k of HELPER_ENV) if (source.env?.[k] !== undefined) env[k] = source.env[k];
    const gh = source.ghBin ?? 'gh';
    if (/["\\\n]/.test(gh)) throw new ForgeError('the gh path holds a character the credential helper cannot quote');
    // The first, empty, helper clears any other; git runs the second through the shell with `get` appended.
    return { args: ['-c', 'protocol.https.allow=always', '-c', 'credential.helper=', '-c', `credential.helper=!"${gh}" auth git-credential`], env };
  }
  if (isAbsolute(source.url)) return { args: ['-c', 'protocol.file.allow=always'], env };
  throw new ForgeError(`a mirror fetches from https://github.com/... or a local path, not "${source.url}"`);
}

/** One fetch of exact refspecs into the mirror; false (with git's reason) when the remote refused it. */
export function fetchInto(mirror: ShadowRepo, source: MirrorSource, refspecs: readonly string[]): { ok: boolean; error: string } {
  const { args, env } = fetchConfig(source);
  const r = runGit([...args, 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', source.url, ...refspecs], {
    gitDir: mirror.gitDir,
    env,
    okStatuses: [0, 1, 128],
  });
  return { ok: r.status === 0, error: r.stderr.trim().split('\n').slice(-1)[0] ?? '' };
}

export const pullRefs = (num: number): { head: string; base: string } => ({ head: `refs/sabotage-council/pull/${num}/head`, base: `refs/sabotage-council/pull/${num}/base` });

/**
 * Brings the PR's head and base into the mirror: `refs/pull/<n>/head` and the base branch, then the exact head and
 * base commits when the refs moved past them. Throws when either commit is still missing: a root is never built from
 * a guess.
 */
export function fetchPr(mirror: ShadowRepo, source: MirrorSource, ref: PrRef, baseRef: string, head: string, base: string): void {
  if (!FULL_SHA.test(head) || !FULL_SHA.test(base)) throw new ForgeError('head and base must be full shas');
  if (baseRef.startsWith('-') || /[\s\0-\x1f\x7f~^:?*[\\]|\.\.|@\{/.test(baseRef)) throw new ForgeError(`unsafe base branch name "${baseRef}"`);
  const refs = pullRefs(ref.number);
  // One fetch per ref: git fails a whole fetch when any one refspec names a ref the remote lacks.
  const fetched = [fetchInto(mirror, source, [`+refs/pull/${ref.number}/head:${refs.head}`]), fetchInto(mirror, source, [`+refs/heads/${baseRef}:${refs.base}`])];
  for (const [sha, what] of [
    [head, 'head'],
    [base, 'base'],
  ] as const) {
    if (commitExists(mirror, sha)) continue;
    fetchExact(mirror, source, sha, `refs/sabotage-council/pull/${ref.number}/${what}-${sha}`);
    if (!commitExists(mirror, sha)) {
      const why = fetched.filter((f) => !f.ok).map((f) => f.error).join('; ');
      throw new ForgeError(`the ${what} ${sha.slice(0, 7)} of ${ref.owner}/${ref.repo}#${ref.number} could not be fetched${why === '' ? '' : ` (${why})`}`);
    }
  }
}

/** An exact fetch of one commit (plan 3.6: a missing baseline is fetched before it is called unavailable). */
export function fetchExact(mirror: ShadowRepo, source: MirrorSource, sha: string, into: string): boolean {
  if (!FULL_SHA.test(sha)) throw new ForgeError(`not a full sha: ${sha}`);
  if (commitExists(mirror, sha)) return true;
  fetchInto(mirror, source, [`+${sha}:${into}`]);
  return commitExists(mirror, sha);
}

/** The tree of a commit in the mirror, or null when the commit is not there. */
export function treeOf(mirror: ShadowRepo, sha: string): string | null {
  const r = runGit(['rev-parse', '--verify', '--quiet', `${sha}^{tree}`], { gitDir: mirror.gitDir, okStatuses: [0, 1, 128] });
  const out = r.stdout.toString('utf8').trim();
  return r.status === 0 && FULL_SHA.test(out) ? out : null;
}

/**
 * Cross-checks GitHub's changed-file list against the fetched base and head (P6): the files that differ between the
 * merge-base and the head, renames as a deletion and an addition, must be exactly the paths GitHub lists (with each
 * rename's previous path). A difference means the root would not hold the change GitHub shows, so the round stops.
 * GitHub lists at most 3,000 files; a longer list cannot be checked, and says so.
 */
export function checkPrFiles(mirror: ShadowRepo, base: string, head: string, files: readonly PrFile[]): { checked: boolean; note: string } {
  if (files.length >= PR_FILES_MAX) return { checked: false, note: `GitHub lists ${files.length} files, its limit: the list was not cross-checked` };
  const mb = runGit(['merge-base', base, head], { gitDir: mirror.gitDir, okStatuses: [0, 1] });
  const mergeBase = mb.stdout.toString('utf8').trim();
  if (mb.status !== 0 || !FULL_SHA.test(mergeBase)) throw new ForgeError(`base ${base.slice(0, 7)} and head ${head.slice(0, 7)} have no merge-base`);
  const out = runGit(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', mergeBase, head], { gitDir: mirror.gitDir });
  const local = new Set(splitNul(out.stdout).map((raw) => decodeName(raw, 'the changed files')));
  const listed = new Set(files.flatMap((f) => (f.previous === null ? [f.path] : [f.path, f.previous])));
  const onlyLocal = [...local].filter((p) => !listed.has(p));
  const onlyListed = [...listed].filter((p) => !local.has(p));
  if (onlyLocal.length > 0 || onlyListed.length > 0) {
    const show = (xs: string[]): string => xs.slice(0, 5).map((x) => JSON.stringify(x)).join(', ') + (xs.length > 5 ? ` and ${xs.length - 5} more` : '');
    throw new ForgeError(
      `GitHub's changed files differ from the fetched base and head${onlyListed.length > 0 ? `: GitHub lists ${show(onlyListed)}` : ''}${onlyLocal.length > 0 ? `; the fetched commits also change ${show(onlyLocal)}` : ''}`,
    );
  }
  return { checked: true, note: `${local.size} changed file(s), as GitHub lists them` };
}
