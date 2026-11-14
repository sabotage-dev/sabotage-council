import { parse } from 'smol-toml';

/*
 * `seats add | remove | swap` (plan 8.4): edit the user's config file. The default editor (`preservingEditor`) changes
 * only the target seat's own `[[seats]]` block and keeps every other byte of the file as it was: comments, order,
 * blank lines, the other sections. It is the one seam the owner may replace (a whole-file rewrite, say) without
 * touching the commands: `SeatEditor.edit(text, op)` returns the new text or throws a SeatEditError.
 *
 * What the default editor places, and what it refuses (never a rewrite that drops comments):
 * - seats written as `[[seats]]` tables, each block running to the next table header;
 * - refused: seats as an inline array (`seats = [...]`), a `[seats.x]` or `[[seats.x]]` sub-table, a dotted `seats.`
 *   key, and an occupant key (backend, model, effort, sandbox, auth_home) whose value is not a one-line string;
 * - swap: replaces the seat's occupant keys in place (a key's trailing comment stays), adds the ones the new occupant
 *   sets, and deletes the ones it does not (an effort, a sandbox or an auth_home belongs to the old occupant). The id
 *   and the fallback stay;
 * - add: appends a new `[[seats]]` block after the last one (at the end of the file when there is none);
 * - remove: deletes the block from its header to its last key line (comments after it, before the next header, stay).
 * After the edit, both texts are parsed and compared: everything but the target seat must parse the same, and the
 * target seat must parse as intended, or the edit is refused.
 */

export class SeatEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeatEditError';
  }
}

export interface NewOccupant {
  backend: string;
  model: string;
  effort?: string | undefined;
  sandbox?: string | undefined;
  auth_home?: string | undefined;
}

export type SeatEdit = { kind: 'swap'; seat: string; occupant: NewOccupant } | { kind: 'add'; seat: string; occupant: NewOccupant } | { kind: 'remove'; seat: string };

export interface SeatEditor {
  /** The new config text for `op`, or a SeatEditError saying why the file cannot be edited safely. */
  edit(text: string, op: SeatEdit): string;
}

/** The keys that make up a seat's occupant, in the order a new block writes them. */
export const OCCUPANT_KEYS = ['backend', 'model', 'effort', 'sandbox', 'auth_home'] as const;

// ---- a line scanner that knows where TOML strings and multi-line values are ----

interface Line {
  /** The line's text without its terminator. */
  text: string;
  /** `\n`, `\r\n`, or '' for a last line with none. */
  eol: string;
  /** The line starts outside any string and any multi-line array or inline table. */
  top: boolean;
}

function splitWithEol(text: string): Line[] {
  const out: Line[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const end = nl === -1 ? text.length : nl;
    const cr = end > at && text[end - 1] === '\r';
    out.push({ text: text.slice(at, cr ? end - 1 : end), eol: nl === -1 ? '' : cr ? '\r\n' : '\n', top: false });
    at = nl === -1 ? text.length : nl + 1;
  }
  return out;
}

const HEADER = /^\s*(\[\[?)\s*([^\]\r\n]*?)\s*(\]\]?)\s*(?:#.*)?$/;

/** Marks each line `top` when it starts outside strings and multi-line values (headers are read as headers). */
function scan(lines: Line[]): void {
  type Mode = 'none' | 'basic' | 'literal' | 'mlbasic' | 'mlliteral';
  let mode: Mode = 'none';
  let depth = 0;
  for (const line of lines) {
    line.top = mode === 'none' && depth === 0;
    const s = line.text;
    if (line.top && /^\s*\[/.test(s) && HEADER.test(s)) continue;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (mode === 'none') {
        if (c === '#') break;
        if (c === '[' || c === '{') depth += 1;
        else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
        else if (c === '"' || c === "'") {
          const triple = s.startsWith(c.repeat(3), i);
          mode = c === '"' ? (triple ? 'mlbasic' : 'basic') : triple ? 'mlliteral' : 'literal';
          if (triple) i += 2;
        }
      } else if (mode === 'basic') {
        if (c === '\\') i += 1;
        else if (c === '"') mode = 'none';
      } else if (mode === 'literal') {
        if (c === "'") mode = 'none';
      } else {
        const q = mode === 'mlbasic' ? '"' : "'";
        if (mode === 'mlbasic' && c === '\\') {
          i += 1;
          continue;
        }
        if (c === q && s.startsWith(q.repeat(3), i)) {
          let run = 3;
          while (run < 5 && s[i + run] === q) run += 1;
          i += run - 1;
          mode = 'none';
        }
      }
    }
    // A single-line string cannot cross a line end; TOML would reject it, and so does the parse after the edit.
    if (mode === 'basic' || mode === 'literal') mode = 'none';
  }
}

/** A table header's dotted key, normalized: `[[ seats ]]` -> `seats`, `["seats". x]` -> `seats.x`. */
function headerKey(raw: string): string {
  return raw
    .split('.')
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .join('.');
}

const KEY_LINE = /^(\s*)((?:[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"\\]*"|'[^']*'))*)(\s*=\s*)(.*)$/;

function keyOf(raw: string): string {
  return raw
    .split(/\s*\.\s*/)
    .map((p) => p.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .join('.');
}

interface Block {
  /** Line index of its `[[seats]]` header. */
  header: number;
  /** The last line of the block that holds a key or a value (comments and blanks after it are not the block's). */
  contentEnd: number;
  /** One past its last line (the next header, or the end of the file). */
  end: number;
}

interface KeyLine {
  index: number;
  key: string;
  /** Lines the key's value spans (1 for a one-line value). */
  span: number;
}

interface Layout {
  lines: Line[];
  eol: string;
  blocks: Block[];
}

function layoutOf(text: string): Layout {
  const lines = splitWithEol(text);
  scan(lines);
  const crlf = lines.filter((l) => l.eol === '\r\n').length;
  const lf = lines.filter((l) => l.eol === '\n').length;
  const eol = crlf > lf ? '\r\n' : '\n';
  const headers: Array<{ index: number; key: string; array: boolean }> = [];
  lines.forEach((l, index) => {
    if (!l.top) return;
    const m = HEADER.exec(l.text);
    if (!m || !/^\s*\[/.test(l.text)) return;
    const array = m[1] === '[[' && m[3] === ']]';
    headers.push({ index, key: headerKey(m[2] ?? ''), array });
  });
  for (const h of headers) {
    if (h.key === 'seats' && !h.array) throw new SeatEditError(`line ${h.index + 1}: seats are written as a [seats] table; the editor places only [[seats]] blocks`);
    if (h.key.startsWith('seats.')) {
      throw new SeatEditError(`line ${h.index + 1}: a [${h.key}] sub-table belongs to a seat; the editor cannot place a seat written that way (write its keys inline in the [[seats]] block)`);
    }
  }
  // A dotted or inline `seats` key at the top level (before the first header).
  const firstHeader = headers[0]?.index ?? lines.length;
  for (let i = 0; i < firstHeader; i++) {
    const l = lines[i] as Line;
    const m = l.top ? KEY_LINE.exec(l.text) : null;
    if (m && (keyOf(m[2] ?? '') === 'seats' || keyOf(m[2] ?? '').startsWith('seats.'))) {
      throw new SeatEditError(`line ${i + 1}: seats are written as an inline array (or a dotted key); the editor places only [[seats]] blocks, so edit this file by hand or rewrite its seats as [[seats]] tables`);
    }
  }
  const blocks: Block[] = [];
  headers.forEach((h, k) => {
    if (h.key !== 'seats') return;
    const end = headers[k + 1]?.index ?? lines.length;
    let contentEnd = h.index;
    for (let i = h.index + 1; i < end; i++) {
      const l = lines[i] as Line;
      const t = l.text.trim();
      if (!l.top || (t !== '' && !t.startsWith('#'))) contentEnd = i;
    }
    blocks.push({ header: h.index, contentEnd, end });
  });
  return { lines, eol, blocks };
}

function keyLines(lines: readonly Line[], block: Block): KeyLine[] {
  const out: KeyLine[] = [];
  for (let i = block.header + 1; i <= block.contentEnd; i++) {
    const l = lines[i] as Line;
    if (!l.top) continue;
    const m = KEY_LINE.exec(l.text);
    if (!m) continue;
    let span = 1;
    while (i + span <= block.contentEnd && !(lines[i + span] as Line).top) span += 1;
    out.push({ index: i, key: keyOf(m[2] ?? ''), span });
  }
  return out;
}

/** A TOML basic string. JSON's escapes (\", \\, \n, \uXXXX, ...) are all valid TOML escapes. */
export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const ONE_LINE_STRING = /^("(?:[^"\\]|\\.)*"|'[^'\r\n]*')(.*)$/;

/** The value of a one-line TOML string token, or null when it does not parse. */
function stringValue(token: string): string | null {
  try {
    const v = (parse(`v = ${token}`) as { v?: unknown }).v;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function occupantLines(seat: string, o: NewOccupant): string[] {
  const lines = [`id = ${tomlString(seat)}`];
  for (const k of OCCUPANT_KEYS) {
    const v = o[k];
    if (v !== undefined) lines.push(`${k} = ${tomlString(v)}`);
  }
  return lines;
}

type Doc = Record<string, unknown>;

function parseDoc(text: string, what: string): Doc {
  try {
    return parse(text) as Doc;
  } catch (error) {
    throw new SeatEditError(`${what} does not parse as TOML: ${(error instanceof Error ? error.message : String(error)).split('\n', 1)[0]}`);
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v instanceof Date) return { date: v.toISOString() };
  if (typeof v === 'object' && v !== null) {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical((v as Doc)[k])]),
    );
  }
  if (typeof v === 'bigint') return { bigint: v.toString() };
  return v;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function seatsOf(doc: Doc): Doc[] {
  const s = doc['seats'];
  if (s === undefined) return [];
  if (!Array.isArray(s)) throw new SeatEditError('`seats` is not an array of tables');
  return s as Doc[];
}

/** Builds the edit by lines; the result is checked by `verify`. */
function editLines(text: string, op: SeatEdit): string {
  const doc = parseDoc(text, 'the config');
  const seats = seatsOf(doc);
  const { lines, eol, blocks } = layoutOf(text);
  if (blocks.length !== seats.length) {
    throw new SeatEditError(`the file has ${seats.length} seat(s) but ${blocks.length} [[seats]] block(s): seats written as an inline array cannot be placed safely`);
  }
  const index = seats.findIndex((s) => s['id'] === op.seat);
  const out = lines.map((l) => l.text + l.eol);

  if (op.kind === 'add') {
    const block = occupantLines(op.seat, op.occupant);
    const blockText = ['[[seats]]', ...block].map((l) => l + eol).join('');
    if (blocks.length === 0) {
      let prefix = text;
      if (prefix !== '' && !prefix.endsWith('\n')) prefix += eol;
      const blank = prefix === '' || /(?:^|\n)\s*\r?\n$/.test(prefix) ? '' : eol;
      return prefix + blank + blockText;
    }
    const last = blocks.at(-1) as Block;
    const at = last.contentEnd;
    const terminated = (lines[at] as Line).eol === '' ? eol : '';
    const next = lines[at + 1];
    const trailing = next !== undefined && next.text.trim() !== '' ? eol : '';
    out[at] = (out[at] as string) + terminated + eol + blockText + trailing;
    return out.join('');
  }

  if (index < 0) throw new SeatEditError(`no seat "${op.seat}" in the file (seats: ${seats.map((s) => String(s['id'])).join(', ') || 'none'})`);
  const block = blocks[index] as Block;

  if (op.kind === 'remove') {
    // The block's own lines go; of the blank lines around it, one stays, so no double blank (or trailing blank) is left.
    let from = block.header;
    let to = block.contentEnd;
    const blank = (l: Line | undefined): boolean => l !== undefined && l.text.trim() === '';
    if (blank(lines[from - 1]) && blank(lines[to + 1])) to += 1;
    else if (blank(lines[from - 1]) && lines[to + 1] === undefined) from -= 1;
    return [...out.slice(0, from), ...out.slice(to + 1)].join('');
  }

  // swap
  const keys = keyLines(lines, block);
  const has = new Map<string, KeyLine>();
  for (const k of keys) if ((OCCUPANT_KEYS as readonly string[]).includes(k.key)) has.set(k.key, k);
  for (const k of has.values()) {
    if (k.span > 1) throw new SeatEditError(`line ${k.index + 1}: the seat's ${k.key} spans several lines; the editor replaces only a one-line string`);
  }
  for (const req of ['backend', 'model'] as const) {
    if (!has.has(req)) throw new SeatEditError(`seat "${op.seat}" has no ${req} line in its [[seats]] block`);
  }
  const replaced = new Map<number, string | null>();
  const inserts: string[] = [];
  let anchor = (has.get('model') as KeyLine).index;
  for (const k of OCCUPANT_KEYS) {
    const v = op.occupant[k];
    const line = has.get(k);
    if (line) {
      if (v === undefined) {
        replaced.set(line.index, null);
        continue;
      }
      const m = KEY_LINE.exec((lines[line.index] as Line).text);
      const value = ONE_LINE_STRING.exec(m?.[4] ?? '');
      if (!m || !value) throw new SeatEditError(`line ${line.index + 1}: the seat's ${k} is not a one-line string; the editor cannot replace it`);
      anchor = Math.max(anchor, line.index);
      // A value that does not change keeps its line byte for byte (its quotes too).
      if (stringValue(value[1] ?? '') === v) continue;
      replaced.set(line.index, `${m[1] ?? ''}${m[2] ?? ''}${m[3] ?? ''}${tomlString(v)}${value[2] ?? ''}`);
    } else if (v !== undefined) {
      inserts.push(`${k} = ${tomlString(v)}`);
    }
  }
  const anchorLine = lines[anchor] as Line;
  const indent = /^\s*/.exec(anchorLine.text)?.[0] ?? '';
  for (const [i, v] of replaced) out[i] = v === null ? '' : v + (lines[i] as Line).eol;
  if (inserts.length > 0) {
    // The anchor is a kept occupant line (the model at least), so it is never one of the deleted lines.
    const terminated = anchorLine.eol === '' ? eol : '';
    out[anchor] = (out[anchor] as string) + terminated + inserts.map((l, k) => indent + l + (k === inserts.length - 1 && anchorLine.eol === '' ? '' : eol)).join('');
  }
  return out.join('');
}

/** The target seat as the edit means it, for the check after the edit. */
function expectedSeats(seats: readonly Doc[], op: SeatEdit): Doc[] {
  const occupant = (o: NewOccupant): Doc => Object.fromEntries(OCCUPANT_KEYS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  if (op.kind === 'add') return [...seats, { id: op.seat, ...occupant(op.occupant) }];
  if (op.kind === 'remove') return seats.filter((s) => s['id'] !== op.seat);
  return seats.map((s) => {
    if (s['id'] !== op.seat) return s;
    const rest = Object.fromEntries(Object.entries(s).filter(([k]) => !(OCCUPANT_KEYS as readonly string[]).includes(k)));
    return { ...rest, ...occupant(op.occupant) };
  });
}

/** Refuses an edit whose result parses differently from what the op means anywhere in the file. */
export function verifySeatEdit(before: string, after: string, op: SeatEdit): void {
  const a = parseDoc(before, 'the config');
  const b = parseDoc(after, 'the edited config');
  const restA = { ...a };
  const restB = { ...b };
  delete restA['seats'];
  delete restB['seats'];
  if (!same(restA, restB)) throw new SeatEditError('the edit would change more than the seat (the rest of the file parses differently); refused');
  if (!same(seatsOf(b), expectedSeats(seatsOf(a), op))) throw new SeatEditError('the edited seats do not parse as intended; refused (the file is not one the editor can place safely)');
}

export const preservingEditor: SeatEditor = {
  edit(text: string, op: SeatEdit): string {
    const after = editLines(text, op);
    verifySeatEdit(text, after, op);
    return after;
  },
};
