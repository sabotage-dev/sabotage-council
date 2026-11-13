import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratch } from './fixtures.js';
import { commitAll, git, initRepo, writeTree } from './git-fixture.js';

/*
 * The fake GitHub for pr-mode tests: a synthetic repository standing in for sabotage-dev/sabotage-council (a base
 * commit on main and the seven commits of PR #2, `refs/pull/2/head` pointing at the last), the recorded and sanitized
 * PR #2 JSON with its sha placeholders filled from that repository, and the stub `gh` (fixtures/bin/fake-gh.mjs)
 * that answers from those routes and logs every request.
 */

export const FAKE_GH = new URL('../fixtures/bin/fake-gh.mjs', import.meta.url).pathname;
export const PR2_FIXTURE = new URL('../fixtures/github/pr-2/', import.meta.url).pathname;
export const OWNER = 'sabotage-dev';
export const REPO = 'sabotage-council';
export const PR = 2;
export const API = `repos/${OWNER}/${REPO}`;

export type Shas = Record<string, string>;

export interface SourceRepo {
  repo: string;
  shas: Shas;
}

/**
 * The files each of PR #2's seven commits touched, as recorded (the base held LICENSE, README.md and docs/PLAN.md), so
 * the synthetic history's diff from the base is exactly the 30 files GitHub lists for the PR (files.json).
 */
export const PR2_COMMIT_FILES: readonly string[][] = [
  ['.github/workflows/ci.yml', '.gitignore', 'eslint.config.js', 'package-lock.json', 'package.json', 'src/config/index.ts', 'src/config/load.ts', 'src/config/registry.ts', 'src/config/rules.ts', 'src/config/schema.ts', 'src/config/validate.ts', 'src/config/vocab.ts', 'src/paths.ts', 'src/version.ts', 'test/config.test.ts', 'test/fake-registry.ts', 'test/fixtures/config/plan-example.toml', 'test/tsconfig.json', 'tsconfig.json'],
  ['migrations/001_initial.sql', 'src/store/index.ts', 'src/store/migrate.ts', 'src/store/open.ts', 'src/store/sqlite.ts', 'test/store.test.ts'],
  ['README.md', 'src/cli/doctor.ts', 'src/cli/index.ts', 'src/cli/program.ts', 'test/doctor.test.ts'],
  ['test/store.test.ts'],
  ['.github/workflows/ci.yml', 'src/config/rules.ts', 'test/config.test.ts', 'test/store.test.ts'],
  ['src/config/rules.ts', 'src/config/schema.ts', 'src/config/validate.ts', 'src/config/vocab.ts', 'test/config.test.ts'],
  ['src/config/rules.ts', 'src/config/validate.ts', 'test/config.test.ts'],
];

/** The stand-in remote: `main` at BASE, seven commits C1..C7 on the PR branch, `refs/pull/2/head` at C7. */
export function sourceRepo(): SourceRepo {
  const repo = initRepo(join(scratch('sc-gh-source-'), REPO));
  writeTree(repo, { LICENSE: 'MIT\n', 'README.md': '# sabotage-council\n', 'docs/PLAN.md': '# Plan\n' });
  const shas: Shas = { BASE: commitAll(repo, 'base') };
  git(repo, ['checkout', '--quiet', '-b', 'build/p0-scaffold']);
  PR2_COMMIT_FILES.forEach((files, i) => {
    writeTree(repo, Object.fromEntries(files.map((f) => [f, `${f} as of commit ${i + 1}\n`])));
    shas[`C${i + 1}`] = commitAll(repo, `commit ${i + 1}`);
  });
  git(repo, ['update-ref', `refs/pull/${PR}/head`, shas['C7']!]);
  git(repo, ['checkout', '--quiet', 'main']);
  return { repo, shas };
}

/** Adds a commit on the PR branch and moves `refs/pull/2/head` to it. */
export function pushCommit(src: SourceRepo, name: string, files: Record<string, string>, parent?: string): string {
  git(src.repo, ['checkout', '--quiet', '--detach', parent ?? src.shas['C7']!]);
  writeTree(src.repo, files);
  const sha = commitAll(src.repo, name);
  src.shas[name] = sha;
  git(src.repo, ['update-ref', `refs/pull/${PR}/head`, sha]);
  git(src.repo, ['checkout', '--quiet', 'main']);
  return sha;
}

/** GitHub's changed-file list for a head of the synthetic history: the files that differ from the base. */
export function filesFor(src: SourceRepo, head: string): Array<{ filename: string; status: string }> {
  const out = git(src.repo, ['diff', '--name-status', '--no-renames', src.shas['BASE']!, head]);
  return out
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const [status, filename] = l.split('\t');
      return { filename: filename!, status: status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified' };
    });
}

/** Fills `__C7__` (a full sha) and `__C7_7__` (its first 7) placeholders. */
export function fill(text: string, shas: Shas): string {
  let out = text;
  for (const [k, v] of Object.entries(shas)) out = out.split(`__${k}_7__`).join(v.slice(0, 7)).split(`__${k}__`).join(v);
  return out;
}

export function recorded(name: string, shas: Shas): unknown {
  return JSON.parse(fill(readFileSync(join(PR2_FIXTURE, name), 'utf8'), shas)) as unknown;
}

export type Route = { json: unknown } | { fail: string } | { echoReview: { id: number; login: string } } | { seq: Route[] };
export type Routes = Record<string, Route>;

/** The routes `round start pr` and `post` read for PR #2, from the recorded JSON. */
export function pr2Routes(shas: Shas): Routes {
  const pulls = `${API}/pulls/${PR}`;
  return {
    'GET user': { json: { login: 'repo-owner' } },
    [`GET ${pulls}`]: { json: recorded('pull.json', shas) },
    [`GET ${pulls}/reviews`]: { json: recorded('reviews.json', shas) },
    [`GET ${pulls}/comments`]: { json: recorded('review-comments.json', shas) },
    [`GET ${API}/issues/${PR}/comments`]: { json: recorded('issue-comments.json', shas) },
    [`GET ${pulls}/commits`]: { json: recorded('commits.json', shas) },
    [`GET ${pulls}/files`]: { json: recorded('files.json', shas) },
    [`GET ${API}/collaborators/repo-owner/permission`]: { json: recorded('permission.json', shas) },
    graphql: { json: recorded('ci.json', shas) },
    [`GET ${API}/branches/main`]: { json: recorded('branch.json', shas) },
    [`GET ${API}/rules/branches/main`]: { json: recorded('rules.json', shas) },
    'GET search/issues': { json: { total_count: 0, items: [] } },
    [`POST ${pulls}/reviews`]: { echoReview: { id: 990001, login: 'repo-owner' } },
  };
}

export interface FakeGh {
  dir: string;
  env: NodeJS.ProcessEnv;
  setRoutes: (routes: Routes) => void;
  requests: () => Array<{ method: string; path: string; key: string; fields: Record<string, string>; body: unknown }>;
}

/** A stub gh's state dir with its routes; `env` points the stub at it. */
export function fakeGh(routes: Routes): FakeGh {
  const dir = scratch('sc-fake-gh-');
  const setRoutes = (r: Routes): void => {
    writeFileSync(join(dir, 'routes.json'), JSON.stringify(r));
    if (existsSync(join(dir, 'state.json'))) writeFileSync(join(dir, 'state.json'), '{}');
  };
  setRoutes(routes);
  return {
    dir,
    env: { PATH: process.env['PATH'], FAKE_GH_DIR: dir },
    setRoutes,
    requests: () =>
      existsSync(join(dir, 'requests.jsonl'))
        ? readFileSync(join(dir, 'requests.jsonl'), 'utf8')
            .split('\n')
            .filter((l) => l !== '')
            .map((l) => JSON.parse(l) as { method: string; path: string; key: string; fields: Record<string, string>; body: unknown })
        : [],
  };
}

/** A review object as GitHub returns it (the fields the engine reads). */
export function ghReview(id: number, login: string, state: string, commit: string, at: string, body: string): Record<string, unknown> {
  return { id, user: { login }, state, commit_id: commit, submitted_at: at, body };
}

/** Clears a fake gh's request log (between the start and the post of one test). */
export function clearRequests(gh: FakeGh): void {
  if (existsSync(join(gh.dir, 'requests.jsonl'))) writeFileSync(join(gh.dir, 'requests.jsonl'), '');
  appendFileSync(join(gh.dir, 'requests.jsonl'), '');
}

/** Every file under a dir (mirrors, for assertions). */
export function listDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}
