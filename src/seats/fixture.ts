import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { LegFinding } from '../parse/findings.js';
import { gitText, runGit } from '../root/git.js';

/*
 * The planted-defect fixture `seats test` runs on (plan 8.4). It ships in the package (`fixtures/planted/`, the same
 * relative path from `src/seats/` and `dist/seats/`), never read from the repository's tests.
 */

export const DEFAULT_FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/planted/', import.meta.url));

const defectSchema = z.strictObject({
  id: z.string().regex(/^D[1-9][0-9]*$/),
  severity: z.enum(['HIGH', 'MEDIUM', 'LOW', 'NIT']),
  title: z.string().min(1),
  path: z.string().min(1),
  lines: z.tuple([z.int().min(1), z.int().min(1)]),
  keywords: z.array(z.string().min(1)),
});

const fixtureSchema = z.strictObject({
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  branch: z.string().min(1),
  commits: z.strictObject({ base: z.string().min(1), head: z.string().min(1) }),
  defects: z.array(defectSchema).min(1),
});

export type PlantedDefect = z.output<typeof defectSchema>;

export interface PlantedFixture {
  dir: string;
  repo: string;
  branch: string;
  commits: { base: string; head: string };
  defects: PlantedDefect[];
  /** Repository-relative path -> content, at the base and at the head. */
  base: Map<string, string>;
  head: Map<string, string>;
}

function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p).split('\\').join('/'), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

export function loadFixture(dir: string = DEFAULT_FIXTURE_DIR): PlantedFixture {
  const meta = fixtureSchema.parse(JSON.parse(readFileSync(join(dir, 'defects.json'), 'utf8')));
  return { dir, ...meta, base: readTree(join(dir, 'base')), head: readTree(join(dir, 'head')) };
}

const IDENTITY = ['-c', 'user.name=sabotage-council', '-c', 'user.email=sabotage-council@localhost'];
const DATES = { GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };

function writeTree(repo: string, tree: Map<string, string>): void {
  for (const [path, content] of tree) {
    const abs = join(repo, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/**
 * Builds the fixture's git repository in `repoDir` (which must not exist): the base commit on `main`, then the head on
 * the fixture's branch. Identity and dates are fixed, so the shas are the same on every machine.
 */
export function buildPlantedRepo(fixture: PlantedFixture, repoDir: string): { repo: string; base: string; head: string } {
  mkdirSync(repoDir, { recursive: false, mode: 0o700 });
  runGit(['init', '--quiet', '--template=', '-b', 'main', repoDir]);
  const commit = (message: string): string => {
    runGit(['add', '--all', '--force'], { cwd: repoDir });
    runGit([...IDENTITY, 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', message], { cwd: repoDir, env: DATES });
    return gitText(['rev-parse', 'HEAD'], { cwd: repoDir });
  };
  writeTree(repoDir, fixture.base);
  const base = commit(fixture.commits.base);
  runGit(['checkout', '--quiet', '-b', fixture.branch], { cwd: repoDir });
  for (const path of fixture.base.keys()) if (!fixture.head.has(path)) runGit(['rm', '--quiet', '--', path], { cwd: repoDir });
  writeTree(repoDir, fixture.head);
  const head = commit(fixture.commits.head);
  return { repo: repoDir, base, head };
}

export interface DefectMatch {
  defect: string;
  /** The leg's finding id (F1), or `answer` when the findings block did not parse and the answer text was read. */
  finding: string;
  by: 'line' | 'keyword' | 'answer-text';
}

/**
 * A finding's path relative to the repository: a leading `./` and the root's `<repo>/` prefix dropped, nothing else. The
 * result must equal a defect's head path exactly: `_base/calc/rangesum.py` (the correct base copy) or any other prefix
 * never names the defect.
 */
function repoPath(path: string, repo: string): string {
  let p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p.startsWith(`${repo}/`)) p = p.slice(repo.length + 1);
  return p;
}

/** How many of the defect's keywords the title holds (each counted once, case-insensitively). */
function keywordHits(d: PlantedDefect, title: string): number {
  const t = title.toLowerCase();
  return d.keywords.filter((k) => t.includes(k.toLowerCase())).length;
}

/**
 * Which planted defects a leg's findings name. A finding counts for one defect at most: the defect on its file (the
 * head path exactly) whose line range holds its line; else the defect on its file whose keywords its title holds most
 * of, never the first in file order (a tie is no match).
 */
export function matchDefects(fixture: PlantedFixture, findings: readonly LegFinding[]): { matches: DefectMatch[]; other: string[] } {
  const matches: DefectMatch[] = [];
  const other: string[] = [];
  for (const f of findings) {
    const path = f.path === null ? null : repoPath(f.path, fixture.repo);
    const onFile = fixture.defects.filter((d) => path === d.path);
    const byLine = f.line === null ? undefined : onFile.find((d) => (f.line as number) >= d.lines[0] && (f.line as number) <= d.lines[1]);
    let byKeyword: PlantedDefect | undefined;
    if (!byLine) {
      const scored = onFile.map((d) => ({ d, hits: keywordHits(d, f.title) })).filter((x) => x.hits > 0);
      const best = Math.max(0, ...scored.map((x) => x.hits));
      const top = scored.filter((x) => x.hits === best);
      if (top.length === 1) byKeyword = top[0]?.d;
    }
    const d = byLine ?? byKeyword;
    if (d) matches.push({ defect: d.id, finding: f.id, by: byLine ? 'line' : 'keyword' });
    else other.push(f.id);
  }
  return { matches, other };
}

/**
 * When the leg's findings block did not parse, the answer text is read instead: a defect counts when the text cites its
 * file at a line in its range (`calc/rangesum.py:11`, `planted/calc/rangesum.py:11`), by the same path rule: a citation
 * inside a longer path (`_base/calc/rangesum.py:11`) does not count.
 */
export function matchDefectsInText(fixture: PlantedFixture, text: string): DefectMatch[] {
  const out: DefectMatch[] = [];
  const quote = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const d of fixture.defects) {
    const cite = new RegExp(`(?<![\\w./\\\\-])(?:\\./)?(?:${quote(fixture.repo)}/)?${quote(d.path)}:(\\d+)`, 'g');
    for (const m of text.matchAll(cite)) {
      const line = Number(m[1]);
      if (line >= d.lines[0] && line <= d.lines[1]) {
        out.push({ defect: d.id, finding: 'answer', by: 'answer-text' });
        break;
      }
    }
  }
  return out;
}
