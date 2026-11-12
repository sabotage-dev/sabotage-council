import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './git-fixture.js';

/** Placeholders the sanitized fixtures carry instead of machine paths and session ids. */
export const ROOT_PLACEHOLDER = '__SC_ROOT__';
export const SESSION_PLACEHOLDER = '__SC_SESSION__';

export function fixtureDir(kind: 'codex' | 'claude', name: string): string {
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
export function materialize(kind: 'codex' | 'claude', name: string, replacements: Record<string, string> = {}): Materialized {
  const tmp = tempDir(`sc-${kind}-${name}-`);
  const root = join(tmp, 'root');
  mkdirSync(root);
  const dir = join(tmp, 'fixture');
  cpSync(fixtureDir(kind, name), dir, { recursive: true });
  const all: Record<string, string> = { [ROOT_PLACEHOLDER]: root, ...replacements };
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
