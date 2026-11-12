/** The prefix that marks a line of repository or PR text as data, not instructions (plan 5.3, 6.3). */
export const DATA_PREFIX = 'DATA:';

/** Every line break a reader might honour, including the Unicode ones. */
const LINE_BREAKS = /\r\n|[\n\r\v\f\u0085\u2028\u2029]/;

/** Prefixes every line with `DATA:`; an empty line becomes a bare `DATA:`. One trailing newline is dropped. */
export function dataLines(text: string): string[] {
  const lines = text.split(LINE_BREAKS);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return lines.map((line) => (line === '' ? DATA_PREFIX : `${DATA_PREFIX} ${line}`));
}

/**
 * Characters JSON.stringify leaves raw that can still break or hide a line: DEL, the C1 controls (NEL among them),
 * zero-width and bidirectional format characters, U+2028, U+2029 and the byte-order mark.
 */
const UNSAFE_IN_JSON = /[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * A name from the reviewed tree as one JSON string on one line, for a `DATA:` line: control characters, every line
 * break and the invisible format characters are escaped as `\uXXXX`, so the name can never end the line or start an
 * unmarked one.
 */
export function quoteName(name: string): string {
  return JSON.stringify(name).replace(UNSAFE_IN_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export interface PrComment {
  author?: string | undefined;
  /** ISO time, as the forge reports it. */
  at?: string | undefined;
  body: string;
}

/** The PR's own text, given as plain data (forge reads are P6). */
export interface PrData {
  title: string;
  body: string;
  comments?: readonly PrComment[] | undefined;
}

/** `PR.md`: title, body and comments, every line prefixed `DATA:`. */
export function renderPrMd(pr: PrData): string {
  const out: string[] = [...dataLines(`Title: ${pr.title}`), DATA_PREFIX, ...dataLines('Body:'), ...dataLines(pr.body)];
  (pr.comments ?? []).forEach((c, i) => {
    const who = [c.author !== undefined ? `by ${c.author}` : '', c.at !== undefined ? `at ${c.at}` : ''].filter((s) => s !== '');
    out.push(DATA_PREFIX, ...dataLines(`Comment ${i + 1}${who.length > 0 ? ` (${who.join(', ')})` : ''}:`), ...dataLines(c.body));
  });
  return `${out.join('\n')}\n`;
}

/** An earlier review item carried into a later round (plan 3.5). */
export interface EarlierItem {
  /** Source id, e.g. `R123`. It appears in the brief outside the data block, so it is validated. */
  id: string;
  /** The item's text as its reviewer wrote it. */
  text: string;
  /** Who raised it, if known. */
  from?: string | undefined;
  /** Fully closed earlier, text unchanged: listed as context, no row asked for (plan 3.5). */
  closedContext?: boolean | undefined;
}

export const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._:#-]{0,63}$/;

/** `PREVIOUS-REVIEWS.md`: every item with its source id, every line prefixed `DATA:`. */
export function renderPreviousReviews(items: readonly EarlierItem[]): string {
  const out: string[] = [];
  items.forEach((item, i) => {
    if (i > 0) out.push(DATA_PREFIX);
    const tags = [item.from !== undefined ? `from ${item.from}` : '', item.closedContext === true ? 'closed context' : ''].filter(
      (s) => s !== '',
    );
    out.push(...dataLines(`Item ${item.id}${tags.length > 0 ? ` (${tags.join(', ')})` : ''}:`), ...dataLines(item.text));
  });
  return `${out.join('\n')}\n`;
}
