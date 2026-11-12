import { scanFences } from './fences.js';

/** A leg's verdict words (plan 3.2). */
export const VERDICTS = ['SHIP', 'SHIP-WITH-FIXES', 'NEEDS-WORK'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerdictMatch {
  verdict: Verdict;
  /** 1-based line of the `VERDICT:` line. */
  line: number;
  /** 1-based line the match ends on: the same line, or the word's line for a split verdict. */
  endLine: number;
  /** True when the word stood alone on the next non-empty line after a bare `VERDICT:` (N26). */
  split: boolean;
}

/** Why a verdict-shaped line did not count: inside a code fence, a `>` block quote, or an indented code block. */
export type SkipReason = 'fence' | 'quote' | 'indent';

export interface SkippedLine {
  /** 1-based line. */
  line: number;
  why: SkipReason;
}

/**
 * `ok`: one verdict, on the reply's last non-empty line. `missing`: no eligible verdict line. `conflict`: eligible
 * lines with different verdicts. `not-last-line`: the last eligible verdict is not on the last non-empty line.
 */
export type VerdictReason = 'ok' | 'missing' | 'conflict' | 'not-last-line';

export interface VerdictResult {
  /** The verdict only when `reason` is `ok`; otherwise `none` (plan 3.2). */
  verdict: Verdict | 'none';
  reason: VerdictReason;
  /** Every eligible verdict line, in reply order. */
  matches: VerdictMatch[];
  /** Verdict-shaped lines that were not eligible, so the record shows what a quote or a broken fence hid. */
  skipped: SkippedLine[];
  /** The last eligible match ends on the reply's last non-empty line, as the output contract asks. */
  onLastLine: boolean;
}

// Wrappers seats put around the line: markdown headings, emphasis and code ticks, plus spaces. Not `>`: a quoted
// line is never the leg's own verdict.
const W = '[\\s#*_`]*';
const WORD = '(SHIP[-_ ]WITH[-_ ]FIXES|NEEDS[-_ ]WORK|SHIP)';
const SAME_LINE = new RegExp(`^${W}VERDICT${W}:${W}${WORD}[.!]?${W}$`, 'i');
const BARE_LABEL = new RegExp(`^${W}VERDICT${W}:${W}$`, 'i');
const WORD_ALONE = new RegExp(`^${W}${WORD}[.!]?${W}$`, 'i');
const QUOTE = /^[ \t]*>/;
const INDENTED = /^(?: {4}| {0,3}\t)/;

function canonical(word: string): Verdict {
  const upper = word.toUpperCase().replace(/[_ ]/g, '-');
  return upper as Verdict;
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\u2028\u2029]/);
}

/**
 * Why each line cannot carry the leg's own verdict, or null when it can. A `>` line opens a block quote, and every
 * non-blank line right after it stays in the quote as lazy continuation text (CommonMark), with or without its own
 * `>`, until a blank line or a fence line ends it.
 */
function eligibility(lines: readonly string[], inFence: readonly boolean[]): (SkipReason | null)[] {
  const out: (SkipReason | null)[] = [];
  let quoted = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (inFence[i] === true) {
      quoted = false; // a fence interrupts the quote's paragraph, so it is never lazy continuation
      out.push('fence');
    } else if (line.trim() === '') {
      quoted = false;
      out.push(null);
    } else if (QUOTE.test(line)) {
      quoted = true;
      out.push('quote');
    } else if (quoted) {
      out.push('quote');
    } else {
      out.push(INDENTED.test(line) ? 'indent' : null);
    }
  }
  return out;
}

/** A line that would read as a verdict line once its quote marks and indentation are gone (for `skipped`). */
function verdictShaped(line: string): boolean {
  let i = 0;
  while (i < line.length && (line[i] === '>' || line[i] === ' ' || line[i] === '\t')) i++;
  const bare = line.slice(i);
  return SAME_LINE.test(bare) || BARE_LABEL.test(bare);
}

/**
 * Parses a leg's verdict (plan 3.2). The output contract puts it on the reply's last non-empty line.
 * - Eligible lines only: a line inside a code fence (the scan the findings parser uses), a `>` block quote (with its
 *   lazy continuation lines) or an indented code block never counts, so a quoted contract, test or PR text cannot
 *   forge or cancel a verdict.
 * - The regex tolerates `#`, `*`, `_`, backticks and spaces around the line, any letter case, and the verdict split
 *   across two lines: a bare `VERDICT:`, then the word alone on the next non-empty line (seen live; N26).
 * - Two different eligible verdicts parse as `none` (`conflict`).
 * - The last eligible verdict must end on the last non-empty line; otherwise `none` (`not-last-line`).
 */
export function parseVerdict(text: string): VerdictResult {
  const lines = splitLines(text);
  const { inFence } = scanFences(lines);
  const why = eligibility(lines, inFence);
  const matches: VerdictMatch[] = [];
  const skipped: SkippedLine[] = [];
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() !== '') lastNonEmpty = i;
    const reason = why[i] ?? null;
    if (reason !== null) {
      if (verdictShaped(line)) skipped.push({ line: i + 1, why: reason });
      continue;
    }
    const same = SAME_LINE.exec(line);
    if (same?.[1] !== undefined) {
      matches.push({ verdict: canonical(same[1]), line: i + 1, endLine: i + 1, split: false });
      continue;
    }
    if (BARE_LABEL.test(line)) {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      const word = (why[j] ?? null) === null ? WORD_ALONE.exec(lines[j] ?? '') : null;
      if (word?.[1] !== undefined) matches.push({ verdict: canonical(word[1]), line: i + 1, endLine: j + 1, split: true });
    }
  }
  const last = matches.at(-1);
  if (last === undefined) return { verdict: 'none', reason: 'missing', matches, skipped, onLastLine: false };
  const onLastLine = last.endLine - 1 === lastNonEmpty;
  if (new Set(matches.map((m) => m.verdict)).size > 1) {
    return { verdict: 'none', reason: 'conflict', matches, skipped, onLastLine };
  }
  if (!onLastLine) return { verdict: 'none', reason: 'not-last-line', matches, skipped, onLastLine };
  return { verdict: last.verdict, reason: 'ok', matches, skipped, onLastLine };
}

export interface NonceCheck {
  /**
   * The contract (plan 3.9): the reply's first non-empty line is exactly `NONCE: <nonce>` (heading, emphasis and
   * code-tick wrappers allowed). The only field ratification may accept the nonce on; LegReply.nonceOk is this.
   */
  verbatim: boolean;
  /** Diagnostic: the nonce appears somewhere as a whole token. Not the contract. */
  present: boolean;
  /**
   * Diagnostic: where the first occurrence is. `first-line` means on the first non-empty line, but not necessarily
   * as the NONCE line (a nonce inside a sentence there is `first-line` with `verbatim: false`).
   */
  where: 'first-line' | 'elsewhere' | 'absent';
  /** 1-based line of the first occurrence; null when absent. */
  line: number | null;
}

export const NONCE_PATTERN = /^[0-9a-f]{12}$/;

/**
 * Checks that a reply echoes the round's nonce (plan 3.9). The contract is `verbatim`: the first non-empty line is
 * the NONCE line. `present`, `where` and `line` describe any other occurrence, for the record only.
 */
export function checkNonce(text: string, nonce: string): NonceCheck {
  if (!NONCE_PATTERN.test(nonce)) throw new Error(`a nonce is 12 lowercase hex characters, got "${nonce}"`);
  const token = new RegExp(`(?<![0-9a-f])${nonce}(?![0-9a-f])`, 'i');
  const verbatimLine = new RegExp(`^${W}NONCE${W}:${W}${nonce}${W}$`, 'i');
  const lines = splitLines(text);
  const first = lines.findIndex((l) => l.trim() !== '');
  const verbatim = first >= 0 && verbatimLine.test(lines[first] ?? '');
  const at = lines.findIndex((l) => token.test(l));
  if (at < 0) return { verbatim: false, present: false, where: 'absent', line: null };
  return { verbatim, present: true, where: at === first ? 'first-line' : 'elsewhere', line: at + 1 };
}
