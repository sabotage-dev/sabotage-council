/**
 * Strips a run of `lead` characters from the start and then a run of `tail` characters from the end, in one linear
 * pass each. It replaces regexes of the shape `^[set]+|[set]+$`, whose trailing half backtracks quadratically on a
 * long run of set characters followed by one that is not (council round 1).
 */
export function stripRuns(text: string, lead: (c: string) => boolean, tail: (c: string) => boolean): string {
  let start = 0;
  while (start < text.length && lead(text[start] as string)) start++;
  let end = text.length;
  while (end > start && tail(text[end - 1] as string)) end--;
  return text.slice(start, end);
}

const WHITESPACE = /\s/;

/** True for every character `\s` matches. */
export function isSpace(c: string): boolean {
  return WHITESPACE.test(c);
}

/** A character-set predicate, for stripRuns. */
export function oneOf(chars: string): (c: string) => boolean {
  return (c) => chars.includes(c);
}
