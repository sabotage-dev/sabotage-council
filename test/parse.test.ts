import { describe, expect, it } from 'vitest';
import {
  checkNonce,
  normalizeSeverity,
  parseFindings,
  parseLegReply,
  parseLocation,
  parseVerdict,
  parseYamlList,
  type LegFinding,
} from '../src/parse/index.js';

const NONCE = '9f8e7d6c5b4a';
const FENCE = '```';

/** Builds a finding with the defaults most rows share. */
function f(over: Partial<LegFinding> & Pick<LegFinding, 'id' | 'title'>): LegFinding {
  return { severity: 'LOW', severity_raw: null, severity_flag: null, path: null, line: null, end_line: null, ...over };
}

describe('verdict parser (plan 3.2)', () => {
  it.each<[string, string, string, boolean]>([
    ['a plain last line', 'Review text.\n\nVERDICT: SHIP', 'SHIP', true],
    ['bold', 'x\n**VERDICT: NEEDS-WORK**\n', 'NEEDS-WORK', true],
    ['a heading', 'x\n### VERDICT: SHIP-WITH-FIXES', 'SHIP-WITH-FIXES', true],
    ['bold label only', 'x\n**VERDICT:** SHIP-WITH-FIXES', 'SHIP-WITH-FIXES', true],
    ['a quote and lower case', 'x\n> Verdict: ship', 'SHIP', true],
    ['code ticks', 'x\n`VERDICT: NEEDS-WORK`', 'NEEDS-WORK', true],
    ['spaces inside the word', 'x\nVERDICT:   SHIP WITH FIXES  ', 'SHIP-WITH-FIXES', true],
    ['a trailing period', 'x\nVERDICT: SHIP.', 'SHIP', true],
    ['CRLF line ends', 'x\r\nVERDICT: SHIP\r\n', 'SHIP', true],
    ['the same verdict twice (the last wins)', 'VERDICT: SHIP\nmore\nVERDICT: SHIP', 'SHIP', true],
    ['a verdict before trailing prose', 'VERDICT: SHIP\nThanks for reading.', 'SHIP', false],
  ])('accepts %s', (_name, text, verdict, onLastLine) => {
    const r = parseVerdict(text);
    expect(r.verdict).toBe(verdict);
    expect(r.reason).toBe('ok');
    expect(r.onLastLine).toBe(onLastLine);
  });

  it('accepts a verdict split across two lines (N26), on the next non-empty line', () => {
    const r = parseVerdict('Findings above.\n\nVERDICT:\n\n**SHIP-WITH-FIXES**\n');
    expect(r).toEqual({
      verdict: 'SHIP-WITH-FIXES',
      reason: 'ok',
      matches: [{ verdict: 'SHIP-WITH-FIXES', line: 3, split: true }],
      onLastLine: true,
    });
  });

  it('reads two DIFFERENT verdict lines as none', () => {
    const r = parseVerdict('VERDICT: NEEDS-WORK\n...on reflection...\nVERDICT: SHIP');
    expect(r.verdict).toBe('none');
    expect(r.reason).toBe('conflict');
    expect(r.matches.map((m) => m.verdict)).toEqual(['NEEDS-WORK', 'SHIP']);
  });

  it('reads a split verdict that disagrees with a one-line verdict as none', () => {
    expect(parseVerdict('VERDICT: SHIP\nVERDICT:\nNEEDS-WORK').verdict).toBe('none');
  });

  it.each([
    ['no verdict at all', 'Looks good to me.'],
    ['the template echoed', 'Last line: VERDICT: SHIP | SHIP-WITH-FIXES | NEEDS-WORK'],
    ['the choice list alone', 'VERDICT: SHIP | SHIP-WITH-FIXES | NEEDS-WORK'],
    ['a longer word', 'VERDICT: SHIPPED'],
    ['a bare label followed by prose', 'VERDICT:\nthe code is fine'],
    ['a verdict inside a sentence', 'My VERDICT: SHIP, mostly.'],
  ])('finds none in %s', (_name, text) => {
    const r = parseVerdict(text);
    expect(r.verdict).toBe('none');
    expect(r.reason).toBe('missing');
  });
});

describe('nonce check', () => {
  it.each<[string, string, ReturnType<typeof checkNonce>]>([
    ['on the first line', `NONCE: ${NONCE}\nbody`, { present: true, where: 'first-line', line: 1, verbatim: true }],
    ['bold, after blank lines', `\n\n**NONCE: ${NONCE}**\nbody`, { present: true, where: 'first-line', line: 3, verbatim: true }],
    ['in a sentence on the first line', `Nonce ${NONCE} echoed.\n`, { present: true, where: 'first-line', line: 1, verbatim: false }],
    ['further down', `Review\n\nNONCE: ${NONCE}\n`, { present: true, where: 'elsewhere', line: 3, verbatim: false }],
    ['in upper case', `NONCE: ${NONCE.toUpperCase()}`, { present: true, where: 'first-line', line: 1, verbatim: true }],
    ['absent', 'no nonce here', { present: false, where: 'absent', line: null, verbatim: false }],
    ['only inside a longer hex run', `NONCE: 0${NONCE}`, { present: false, where: 'absent', line: null, verbatim: false }],
    ['a different nonce', 'NONCE: 000000000000', { present: false, where: 'absent', line: null, verbatim: false }],
  ])('%s', (_name, text, want) => {
    expect(checkNonce(text, NONCE)).toEqual(want);
  });

  it('rejects a malformed nonce argument', () => {
    expect(() => checkNonce('x', 'XYZ')).toThrow(/12 lowercase hex/);
  });
});

describe('severity normalizer (plan 3.3)', () => {
  it.each<[string | null, string, string | null]>([
    ['HIGH', 'HIGH', null],
    ['MEDIUM', 'MEDIUM', null],
    ['LOW', 'LOW', null],
    ['NIT', 'NIT', null],
    ['CRITICAL', 'HIGH', null],
    ['BLOCKER', 'HIGH', null],
    ['MED', 'MEDIUM', null],
    ['MAJOR', 'MEDIUM', null],
    ['MINOR', 'LOW', null],
    ['INFO', 'NIT', null],
    ['STYLE', 'NIT', null],
    ['critical', 'HIGH', null],
    ['**High**', 'HIGH', null],
    ['[MED]', 'MEDIUM', null],
    ['', 'LOW', 'unlabelled'],
    [null, 'LOW', 'unlabelled'],
    ['**', 'LOW', 'unlabelled'],
    ['P1', 'LOW', 'unrecognized'],
  ])('%s -> %s', (raw, severity, flag) => {
    const n = normalizeSeverity(raw);
    expect(n.severity).toBe(severity);
    expect(n.flag).toBe(flag);
  });

  it('keeps the raw label', () => {
    expect(normalizeSeverity(' Critical ')).toEqual({ severity: 'HIGH', raw: 'Critical', flag: null });
  });
});

describe('location parser', () => {
  it.each<[string, string | null, number | null, number | null]>([
    ['src/x.ts:42', 'src/x.ts', 42, null],
    ['src/x.ts:12-14', 'src/x.ts', 12, 14],
    ['src/x.ts:12\u201314', 'src/x.ts', 12, 14],
    ['src/x.ts:12 - 14', 'src/x.ts', 12, 14],
    ['src/x.ts:12:5', 'src/x.ts', 12, null],
    ['src/x.ts#L7-L9', 'src/x.ts', 7, 9],
    ['src/x.ts#L7', 'src/x.ts', 7, null],
    ['`src/x.ts:3`', 'src/x.ts', 3, null],
    ['./src/x.ts', 'src/x.ts', null, null],
    ['docs/PLAN.md', 'docs/PLAN.md', null, null],
    ['src/x.ts:0', 'src/x.ts', null, null],
    ['src/x.ts:14-12', 'src/x.ts', 14, null],
    ['-', null, null, null],
    ['n/a', null, null, null],
    ['', null, null, null],
  ])('%s', (text, path, line, end) => {
    expect(parseLocation(text)).toEqual({ path, line, end_line: end });
  });
});

describe('findings-block parser (plan 3.9)', () => {
  it('parses the line grammar', () => {
    const reply = [
      'F1 HIGH src/cache.ts:42 ... (prose above the block)',
      '',
      `${FENCE}findings`,
      'F1 | HIGH | src/cache.ts:42 | the TTL is read as seconds but stored as ms',
      'F2 | MED | src/retry.ts:30-41 | retry loop never gives up',
      'F3 | CRITICAL | docs/README.md | the install step deletes the user config',
      'F4 | | - | no severity and no path',
      'F5 | NIT | src/a.ts:3 | a title | with a pipe',
      FENCE,
      'VERDICT: NEEDS-WORK',
    ].join('\n');
    expect(parseFindings(reply)).toEqual({
      extracted_by: 'leg',
      format: 'lines',
      findings: [
        f({ id: 'F1', severity: 'HIGH', severity_raw: 'HIGH', path: 'src/cache.ts', line: 42, title: 'the TTL is read as seconds but stored as ms' }),
        f({ id: 'F2', severity: 'MEDIUM', severity_raw: 'MED', path: 'src/retry.ts', line: 30, end_line: 41, title: 'retry loop never gives up' }),
        f({ id: 'F3', severity: 'HIGH', severity_raw: 'CRITICAL', path: 'docs/README.md', title: 'the install step deletes the user config' }),
        f({ id: 'F4', severity_flag: 'unlabelled', title: 'no severity and no path' }),
        f({ id: 'F5', severity: 'NIT', severity_raw: 'NIT', path: 'src/a.ts', line: 3, title: 'a title | with a pipe' }),
      ],
    });
  });

  it('parses a markdown table and bulleted lines', () => {
    const table = `${FENCE}findings\n| ID | Severity | Location | Title |\n|---|---|---|---|\n| F1 | LOW | a.ts:1 | one |\n${FENCE}`;
    expect(parseFindings(table)).toMatchObject({ extracted_by: 'leg', findings: [{ id: 'F1', severity: 'LOW', path: 'a.ts', line: 1, title: 'one' }] });
    const bullets = `${FENCE}findings\n- F1 | MAJOR | a.ts:1 | one\n* F2 | MINOR | b.ts | two\n${FENCE}`;
    expect(parseFindings(bullets)).toMatchObject({
      extracted_by: 'leg',
      findings: [
        { id: 'F1', severity: 'MEDIUM' },
        { id: 'F2', severity: 'LOW' },
      ],
    });
  });

  it('parses a JSON array (seen live instead of the line grammar)', () => {
    const json = JSON.stringify(
      [
        { id: 'F1', severity: 'BLOCKER', path: 'src/auth.ts', line: 88, title: 'token compared with ==', fix: 'timingSafeEqual' },
        { id: 2, severity: 'info', file: 'src/log.ts:5-9', title: 'noisy log' },
        { id: 'F3', file: 'README.md', line: '12-14', title: 'stale command' },
      ],
      null,
      2,
    );
    expect(parseFindings(`Findings:\n${FENCE}findings\n${json}\n${FENCE}\nVERDICT: NEEDS-WORK`)).toEqual({
      extracted_by: 'leg',
      format: 'json',
      findings: [
        f({ id: 'F1', severity: 'HIGH', severity_raw: 'BLOCKER', path: 'src/auth.ts', line: 88, title: 'token compared with ==' }),
        f({ id: '2', severity: 'NIT', severity_raw: 'info', path: 'src/log.ts', line: 5, end_line: 9, title: 'noisy log' }),
        f({ id: 'F3', severity_flag: 'unlabelled', path: 'README.md', line: 12, end_line: 14, title: 'stale command' }),
      ],
    });
  });

  it('parses a JSON object holding a findings array', () => {
    const json = '{"findings": [{"id": "F1", "severity": "HIGH", "path": "a.ts", "line": 1, "title": "t"}]}';
    expect(parseFindings(`${FENCE}findings\n${json}\n${FENCE}`)).toMatchObject({ extracted_by: 'leg', format: 'json', findings: [{ id: 'F1' }] });
  });

  it('parses a YAML list (seen live)', () => {
    const yaml = [
      `${FENCE}findings`,
      '- id: F1',
      '  severity: MAJOR',
      '  path: src/queue.ts',
      '  line: 120',
      '  title: "ack happens before the write: a crash loses the job"',
      '- id: F2',
      "  severity: 'minor'",
      '  file: src/queue.ts:7-8   # the import block',
      "  title: 'it''s unused'",
      '- id: F3',
      '  title: >',
      '    a folded',
      '    title',
      FENCE,
    ].join('\n');
    expect(parseFindings(yaml)).toEqual({
      extracted_by: 'leg',
      format: 'yaml',
      findings: [
        f({ id: 'F1', severity: 'MEDIUM', severity_raw: 'MAJOR', path: 'src/queue.ts', line: 120, title: 'ack happens before the write: a crash loses the job' }),
        f({ id: 'F2', severity: 'LOW', severity_raw: 'minor', path: 'src/queue.ts', line: 7, end_line: 8, title: "it's unused" }),
        f({ id: 'F3', severity_flag: 'unlabelled', title: 'a folded title' }),
      ],
    });
  });

  it.each([
    ['an empty block', `${FENCE}findings\n${FENCE}`],
    ['"none"', `${FENCE}findings\nnone\n${FENCE}`],
    ['an empty JSON array', `${FENCE}findings\n[]\n${FENCE}`],
  ])('reads %s as no findings, extracted by the leg', (_name, text) => {
    expect(parseFindings(text)).toEqual({ findings: [], extracted_by: 'leg', format: 'empty' });
  });

  it('uses the last findings block, and accepts tilde fences and longer fences', () => {
    const two = `${FENCE}findings\nF1 | HIGH | a.ts | first\n${FENCE}\nrevised:\n~~~findings\nF1 | LOW | a.ts | second\n~~~`;
    expect(parseFindings(two)).toMatchObject({ findings: [{ severity: 'LOW', title: 'second' }] });
    const long = '````findings\nF1 | LOW | a.ts | has ``` inside\n````';
    expect(parseFindings(long)).toMatchObject({ findings: [{ title: 'has ``` inside' }] });
  });

  it('ignores fenced blocks with other tags', () => {
    expect(parseFindings(`${FENCE}json\n[{"id":"F1","title":"t"}]\n${FENCE}`)).toMatchObject({ extracted_by: 'adjudicator-needed' });
  });

  it.each<[string, string, RegExp]>([
    ['a missing block', 'VERDICT: SHIP', /no fenced findings block/],
    ['an unclosed block', `${FENCE}findings\nF1 | HIGH | a.ts | t\n`, /not closed/],
    ['a line with too few fields', `${FENCE}findings\nF1 | HIGH | title only\n${FENCE}`, /expected "ID \| SEVERITY/],
    ['a malformed id', `${FENCE}findings\nfinding one | HIGH | a.ts | t\n${FENCE}`, /malformed finding id/],
    ['a line with no title', `${FENCE}findings\nF1 | HIGH | a.ts | \n${FENCE}`, /expected "ID \| SEVERITY/],
    ['invalid JSON', `${FENCE}findings\n[{"id": "F1",}]\n${FENCE}`, /invalid JSON/],
    ['JSON without a title', `${FENCE}findings\n[{"id": "F1", "severity": "HIGH"}]\n${FENCE}`, /missing title/],
    ['JSON that is a string', `${FENCE}findings\n{"id": "F1"}\n${FENCE}`, /neither an array/],
    ['JSON with an object as a field', `${FENCE}findings\n[{"id": "F1", "title": {"x": 1}}]\n${FENCE}`, /must be a string/],
    ['nested YAML', `${FENCE}findings\n- id: F1\n  title: t\n  raised_by:\n    - a\n${FENCE}`, /nested lists/],
    ['a YAML flow mapping', `${FENCE}findings\n- id: F1\n  title: {a: 1}\n${FENCE}`, /flow collections/],
    ['duplicate ids', `${FENCE}findings\nF1 | HIGH | a.ts | one\nF1 | LOW | b.ts | two\n${FENCE}`, /duplicate finding id "F1"/],
  ])('hands %s to the adjudicator instead of throwing', (_name, text, reason) => {
    const r = parseFindings(text);
    expect(r.findings).toEqual([]);
    expect(r.extracted_by).toBe('adjudicator-needed');
    expect(r.extracted_by === 'adjudicator-needed' ? r.reason : '').toMatch(reason);
  });
});

describe('YAML list parser', () => {
  it('parses scalars, quotes, comments and block scalars', () => {
    const doc = ['---', '# a comment', '- id: F1', '  line: 7', '  ok: true', '  none: ~', '  lit: |', '    one', '      two', '- ', '  id: F2', '...'].join(
      '\n',
    );
    expect(parseYamlList(doc)).toEqual([
      { id: 'F1', line: 7, ok: true, none: null, lit: 'one\n  two' },
      { id: 'F2' },
    ]);
  });

  it.each([
    ['a key before any item', 'id: F1', /expected a list item/],
    ['wrong indentation', '- id: F1\n    title: t', /unexpected indentation/],
    ['a duplicate key', '- id: F1\n  id: F2', /duplicate key/],
    ['an unterminated string', '- title: "abc', /unterminated/],
    ['an anchor', '- title: &a x', /anchors/],
  ])('rejects %s', (_name, doc, message) => {
    expect(() => parseYamlList(doc)).toThrow(message);
  });
});

describe('a whole leg reply', () => {
  const reply = [
    `NONCE: ${NONCE}`,
    '',
    'F1 HIGH src/session.ts:51: a session token survives logout. Scenario: log out, replay the cookie, still in.',
    'Fix: delete the row in logout() before clearing the cookie.',
    '',
    'Not verified: whether the CDN caches /logout.',
    '',
    `${FENCE}findings`,
    'F1 | HIGH | src/session.ts:51 | a session token survives logout',
    FENCE,
    '',
    'VERDICT:',
    'NEEDS-WORK',
  ].join('\n');

  it('parses nonce, verdict and findings together', () => {
    const r = parseLegReply(reply, NONCE);
    expect(r.nonce).toEqual({ present: true, where: 'first-line', line: 1, verbatim: true });
    expect(r.verdict).toMatchObject({ verdict: 'NEEDS-WORK', reason: 'ok', onLastLine: true });
    expect(r.findings).toMatchObject({ extracted_by: 'leg', findings: [{ id: 'F1', severity: 'HIGH', path: 'src/session.ts', line: 51 }] });
  });
});
