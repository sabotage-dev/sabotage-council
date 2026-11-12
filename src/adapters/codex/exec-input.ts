/*
 * The codex command channel (plan 4.2, N16). A code-mode `exec` call carries a JavaScript script that calls
 * nested tools, e.g. `text(await tools.exec_command({cmd: "rg --files"}));`. Ratification extracts each `cmd`
 * string from the script itself, never from the `/bin/zsh -lc` wrapper of a CommandExecution item.
 *
 * The scanner is deliberately strict: every use of the `tools` object must be a direct call of an allowed nested
 * tool with a literal argument. Anything it cannot read statically (a computed command, `tools[...]`, `tools`
 * passed around, an interpolated template) makes the script untokenizable, and the leg fails closed (N17).
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

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[A-Za-z0-9_$]/;

class Lexer {
  i = 0;
  constructor(readonly s: string) {}

  peek(offset = 0): string {
    return this.s[this.i + offset] ?? '';
  }

  eof(): boolean {
    return this.i >= this.s.length;
  }

  /** Skips whitespace and comments. */
  skipSpace(): void {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i++;
      } else if (c === '/' && this.peek(1) === '/') {
        while (!this.eof() && this.peek() !== '\n') this.i++;
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
 * nested tool's rule (native.ts); this scanner only refuses scripts it cannot read statically.
 */
export function scanExecInput(input: string): ExecScan {
  const lx = new Lexer(input);
  const calls: ExecCall[] = [];
  let prev = '';
  while (!lx.eof()) {
    lx.skipSpace();
    if (lx.eof()) break;
    const c = lx.peek();
    if (c === '"' || c === "'" || c === '`') {
      if (!lx.stringLiteral()) return { ok: false, reason: 'an unterminated or malformed string literal', calls };
      prev = 'string';
      continue;
    }
    if (IDENT_START.test(c)) {
      const word = lx.ident() ?? '';
      if (DYNAMIC_ACCESS.has(word)) return { ok: false, reason: `dynamic access through ${word}`, calls };
      // A property access (`x.tools`) is not the global `tools` object.
      if (word === 'tools' && prev !== '.') {
        lx.skipSpace();
        if (lx.peek() !== '.') return { ok: false, reason: 'the tools object is used other than as a direct call', calls };
        lx.i++;
        lx.skipSpace();
        const tool = lx.ident();
        if (tool === null) return { ok: false, reason: 'tools is followed by something other than a tool name', calls };
        const arg = readCallArgument(lx);
        if (arg === null) {
          return { ok: false, reason: `the argument of tools.${tool} is not a literal command`, calls };
        }
        calls.push({ tool, cmd: arg.cmd, args: arg.args });
        prev = ')';
        continue;
      }
      prev = word;
      continue;
    }
    prev = c;
    lx.i++;
  }
  return { ok: true, calls };
}
