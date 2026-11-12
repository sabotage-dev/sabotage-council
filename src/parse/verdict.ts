/** A leg's verdict words (plan 3.2). */
export const VERDICTS = ['SHIP', 'SHIP-WITH-FIXES', 'NEEDS-WORK'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface VerdictMatch {
  verdict: Verdict;
  /** 1-based line of the `VERDICT:` line. */
  line: number;
  /** True when the word stood alone on the next non-empty line after a bare `VERDICT:` (N26). */
  split: boolean;
}

export interface VerdictResult {
  /** `none` when no verdict line was found, or when two different verdicts were (plan 3.2). */
  verdict: Verdict | 'none';
  reason: 'ok' | 'missing' | 'conflict';
  /** Every verdict line, in reply order. The last one wins when they agree. */
  matches: VerdictMatch[];
  /** The winning match ends on the reply's last non-empty line, as the output contract asks. */
  onLastLine: boolean;
}

// Wrappers seats put around the line: markdown headings, emphasis, quotes and code ticks, plus spaces.
const W = '[\\s#*_`>]*';
const WORD = '(SHIP[-_ ]WITH[-_ ]FIXES|NEEDS[-_ ]WORK|SHIP)';
const SAME_LINE = new RegExp(`^${W}VERDICT${W}:${W}${WORD}[.!]?${W}$`, 'i');
const BARE_LABEL = new RegExp(`^${W}VERDICT${W}:${W}$`, 'i');
const WORD_ALONE = new RegExp(`^${W}${WORD}[.!]?${W}$`, 'i');

function canonical(word: string): Verdict {
  const upper = word.toUpperCase().replace(/[_ ]/g, '-');
  return upper as Verdict;
}

export function splitLines(text: string): string[] {
  return text.split(/\r\n|[\n\r\u2028\u2029]/);
}

/**
 * Parses a leg's verdict (plan 3.2). The regex tolerates `#`, `*`, `_`, backticks, `>` and spaces around the line.
 * A verdict split across two lines (`VERDICT:` alone, then the word alone on the next non-empty line) is accepted
 * (seen live; N26). The last match wins, but two different verdicts anywhere in the reply parse as `none`.
 */
export function parseVerdict(text: string): VerdictResult {
  const lines = splitLines(text);
  const matches: VerdictMatch[] = [];
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() !== '') lastNonEmpty = i;
    const same = SAME_LINE.exec(line);
    if (same?.[1] !== undefined) {
      matches.push({ verdict: canonical(same[1]), line: i + 1, split: false });
      continue;
    }
    if (BARE_LABEL.test(line)) {
      let j = i + 1;
      while (j < lines.length && (lines[j] ?? '').trim() === '') j++;
      const word = WORD_ALONE.exec(lines[j] ?? '');
      if (word?.[1] !== undefined) matches.push({ verdict: canonical(word[1]), line: i + 1, split: true });
    }
  }
  const last = matches.at(-1);
  if (last === undefined) return { verdict: 'none', reason: 'missing', matches, onLastLine: false };
  if (new Set(matches.map((m) => m.verdict)).size > 1) {
    return { verdict: 'none', reason: 'conflict', matches, onLastLine: false };
  }
  // The winning match's final line: the VERDICT line itself, or the word's line for a split verdict.
  let end = last.line - 1;
  if (last.split) {
    end++;
    while (end < lines.length && (lines[end] ?? '').trim() === '') end++;
  }
  return { verdict: last.verdict, reason: 'ok', matches, onLastLine: end === lastNonEmpty };
}

export interface NonceCheck {
  present: boolean;
  /** `first-line`: on the first non-empty line, as the brief asks. */
  where: 'first-line' | 'elsewhere' | 'absent';
  /** 1-based line of the first occurrence; null when absent. */
  line: number | null;
  /** The first non-empty line is exactly `NONCE: <nonce>` (wrappers allowed). */
  verbatim: boolean;
}

export const NONCE_PATTERN = /^[0-9a-f]{12}$/;

/**
 * Checks that a reply echoes the round's nonce (plan 3.9). The nonce must appear as a whole token; the first
 * non-empty line is preferred, and the result says where it was found.
 */
export function checkNonce(text: string, nonce: string): NonceCheck {
  if (!NONCE_PATTERN.test(nonce)) throw new Error(`a nonce is 12 lowercase hex characters, got "${nonce}"`);
  const token = new RegExp(`(?<![0-9a-f])${nonce}(?![0-9a-f])`, 'i');
  const verbatimLine = new RegExp(`^${W}NONCE${W}:${W}${nonce}${W}$`, 'i');
  const lines = splitLines(text);
  const first = lines.findIndex((l) => l.trim() !== '');
  const verbatim = first >= 0 && verbatimLine.test(lines[first] ?? '');
  const at = lines.findIndex((l) => token.test(l));
  if (at < 0) return { present: false, where: 'absent', line: null, verbatim: false };
  return { present: true, where: at === first ? 'first-line' : 'elsewhere', line: at + 1, verbatim };
}
