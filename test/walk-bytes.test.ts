import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileNameError } from '../src/root/names.js';
import { walk } from '../src/root/walk.js';
import { removeDir, tempDir } from './helpers/git-fixture.js';

/**
 * Some filesystems (APFS on macOS) refuse a name that is not valid UTF-8, so names.test.ts can only plant one on
 * Linux. Here `readdirSync` is wrapped: for the one directory below it also reports the bytes `a` 0x80, as a
 * filesystem that stores raw bytes would. Every other call goes to the real function.
 */
const fake = vi.hoisted(() => ({ dir: '' }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const readdirSync = ((path: string, options?: unknown) => {
    const names = (fs.readdirSync as (p: string, o?: unknown) => (string | Buffer)[])(path, options);
    if (path !== fake.dir) return names;
    const bad = Buffer.from([0x61, 0x80]);
    const asBuffer = typeof options === 'object' && options !== null && (options as { encoding?: string }).encoding === 'buffer';
    return [...names, asBuffer ? bad : bad.toString('utf8')];
  }) as typeof fs.readdirSync;
  return { ...fs, default: { ...fs, readdirSync }, readdirSync };
});

let tmp: string;
beforeAll(() => {
  tmp = tempDir('sc-walk-bytes-');
  mkdirSync(join(tmp, 'sub'));
  writeFileSync(join(tmp, 'sub', 'ok.txt'), 'ok\n');
  fake.dir = join(tmp, 'sub');
});
afterAll(() => removeDir(tmp));

describe('walk on a filesystem that stores raw name bytes', () => {
  it('throws FileNameError for a name that is not valid UTF-8, instead of reading it as a\\uFFFD', () => {
    expect(() => walk(tmp)).toThrow(FileNameError);
    expect(() => walk(tmp)).toThrow(/sub: the name "a\ufffd" \(bytes 6180\) is not valid UTF-8/);
  });
});
