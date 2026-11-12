/*
 * The codex command channel (plan 4.2, N16). A code-mode `exec` call carries a JavaScript script that calls
 * nested tools, e.g. `text(await tools.exec_command({cmd: "rg --files"}));`. Ratification extracts each `cmd`
 * string from the script itself, never from the `/bin/zsh -lc` wrapper of a CommandExecution item.
 *
 * The scanner is an allowlist grammar (round 1 fold): a script passes only when every way it can reach a tool is a
 * direct `tools.<name>(<literal>)` call the scanner extracted. It fails closed, with a reason, on anything that
 * could hide a call from it or build one at run time (N17):
 *   - a template literal holding `${` anywhere, not only as a call argument;
 *   - a `/` outside a string that does not open a comment (regex literals and division both fail);
 *   - a `\` outside a string (an escaped identifier such as `\u0074ools`);
 *   - `tools` reached as a property (`.tools`, `...tools`, `?.tools`), or followed by anything but `.<name>(`;
 *   - a `[` followed by a string or template (computed member access with a string key, `x["..."]`);
 *   - a string literal whose content is a DYNAMIC_ACCESS word, or `tools`;
 *   - a DYNAMIC_ACCESS identifier, or a call argument that is not a literal.
 * Comments end where JavaScript ends them (any line terminator, U+2028 and U+2029 included), so a call after such
 * a terminator is never read as part of a comment.
 */

export type LiteralValue = string | number | boolean | null | string[];

export interface ExecCall {
  tool: string;
  /** The command, when the call carried one. */
  cmd: string | null;
  /** Every argument, as literals. A bare string argument is `{ cmd: <string> }`. */
  args: Record<string, LiteralValue>;
}

/**
 * Identifiers that reach the tools object, or the global object, without the literal `tools.<name>(...)` form
 * the scanner reads. `ALL_TOOLS` is the exec isolate's tool list (a live leg introspected it); the rest are the
 * usual routes to the global object or to code built from strings. Any of them makes the script untokenizable.
 */
export const DYNAMIC_ACCESS = new Set([
  'ALL_TOOLS',
  'globalThis',
  'global',
  'self',
  'window',
  'eval',
  'Function',
  'Reflect',
  'Proxy',
  'import',
  'require',
  'constructor',
  '__proto__',
  'prototype',
  'this',
  'with',
]);

export type ExecScan = { ok: true; calls: ExecCall[] } | { ok: false; reason: string; calls: ExecCall[] };

/** Strings with these contents name the global object or the tools object; any of them fails the script. */
export const FORBIDDEN_STRINGS: ReadonlySet<string> = new Set([...DYNAMIC_ACCESS, 'tools']);

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;
/** ECMAScript WhiteSpace and LineTerminator code points. */
const JS_SPACE = /[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/** ECMAScript LineTerminator: where a `//` comment ends. */
const LINE_END = /[\n\r\u2028\u2029]/;

class Lexer {
  i = 0;
  constructor(readonly s: string) {}

  peek(offset = 0): string {
    return this.s[this.i + offset] ?? '';
  }

  eof(): boolean {
    return this.i >= this.s.length;
  }

  /** Skips whitespace and comments, as JavaScript delimits them. */
  skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c !== '' && JS_SPACE.test(c)) {
        this.i++;
      } else if (c === '/' && this.peek(1) === '/') {
        while (!this.eof() && !LINE_END.test(this.peek())) this.i++;
      } else if (c === '/' && this.peek(1) === '*') {
        const end = this.s.indexOf('*/', this.i + 2);
        this.i = end < 0 ? this.s.length : end + 2;
      } else {
        return;
      }
    }
  }

  ident(): string | null {
    if (!IDENT_START.test(this.peek())) return null;
    const start = this.i;
    while (IDENT.test(this.peek())) this.i++;
    return this.s.slice(start, this.i);
  }

  /** Reads a string or template literal at the cursor. `interpolated` is set for a template with `${`. */
  stringLiteral(): { value: string; interpolated: boolean } | null {
    const quote = this.peek();
    if (quote !== '"' && quote !== "'" && quote !== '`') return null;
    this.i++;
    let value = '';
    let interpolated = false;
    while (!this.eof()) {
      const c = this.peek();
      if (c === quote) {
        this.i++;
        return { value, interpolated };
      }
      if (c === '\\') {
        const decoded = this.escape();
        if (decoded === null) return null;
        value += decoded;
        continue;
      }
      if (quote === '`' && c === '$' && this.peek(1) === '{') interpolated = true;
      if (quote !== '`' && (c === '\n' || c === '\r')) return null;
      value += c;
      this.i++;
    }
    return null;
  }

  private escape(): string | null {
    this.i++; // the backslash
    const c = this.peek();
    this.i++;
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'v':
        return '\v';
      case '0':
        return '\0';
      case '\n':
        return '';
      case '\r':
        if (this.peek() === '\n') this.i++;
        return '';
      case 'x': {
        const hex = this.s.slice(this.i, this.i + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
        this.i += 2;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case 'u': {
        if (this.peek() === '{') {
          const end = this.s.indexOf('}', this.i);
          const hex = end < 0 ? '' : this.s.slice(this.i + 1, end);
          if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return null;
          this.i = end + 1;
          return String.fromCodePoint(parseInt(hex, 16));
        }
        const hex = this.s.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        this.i += 4;
        return String.fromCharCode(parseInt(hex, 16));
      }
      case '':
        return null;
      default:
        return c;
    }
  }
}

/** A literal value inside the call's argument object: string, number, boolean, null or a list of strings. */
function readLiteral(lx: Lexer): { value: LiteralValue } | null {
  const str = lx.stringLiteral();
  if (str) return str.interpolated ? null : { value: str.value };
  if (lx.peek() === '[') {
    lx.i++;
    const list: string[] = [];
    for (;;) {
      lx.skipSpace();
      if (lx.peek() === ']') {
        lx.i++;
        return { value: list };
      }
      const item = lx.stringLiteral();
      if (!item || item.interpolated) return null;
      list.push(item.value);
      lx.skipSpace();
      if (lx.peek() === ',') lx.i++;
      else if (lx.peek() !== ']') return null;
    }
  }
  const m = /^(?:-?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?![A-Za-z0-9_$])/.exec(lx.s.slice(lx.i));
  if (!m) return null;
  lx.i += m[0].length;
  const word = m[0];
  return { value: word === 'true' ? true : word === 'false' ? false : word === 'null' ? null : Number(word.replace(/_/g, '')) };
}

/** Reads `()`, `( <string> )` or `( { key: literal, ... } )` after a nested tool name. */
function readCallArgument(lx: Lexer): { cmd: string | null; args: Record<string, LiteralValue> } | null {
  lx.skipSpace();
  if (lx.peek() !== '(') return null;
  lx.i++;
  lx.skipSpace();
  let cmd: string | null = null;
  const args: Record<string, LiteralValue> = {};
  if (lx.peek() === ')') {
    lx.i++;
    return { cmd, args };
  }
  if (lx.peek() === '{') {
    lx.i++;
    for (;;) {
      lx.skipSpace();
      if (lx.peek() === '}') {
        lx.i++;
        break;
      }
      const keyString = lx.stringLiteral();
      let key: string | null;
      if (keyString) key = keyString.interpolated ? null : keyString.value;
      else key = lx.ident();
      if (key === null) return null;
      lx.skipSpace();
      if (lx.peek() !== ':') return null;
      lx.i++;
      lx.skipSpace();
      const value = readLiteral(lx);
      if (value === null || Object.hasOwn(args, key)) return null;
      args[key] = value.value;
      if (key === 'cmd') {
        if (typeof value.value !== 'string') return null;
        cmd = value.value;
      }
      lx.skipSpace();
      if (lx.peek() === ',') {
        lx.i++;
        continue;
      }
      if (lx.peek() === '}') {
        lx.i++;
        break;
      }
      return null;
    }
  } else {
    const str = lx.stringLiteral();
    if (!str || str.interpolated) return null;
    cmd = str.value;
    args['cmd'] = cmd;
  }
  lx.skipSpace();
  if (lx.peek() !== ')') return null;
  lx.i++;
  return { cmd, args };
}

/**
 * Extracts every nested tool call from an `exec` script, with literal arguments. The ratifier applies each
 * nested tool's rule (native.ts); this scanner refuses every script it cannot read statically.
 */
export function scanExecInput(input: string): ExecScan {
  const lx = new Lexer(input);
  const calls: ExecCall[] = [];
  const fail = (reason: string): ExecScan => ({ ok: false, reason, calls });
  // The last significant character outside strings and comments ('string' after a string literal).
  let prev = '';
  for (;;) {
    lx.skipSpace();
    if (lx.eof()) break;
    const c = lx.peek();
    if (c === '"' || c === "'" || c === '`') {
      const str = lx.stringLiteral();
      if (!str) return fail('an unterminated or malformed string literal');
      if (str.interpolated) return fail('a template literal with ${...}');
      if (FORBIDDEN_STRINGS.has(str.value)) return fail(`a string literal that names ${str.value}`);
      prev = 'string';
      continue;
    }
    if (c === '\\') return fail('a backslash outside a string (an escaped identifier)');
    // skipSpace consumed every comment, so a / here is a regex literal or a division.
    if (c === '/') return fail('a / outside a string that opens no comment (a regex literal or a division)');
    if (c === '[') {
      lx.i++;
      lx.skipSpace();
      const next = lx.peek();
      if (next === '"' || next === "'" || next === '`') return fail('a [ followed by a string (computed member access with a string key)');
      prev = '[';
      continue;
    }
    if (IDENT_START.test(c)) {
      const word = lx.ident() ?? '';
      if (DYNAMIC_ACCESS.has(word)) return fail(`dynamic access through ${word}`);
      if (word === 'tools') {
        // `.tools`, `...tools` and `?.tools` all end in a dot: the object reached some other way.
        if (prev === '.') return fail('tools is reached as a property (.tools, ...tools)');
        lx.skipSpace();
        if (lx.peek() !== '.') return fail('the tools object is used other than as a direct call');
        lx.i++;
        lx.skipSpace();
        const tool = lx.ident();
        if (tool === null) return fail('tools is followed by something other than a tool name');
        const arg = readCallArgument(lx);
        if (arg === null) return fail(`the argument of tools.${tool} is not a literal command`);
        calls.push({ tool, cmd: arg.cmd, args: arg.args });
        prev = ')';
        continue;
      }
      prev = 'ident';
      continue;
    }
    prev = c;
    lx.i++;
  }
  return { ok: true, calls };
}
