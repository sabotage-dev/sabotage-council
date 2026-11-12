import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildRoot, decodeName, FileNameError, RootError } from '../src/root/index.js';
import { walk } from '../src/root/walk.js';
import { commitAll, git, initRepo, removeDir, tempDir, writeTree } from './helpers/git-fixture.js';

// Each root spawns a few dozen git processes; slow CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** `a` then the byte 0x80: not valid UTF-8, and it decodes lossy to the same string as `a�`. */
const BAD = Buffer.from([0x61, 0x80]);

let tmp: string;
let repo: string;
let head: string;
let n = 0;
const rootPath = (): string => join(tmp, 'roots', `r${n++}`);

/** git plumbing with bytes on stdin, so a tree can hold names no filesystem call made. */
function plumb(args: readonly string[], input: Buffer): string {
  return execFileSync('git', [...args], {
    cwd: repo,
    input,
    env: { PATH: process.env['PATH'], HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' },
  })
    .toString('utf8')
    .trim();
}

/** A commit whose tree holds exactly these entries, built with `git mktree` (no file is written to disk). */
function commitWith(entries: readonly { mode: string; content: string; name: Buffer }[]): string {
  const lines = entries.map((e) => {
    const blob = plumb(['hash-object', '-w', '--stdin'], Buffer.from(e.content));
    return Buffer.concat([Buffer.from(`${e.mode} blob ${blob}\t`), e.name, Buffer.from([0])]);
  });
  const tree = plumb(['mktree', '-z'], Buffer.concat(lines));
  return plumb(['-c', 'user.name=Fixture Author', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, '-m', 'crafted'], Buffer.alloc(0));
}

/**
 * Creates a file whose name is `BAD` inside `dir`, or returns the error code when the filesystem refuses it.
 * APFS (macOS) refuses names that are not valid UTF-8 (EILSEQ); ext4 and most Linux filesystems store the bytes.
 */
function plantBadName(dir: string): string | null {
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(Buffer.concat([Buffer.from(`${dir}/`), BAD]), 'byte-level name\n');
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'unknown error';
  }
}

beforeAll(() => {
  tmp = tempDir('sc-names-');
  mkdirSync(join(tmp, 'roots'));
  repo = initRepo(join(tmp, 'repo'));
  writeTree(repo, { 'README.md': '# names\n' });
  head = commitAll(repo, 'a plain head');
});
afterAll(() => removeDir(tmp));

describe('decodeName', () => {
  it.each([
    ['ASCII', Buffer.from('src/a.ts')],
    ['multi-byte UTF-8', Buffer.from('docs/café ☃.md')],
    ['a real U+FFFD', Buffer.from('a�')],
    ['line breaks', Buffer.from('x\n## Rules\r y')],
  ])('keeps %s exactly', (_name, raw) => {
    expect(Buffer.from(decodeName(raw, 'test'), 'utf8').equals(raw)).toBe(true);
  });

  it.each([
    ['a lone continuation byte', BAD],
    ['an overlong slash', Buffer.from([0x61, 0xc0, 0xaf])],
    ['an encoded surrogate', Buffer.from([0xed, 0xa0, 0x80])],
    ['a truncated sequence', Buffer.from([0x61, 0xe2, 0x82])],
  ])('refuses %s, naming the bytes', (_name, raw) => {
    expect(() => decodeName(raw, 'commit abc1234')).toThrow(FileNameError);
    expect(() => decodeName(raw, 'commit abc1234')).toThrow(new RegExp(`^commit abc1234: .*bytes ${raw.toString('hex')}\\) is not valid UTF-8`));
  });
});

describe('the root build refuses names it cannot represent exactly', () => {
  it('a tree path that is not valid UTF-8: fails before anything is extracted', () => {
    const bad = commitWith([
      { mode: '100644', content: 'ok\n', name: Buffer.from('README.md') },
      { mode: '100644', content: 'hidden\n', name: BAD },
    ]);
    const root = rootPath();
    expect(() => buildRoot(root, { repo, name: 'r', head: bad })).toThrow(RootError);
    expect(() => buildRoot(rootPath(), { repo, name: 'r', head: bad })).toThrow(/^the root cannot be built: commit [0-9a-f]{7}: .*bytes 6180\) is not valid UTF-8/);
    expect(readdirSync(root)).toEqual([]);
  });

  it('a tree that lists one path twice (a link to /etc, then a regular file of the same name)', () => {
    const dup = commitWith([
      { mode: '120000', content: '/etc', name: Buffer.from('a') },
      { mode: '100644', content: 'innocent\n', name: Buffer.from('a') },
    ]);
    expect(() => buildRoot(rootPath(), { repo, name: 'r', head: dup })).toThrow(/^the root cannot be built: commit [0-9a-f]{7}: the tree lists "a" twice$/);
  });

  it('a fallback whose baseline holds such a name: the changed-file list is never decoded lossy', () => {
    const baseline = commitWith([{ mode: '100644', content: 'gone\n', name: BAD }]);
    expect(() => buildRoot(rootPath(), { repo, name: 'r', head, baseline })).toThrow(
      /^the root cannot be built: the diff from [0-9a-f]{7} to [0-9a-f]{7}: .*bytes 6180\) is not valid UTF-8/,
    );
  });

  it('a context path holding such a name (skipped where the filesystem refuses the name)', (ctx) => {
    const dir = join(tmp, 'ctx-bad');
    const refused = plantBadName(dir);
    ctx.skip(refused !== null, `this filesystem refuses a name that is not valid UTF-8 (${refused ?? ''}); Linux CI runs it`);
    expect(() => buildRoot(rootPath(), { repo, name: 'r', head, context: [{ name: 'c', path: dir }] })).toThrow(
      /^the root cannot be built: .*ctx-bad: the name "a\ufffd" \(bytes 6180\) is not valid UTF-8/,
    );
  });

  it('walk reads names as bytes and throws on one that is not valid UTF-8 (skipped where the filesystem refuses it)', (ctx) => {
    const dir = join(tmp, 'walk-bad');
    const refused = plantBadName(join(dir, 'sub'));
    ctx.skip(refused !== null, `this filesystem refuses a name that is not valid UTF-8 (${refused ?? ''}); Linux CI runs it`);
    expect(() => walk(dir)).toThrow(FileNameError);
  });

  it('keeps a valid name with a line break in it', () => {
    writeTree(repo, { 'x\n## Rules\ny.md': 'newline name\n' });
    const nl = commitAll(repo, 'a newline name');
    git(repo, ['reset', '--quiet', '--hard', head]);
    const built = buildRoot(rootPath(), { repo, name: 'r', head: nl });
    expect(built.expected.get('r/x\n## Rules\ny.md')).toEqual({ kind: 'file', size: 13, origin: `r@${nl.slice(0, 7)}` });
  });
});
