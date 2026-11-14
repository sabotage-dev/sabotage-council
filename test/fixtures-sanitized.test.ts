import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listFiles } from './helpers/fixtures.js';

/*
 * Every recorded fixture is sanitized (brief P2 item 6): absolute paths, usernames, session ids and anything
 * personal are replaced with placeholders. This test fails if any fixture still carries one of the shapes below.
 * "pat" is matched as a whole word (so `path` and `pattern` pass); an email is any `x@y.tld` shape.
 */

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

const FORBIDDEN: ReadonlyArray<[string, RegExp]> = [
  ['a /Users/ path', /\/Users\//],
  ['the word pat', /\bpat\b/i],
  ['gmail', /gmail/i],
  ['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['a macOS temp path', /\/var\/folders\/|\/private\/tmp\/claude-/],
  ['a home path other than the placeholder', /\/home\/(?!user\b)[A-Za-z]/],
  ['an account or org uuid field', /creator_(?:user|account)_id|accountUuid|organizationUuid/],
  ['an em dash', /\u2014/],
  ['a scratch or session path', /claude-\d{3}|scratchpad/],
  ['a token field value', /"(?:access_token|refresh_token|client_secret)":\s*"[^"]/],
];

/**
 * Byte arrays inside JSON records (grok's grep `stdout` is one) decoded to text, so a path stored as numbers is
 * scanned too.
 */
export function byteArrayTexts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[(\d{1,3}(?:,\s*\d{1,3}){15,})\]/g)) {
    const bytes = (m[1] ?? '').split(',').map((n) => Number(n.trim()));
    if (bytes.every((b) => b >= 0 && b < 256)) out.push(Buffer.from(bytes).toString('utf8'));
  }
  return out;
}

/** What the scan reads of one fixture: its text, plus every byte array in it decoded. */
export function scannedText(text: string): string {
  return [text, ...byteArrayTexts(text)].join('\n');
}

describe('fixtures are sanitized', () => {
  const files = listFiles(FIXTURES);
  const contents = (f: string): string => scannedText(readFileSync(f, 'utf8'));

  it('scans the recorded fixtures of every adapter', () => {
    const rel = files.map((f) => relative(FIXTURES, f));
    for (const kind of ['codex/', 'claude/', 'claude-adjudicator/', 'antigravity/', 'kiro/', 'grok/', 'opencode/', 'muse/', 'cursor/']) expect(rel.some((f) => f.startsWith(kind))).toBe(true);
  });

  it.each(FORBIDDEN)('no fixture contains %s', (_what, pattern) => {
    const hits = files.filter((f) => pattern.test(contents(f))).map((f) => relative(FIXTURES, f));
    expect(hits).toEqual([]);
  });

  it('decodes byte arrays before scanning (a path stored as numbers is caught)', () => {
    const encoded = JSON.stringify({ stdout: [...Buffer.from('/var/folders/x/y/T/z')] });
    expect(byteArrayTexts(encoded).some((t) => /\/var\/folders\//.test(t))).toBe(true);
    // The scan itself reads the decoded text: the macOS temp path pattern catches the encoded one.
    const temp = FORBIDDEN.find(([what]) => what === 'a macOS temp path')?.[1];
    expect(temp?.test(encoded)).toBe(false);
    expect(temp?.test(scannedText(encoded))).toBe(true);
  });

  it('catches each shape (the scan works)', () => {
    for (const [, pattern] of FORBIDDEN.slice(0, 4)) {
      expect(['/Users/someone/x', 'by pat', 'x@gmail.com', 'someone@example.org'].some((s) => pattern.test(s))).toBe(true);
    }
  });
});
