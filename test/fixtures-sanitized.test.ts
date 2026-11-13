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

describe('fixtures are sanitized', () => {
  const files = listFiles(FIXTURES);

  it('scans the recorded fixtures of every adapter', () => {
    const rel = files.map((f) => relative(FIXTURES, f));
    for (const kind of ['codex/', 'claude/', 'antigravity/', 'kiro/', 'grok/', 'opencode/', 'muse/', 'cursor/']) expect(rel.some((f) => f.startsWith(kind))).toBe(true);
  });

  it.each(FORBIDDEN)('no fixture contains %s', (_what, pattern) => {
    const hits = files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(FIXTURES, f));
    expect(hits).toEqual([]);
  });

  it('catches each shape (the scan works)', () => {
    for (const [, pattern] of FORBIDDEN.slice(0, 4)) {
      expect(['/Users/someone/x', 'by pat', 'x@gmail.com', 'someone@example.org'].some((s) => pattern.test(s))).toBe(true);
    }
  });
});
