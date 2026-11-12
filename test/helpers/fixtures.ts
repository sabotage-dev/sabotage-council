import { cpSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { removeDir, tempDir } from './git-fixture.js';

const scratchDirs: string[] = [];

/** A temp dir that is removed after the test file (see `cleanScratchAfterAll`). */
export function scratch(prefix: string): string {
  const dir = tempDir(prefix);
  scratchDirs.push(dir);
  return dir;
}

/** Registers the removal of every scratch dir once the calling test file is done. */
export function cleanScratchAfterAll(): void {
  afterAll(() => {
    for (const dir of scratchDirs.splice(0)) removeDir(dir);
  });
}

/** Placeholders the sanitized fixtures carry instead of machine paths and session ids. */
export const ROOT_PLACEHOLDER = '__SC_ROOT__';
export const SESSION_PLACEHOLDER = '__SC_SESSION__';

export type FixtureKind = 'codex' | 'claude' | 'antigravity' | 'kiro';

/** ACP fixtures also carry the canary's outside dir, the temp parent of both, and the leg dir. */
export const OUTSIDE_PLACEHOLDER = '__SC_OUTSIDE__';
export const TMP_PLACEHOLDER = '__SC_TMP__';
export const LEG_PLACEHOLDER = '__SC_LEG__';

export function fixtureDir(kind: FixtureKind, name: string): string {
  return new URL(`../fixtures/${kind}/${name}`, import.meta.url).pathname;
}

export function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else out.push(path);
  }
  return out;
}

export interface Materialized {
  /** The copy of the fixture, with placeholders replaced. */
  dir: string;
  /** An empty directory standing in for the sealed root (a realpath). */
  root: string;
}

/** Copies a fixture to a temp dir and replaces its placeholders with a real root (and session id). */
export function materialize(kind: FixtureKind, name: string, replacements: Record<string, string> = {}): Materialized {
  const tmp = realpathSync(scratch(`sc-${kind}-${name}-`));
  const root = join(tmp, 'root');
  mkdirSync(root);
  const outside = join(tmp, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside the root\n');
  const dir = join(tmp, 'fixture');
  cpSync(fixtureDir(kind, name), dir, { recursive: true });
  const all: Record<string, string> = { [ROOT_PLACEHOLDER]: root, [OUTSIDE_PLACEHOLDER]: outside, [TMP_PLACEHOLDER]: tmp, [LEG_PLACEHOLDER]: dir, ...replacements };
  for (const file of listFiles(dir)) {
    let text = readFileSync(file, 'utf8');
    for (const [from, to] of Object.entries(all)) text = text.split(from).join(to);
    writeFileSync(file, text);
  }
  return { dir, root };
}

export function readJsonl(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
