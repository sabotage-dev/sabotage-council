import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sqlite } from '../../src/store/sqlite.js';
import type { LegHandle, RoundCtx } from '../../src/adapters/types.js';
import { fixtureDir, materialize, scratch, type FixtureKind } from './fixtures.js';

/*
 * Helpers for the ACP adapter tests: the recorded fixtures replayed into a leg handle, the antigravity
 * conversation DB rebuilt from its sanitized rows, and the fake ACP agent's case files.
 */

export const FAKE_ACP = new URL('../fixtures/bin/fake-acp-agent.mjs', import.meta.url).pathname;

export interface AcpCase {
  nonce: string;
  model: string;
  effort: string | null;
  label?: string;
  slug?: string;
  cliVersion: string;
  rootMutated: boolean;
  plantSymlink: boolean;
  expect: { status: string; failureClass: string | null; failed: string[] };
  note: string;
}

export interface GenRow {
  label: string | null;
  slug: string | null;
  tools: string[] | null;
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function lenField(field: number, body: Uint8Array): number[] {
  return [...varint((field << 3) | 2), ...varint(body.length), ...body];
}

const text = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

/** One `gen_metadata.data` row in the measured layout: 1.21 label, 3.28 slug, 3.46.3 tools (name in field 1). */
export function encodeGenRow(row: GenRow): Uint8Array {
  const one: number[] = row.label !== null ? lenField(21, text(row.label)) : [];
  const three: number[] = [];
  if (row.slug !== null) three.push(...lenField(28, text(row.slug)));
  if (row.tools !== null) {
    const list: number[] = [];
    for (const name of row.tools) list.push(...lenField(3, new Uint8Array(lenField(1, text(name)))));
    three.push(...lenField(46, new Uint8Array(list)));
  }
  const out: number[] = [...varint((2 << 3) | 0), 1];
  if (one.length > 0) out.push(...lenField(1, new Uint8Array(one)));
  if (three.length > 0) out.push(...lenField(3, new Uint8Array(three)));
  return new Uint8Array(out);
}

/** Writes a conversation DB with a `gen_metadata` table holding the rows. */
export function writeGenDb(path: string, rows: readonly GenRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const db = new (sqlite().DatabaseSync)(path);
  try {
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');
    const insert = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
    rows.forEach((row, i) => {
      const data = encodeGenRow(row);
      insert.run(i, data, data.length);
    });
  } finally {
    db.close();
  }
}

export function caseOf(kind: FixtureKind, name: string): AcpCase {
  return JSON.parse(readFileSync(join(fixtureDir(kind, name), 'case.json'), 'utf8')) as AcpCase;
}

/** The session id the recorded leg used (from its session/new response). */
export function recordedSession(dir: string): string {
  for (const line of readFileSync(join(dir, 'updates.jsonl'), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const e = JSON.parse(line) as { dir?: string; msg?: { result?: { sessionId?: string } } };
    if (e.dir === 'recv' && typeof e.msg?.result?.sessionId === 'string') return e.msg.result.sessionId;
  }
  throw new Error('no session in the fixture');
}

/**
 * A recorded leg as a handle the adapter can ratify: the fixture copied with real paths, the canary's symlink
 * planted again, and (antigravity) the conversation DB rebuilt from its rows.
 */
export function replayHandle(kind: 'antigravity' | 'kiro', name: string, edit?: (dir: string, root: string) => void): { handle: LegHandle; ctx: RoundCtx; c: AcpCase; dir: string; root: string } {
  const c = caseOf(kind, name);
  const { dir, root } = materialize(kind, name);
  if (c.plantSymlink) symlinkSync(join(dirname(root), 'outside', 'secret.txt'), join(root, 'link-out.txt'));
  const session = recordedSession(dir);
  if (kind === 'antigravity') {
    const gen = JSON.parse(readFileSync(join(dir, 'gen.json'), 'utf8')) as { rows: GenRow[] };
    writeGenDb(join(dir, 'gemini', 'antigravity-cli', 'conversations', `${session}.db`), gen.rows);
  }
  edit?.(dir, root);
  const exit = (JSON.parse(readFileSync(join(dir, 'process.json'), 'utf8')) as { exit: LegHandle['exit'] }).exit;
  const expect =
    kind === 'kiro'
      ? [
          { id: 'mode', value: 'sabotage-council', check: 'mode' },
          { id: 'model', value: c.model, check: 'model' },
        ]
      : [
          { id: 'model', value: c.model, check: 'model' },
          ...(c.effort !== null ? [{ id: 'thought_level', value: c.effort, check: 'effort' }] : []),
          { id: 'mode', value: 'default', check: 'mode' },
        ];
  const handle: LegHandle = {
    backend: kind,
    occupant: { backend: kind, model: c.model, effort: c.effort ?? undefined },
    legDir: dir,
    root,
    nonce: c.nonce,
    startedAt: new Date(),
    process: null,
    exit,
    files: { log: join(dir, 'updates.jsonl'), stderr: join(dir, 'stderr.log'), process: join(dir, 'process.json'), agyLog: join(dir, 'agy.log') },
    data: { expect, cliVersion: c.cliVersion, label: c.label ?? null, slug: c.slug ?? null },
  };
  const ctx: RoundCtx = {
    root,
    legDir: dir,
    nonce: c.nonce,
    briefFile: '/dev/null',
    timeoutMs: 1000,
    rootUnchanged: () => ({ unchanged: !c.rootMutated, changes: c.rootMutated ? ['modified planted/calc/rangesum.py'] : [] }),
  };
  return { handle, ctx, c, dir, root };
}

/** A temp HOME holding the fake agent's case file. */
export function fakeHome(kase: Record<string, unknown>, prefix = 'sc-fake-acp-'): string {
  const home = scratch(prefix);
  writeFileSync(join(home, 'fake-acp.json'), JSON.stringify(kase));
  return home;
}
