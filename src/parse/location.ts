import { oneOf, stripRuns } from './trim.js';

export interface Location {
  /** Null when the seat gave no path (`-`, `n/a`, empty). */
  path: string | null;
  /** 1-based; null when absent or not a positive integer. */
  line: number | null;
  /** The end of a `path:12-14` range; null otherwise. */
  end_line: number | null;
}

const NO_PATH = new Set(['', '-', '--', 'n/a', 'na', 'none', 'null', 'general', '(none)', '(general)']);

function positive(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

const OPENERS = oneOf('`"\'([');
const CLOSERS = oneOf('`"\')]');

/** Strips wrapping backticks, quotes and brackets a seat may put around a location (linear, council round 1). */
function unwrap(text: string): string {
  return stripRuns(text.trim(), OPENERS, CLOSERS).trim();
}

/**
 * Parses `path:line`, `path:12-14` (also with an en dash), `path:12:5` (the column is dropped), GitHub's
 * `path#L12` / `path#L12-L14`, and a bare path.
 */
export function parseLocation(input: string | null | undefined): Location {
  const text = unwrap(input ?? '');
  if (NO_PATH.has(text.toLowerCase())) return { path: null, line: null, end_line: null };
  const colon = /^(.+?):(\d+)(?:\s*[-\u2013]\s*(\d+))?(?::\d+)?$/.exec(text);
  const hash = colon ? null : /^(.+?)#L(\d+)(?:-L?(\d+))?$/.exec(text);
  const m = colon ?? hash;
  if (m?.[1] !== undefined) {
    const line = positive(m[2]);
    const end = positive(m[3]);
    return { path: cleanPath(m[1]), line, end_line: line !== null && end !== null && end >= line ? end : null };
  }
  return { path: cleanPath(text), line: null, end_line: null };
}

function cleanPath(path: string): string {
  return path.trim().replace(/^\.\//, '');
}
