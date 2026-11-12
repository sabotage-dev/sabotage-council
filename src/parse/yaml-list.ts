/**
 * A minimal parser for the one YAML shape seats write in a findings block: a list of flat mappings.
 *
 * ```yaml
 * - id: F1
 *   severity: HIGH
 *   path: src/x.ts
 *   line: 42
 *   title: "a title: with a colon"
 * ```
 *
 * Supported: block list items whose values are plain, single-quoted or double-quoted scalars, `|` and `>` block
 * scalars, comments, and `---` / `...` markers. Anything else (nested lists or mappings, flow collections,
 * anchors, tags) is rejected with a reason, so the caller can hand the block to the adjudicator instead of
 * guessing. No dependency: the shape is small and a full YAML parser would accept far more than findings need.
 */

export type YamlScalar = string | number | boolean | null;
export type YamlRecord = Record<string, YamlScalar>;

export class YamlListError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'YamlListError';
  }
}

interface Line {
  no: number;
  indent: number;
  text: string;
}

const KEY = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/;

export function parseYamlList(source: string): YamlRecord[] {
  const lines: Line[] = source.split(/\r\n|\n|\r/).map((raw, i) => {
    const indent = /^ */.exec(raw)?.[0].length ?? 0;
    return { no: i + 1, indent, text: raw.slice(indent).replace(/\s+$/, '') };
  });
  const items: YamlRecord[] = [];
  let current: YamlRecord | null = null;
  let keyIndent = -1;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as Line;
    i++;
    if (line.text === '' || line.text.startsWith('#') || line.text === '---' || line.text === '...') continue;
    if (/^\t/.test(line.text)) throw new YamlListError('tabs are not allowed for indentation', line.no);
    let rest: string;
    if (line.text === '-' || line.text.startsWith('- ')) {
      current = {};
      items.push(current);
      rest = line.text.slice(1).trimStart();
      keyIndent = line.indent + (line.text.length - rest.length);
      if (rest === '') {
        keyIndent = -1; // the first key sets it
        continue;
      }
    } else {
      if (current === null) throw new YamlListError('expected a list item ("- key: value")', line.no);
      if (keyIndent === -1) keyIndent = line.indent;
      if (line.indent !== keyIndent) throw new YamlListError('unexpected indentation (nested values are not supported)', line.no);
      rest = line.text;
    }
    const kv = KEY.exec(rest);
    if (!kv?.[1]) throw new YamlListError(`expected "key: value", got "${rest}"`, line.no);
    const key = kv[1];
    if (Object.hasOwn(current, key)) throw new YamlListError(`duplicate key "${key}"`, line.no);
    const value = kv[2] ?? '';
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      let blockIndent = -1;
      while (i < lines.length) {
        const next = lines[i] as Line;
        if (next.text !== '' && next.indent <= keyIndent) break;
        if (next.text !== '' && blockIndent === -1) blockIndent = next.indent;
        block.push(next.text === '' ? '' : ' '.repeat(Math.max(0, next.indent - blockIndent)) + next.text);
        i++;
      }
      while (block.length > 0 && block.at(-1) === '') block.pop();
      current[key] = value.startsWith('|') ? block.join('\n') : block.join(' ').replace(/\s+/g, ' ').trim();
      continue;
    }
    if (value === '') {
      // An empty value followed by deeper lines would be a nested structure.
      const next = lines.slice(i).find((l) => l.text !== '' && !l.text.startsWith('#'));
      if (next !== undefined && next.indent > keyIndent && !next.text.startsWith('- ')) {
        throw new YamlListError(`nested values are not supported (key "${key}")`, next.no);
      }
      if (next !== undefined && next.indent > keyIndent) {
        throw new YamlListError(`nested lists are not supported (key "${key}")`, next.no);
      }
      current[key] = null;
      continue;
    }
    current[key] = scalar(value, line.no);
  }
  return items;
}

function scalar(value: string, no: number): YamlScalar {
  const first = value[0];
  if (first === '"') {
    const end = closingDoubleQuote(value);
    if (end < 0) throw new YamlListError('unterminated double-quoted string', no);
    trailing(value.slice(end + 1), no);
    try {
      return JSON.parse(value.slice(0, end + 1)) as string;
    } catch {
      throw new YamlListError('unsupported escape in a double-quoted string', no);
    }
  }
  if (first === "'") {
    let out = '';
    let j = 1;
    for (; j < value.length; j++) {
      const c = value[j];
      if (c === "'") {
        if (value[j + 1] === "'") {
          out += "'";
          j++;
          continue;
        }
        trailing(value.slice(j + 1), no);
        return out;
      }
      out += c;
    }
    throw new YamlListError('unterminated single-quoted string', no);
  }
  if (first === '[' || first === '{') throw new YamlListError('flow collections are not supported', no);
  if (first === '&' || first === '*' || first === '!') throw new YamlListError('anchors, aliases and tags are not supported', no);
  const plain = value.replace(/\s+#.*$/, '').trim();
  if (/^-?\d+$/.test(plain)) return Number.parseInt(plain, 10);
  if (/^(null|~)$/i.test(plain)) return null;
  if (/^(true|false)$/i.test(plain)) return plain.toLowerCase() === 'true';
  return plain;
}

function closingDoubleQuote(value: string): number {
  for (let j = 1; j < value.length; j++) {
    if (value[j] === '\\') j++;
    else if (value[j] === '"') return j;
  }
  return -1;
}

function trailing(rest: string, no: number): void {
  if (rest.trim() !== '' && !/^\s+#/.test(rest)) throw new YamlListError('text after a quoted string', no);
}
