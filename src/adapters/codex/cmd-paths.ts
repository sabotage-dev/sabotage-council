import { posix } from 'node:path';
import { pathInsideRoot, underRoot } from '../paths.js';

/*
 * The command check on codex command strings (plan 4.2, 4.5, N17, round 1 fold). Codex reads are declared
 * unconfined (label `sandboxed-exec`), so this check is what keeps a codex leg's reads inside the root. It is
 * lexical: the `cmd` string is parsed, because there is no argv field.
 *
 * A command passes only when every pipeline segment (split on `|`, `&&`, `||`, `;` and newlines) runs one of the
 * read commands in READ_COMMANDS with only the options it declares, and every word stays inside the root. It fails
 * closed on everything else: any other command (interpreters, git, cd, env, xargs, awk, shell keywords), an
 * environment assignment, a heredoc, an input redirect, a redirect other than to /dev/null, command or process
 * substitution, a subshell, a background job, any word that still holds `~` or `$` after quote removal, brace
 * expansion, a path that leaves the root lexically or by realpath, and a command it cannot tokenize.
 */

export type PathProblemKind = 'outside-root' | 'home' | 'expansion' | 'cd' | 'untokenizable' | 'command' | 'option' | 'redirect' | 'syntax';

export interface PathProblem {
  kind: PathProblemKind;
  token: string;
  detail: string;
}

/**
 * What an option's value is. A `path` value is judged with `pathInsideRoot` in every spelling (`-fX`, `-f X`,
 * `--file=X`, `--file X`, and inside a cluster such as `-nfX`). A `number` must be a count. A `text` value (a
 * pattern, a glob, a format) is never opened as a file. A `script` is a sed script, checked by `sedScriptProblem`.
 */
export type ValueKind = 'path' | 'number' | 'text' | 'script';

/**
 * The options one read command may take (round 2: an allowlist, not a refused list). Any option not declared here
 * fails closed, and a long option must be spelled in full: GNU and BSD getopt accept a unique prefix
 * (`--compress` for `--compress-program`), which this list never matches. The read preface (launch.ts) is built
 * from the same data.
 */
export interface ReadCommandRule {
  /** Short flags that take no value. */
  flags: string;
  /** Short flags that take a value (the rest of the cluster, or the next word), with the value's kind. */
  values?: Readonly<Record<string, ValueKind>>;
  /** Long options, spelled in full: null for a flag, else the value's kind (`--name=X` or `--name X`). */
  long?: Readonly<Record<string, ValueKind | null>>;
  /** find: its expression words (`-name`), null for one that takes no value. */
  predicates?: Readonly<Record<string, ValueKind | null>>;
  /** head and tail: the obsolete `-NUM` count. */
  countOption?: boolean;
  /** At most this many operands (uniq: one input, never an output file). */
  maxOperands?: number;
  /** Options left out on purpose (they run a program, write a file, follow links out, or read a hidden file list). */
  never: readonly string[];
  /** A refusal that is not an option, for the preface. */
  also?: string;
}

const flags = (names: readonly string[]): Record<string, null> => Object.fromEntries(names.map((n) => [n, null]));

/**
 * The read commands a codex leg may run, in preface order, with the options each may take. Measured: real codex
 * council legs use sed -n, nl -ba, rg -n/-g/--files/--hidden/--max-count, wc -l, and plain cat, pwd, head, tail,
 * ls, diff and find. The declarations keep to options GNU and BSD share or that only print, filter or count.
 */
export const READ_COMMANDS: Readonly<Record<string, ReadCommandRule>> = {
  rg: {
    flags: 'nNlciSswxFvoHIUPqabpu0',
    values: { A: 'number', B: 'number', C: 'number', m: 'number', M: 'number', j: 'number', d: 'number', e: 'text', g: 'text', t: 'text', T: 'text', r: 'text', E: 'text', f: 'path' },
    long: {
      ...flags([
        '--files', '--hidden', '--no-ignore', '--no-ignore-vcs', '--no-ignore-dot', '--no-ignore-parent', '--no-ignore-exclude',
        '--line-number', '--no-line-number', '--files-with-matches', '--files-without-match', '--count', '--count-matches',
        '--ignore-case', '--smart-case', '--case-sensitive', '--word-regexp', '--line-regexp', '--fixed-strings', '--invert-match',
        '--only-matching', '--with-filename', '--no-filename', '--multiline', '--multiline-dotall', '--pcre2', '--quiet', '--text',
        '--heading', '--no-heading', '--vimgrep', '--json', '--stats', '--trim', '--column', '--no-column', '--null', '--no-messages',
        '--byte-offset', '--unrestricted', '--no-config', '--passthru', '--sort-files', '--one-file-system', '--crlf', '--binary', '--type-list',
      ]),
      '--glob': 'text', '--iglob': 'text', '--type': 'text', '--type-not': 'text', '--regexp': 'text', '--file': 'path',
      '--max-count': 'number', '--max-depth': 'number', '--max-columns': 'number', '--after-context': 'number',
      '--before-context': 'number', '--context': 'number', '--threads': 'number', '--sort': 'text', '--sortr': 'text',
      '--replace': 'text', '--encoding': 'text', '--max-filesize': 'text', '--color': 'text', '--context-separator': 'text',
    },
    never: ['--pre', '--pre-glob', '-z', '--search-zip', '--hostname-bin', '-L', '--follow'],
  },
  grep: {
    flags: 'nlLciwxFEGvoHhrsqaIbU',
    values: { A: 'number', B: 'number', C: 'number', m: 'number', e: 'text', f: 'path' },
    long: {
      ...flags([
        '--line-number', '--files-with-matches', '--files-without-match', '--count', '--ignore-case', '--word-regexp', '--line-regexp',
        '--fixed-strings', '--extended-regexp', '--basic-regexp', '--invert-match', '--only-matching', '--with-filename', '--no-filename',
        '--recursive', '--no-messages', '--quiet', '--silent', '--text', '--byte-offset',
      ]),
      '--include': 'text', '--exclude': 'text', '--exclude-dir': 'text', '--regexp': 'text', '--file': 'path',
      '--max-count': 'number', '--after-context': 'number', '--before-context': 'number', '--context': 'number',
    },
    never: ['-R', '--dereference-recursive', '-Z', '-z', '--exclude-from'],
  },
  sed: {
    flags: 'nErsuz',
    // No -l: BSD reads it as a flag and GNU as a value, so neither spelling is safe to declare.
    values: { e: 'script' },
    long: {
      ...flags(['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--debug', '--sandbox']),
      '--expression': 'script',
    },
    never: ['-i', '-I', '--in-place', '-f', '--file', '--follow-symlinks'],
    also: 'a script with an e, w, W, r or R command',
  },
  nl: {
    flags: 'p',
    values: { b: 'text', n: 'text', s: 'text', h: 'text', f: 'text', d: 'text', w: 'number', v: 'number', i: 'number', l: 'number' },
    never: [],
  },
  cat: {
    flags: 'nbsvetAETu',
    long: flags(['--number', '--number-nonblank', '--squeeze-blank', '--show-all', '--show-ends', '--show-tabs', '--show-nonprinting']),
    never: [],
  },
  head: {
    flags: 'qv',
    values: { n: 'number', c: 'number' },
    long: { ...flags(['--quiet', '--silent', '--verbose']), '--lines': 'number', '--bytes': 'number' },
    countOption: true,
    never: [],
  },
  tail: {
    flags: 'qvr',
    values: { n: 'number', c: 'number' },
    long: { ...flags(['--quiet', '--silent', '--verbose']), '--lines': 'number', '--bytes': 'number' },
    countOption: true,
    never: ['-f', '-F', '--follow'],
  },
  wc: {
    flags: 'lwcmL',
    long: flags(['--lines', '--words', '--bytes', '--chars', '--max-line-length']),
    never: ['--files0-from'],
  },
  ls: {
    flags: 'laA1RhtrSdFpisnGCxmgoUuckQv',
    long: flags(['--all', '--almost-all', '--recursive', '--human-readable', '--directory', '--classify', '--size', '--inode', '--reverse', '--numeric-uid-gid']),
    never: ['-L', '--dereference', '-H'],
  },
  pwd: { flags: 'LP', never: [] },
  find: {
    flags: 'PE',
    predicates: {
      ...flags([
        '-print', '-print0', '-prune', '-empty', '-not', '-a', '-and', '-o', '-or', '-depth', '-xdev', '-mount', '-quit', '-true',
        '-false', '-readable', '-writable', '-executable', '-nouser', '-nogroup', '-ls',
      ]),
      '-name': 'text', '-iname': 'text', '-path': 'text', '-ipath': 'text', '-wholename': 'text', '-iwholename': 'text',
      '-regex': 'text', '-iregex': 'text', '-lname': 'text', '-ilname': 'text', '-type': 'text', '-size': 'text', '-perm': 'text',
      '-user': 'text', '-group': 'text', '-mtime': 'text', '-mmin': 'text', '-atime': 'text', '-amin': 'text', '-ctime': 'text',
      '-cmin': 'text', '-regextype': 'text', '-printf': 'text', '-maxdepth': 'number', '-mindepth': 'number', '-links': 'number',
      '-inum': 'number', '-newer': 'path', '-anewer': 'path', '-cnewer': 'path', '-samefile': 'path',
    },
    never: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from', '-follow', '-L', '-H'],
  },
  diff: {
    flags: 'uqrNwbBiaystTEZpc',
    values: { U: 'number', C: 'number', W: 'number', x: 'text', I: 'text', L: 'text', X: 'path' },
    long: {
      ...flags([
        '--brief', '--recursive', '--new-file', '--ignore-all-space', '--ignore-space-change', '--ignore-case', '--ignore-blank-lines',
        '--text', '--side-by-side', '--report-identical-files', '--expand-tabs', '--strip-trailing-cr',
      ]),
      '--exclude': 'text', '--label': 'text',
    },
    never: [],
  },
  sort: {
    flags: 'nrufbdghiMRVcCsz',
    values: { k: 'text', t: 'text' },
    long: {
      ...flags([
        '--numeric-sort', '--reverse', '--unique', '--ignore-case', '--version-sort', '--human-numeric-sort', '--general-numeric-sort',
        '--month-sort', '--stable', '--check', '--zero-terminated', '--dictionary-order', '--ignore-leading-blanks',
      ]),
      '--key': 'text', '--field-separator': 'text',
    },
    never: ['-o', '--output', '-T', '--temporary-directory', '-S', '--buffer-size', '--compress-program', '--files0-from', '--random-source'],
  },
  uniq: {
    flags: 'cduiDz',
    values: { f: 'number', s: 'number', w: 'number' },
    long: { ...flags(['--count', '--repeated', '--unique', '--ignore-case']), '--skip-fields': 'number', '--skip-chars': 'number', '--check-chars': 'number' },
    maxOperands: 1,
    never: [],
    also: 'an output file operand',
  },
  cut: {
    flags: 'snzw',
    values: { d: 'text', f: 'text', c: 'text', b: 'text' },
    long: {
      ...flags(['--only-delimited', '--complement']),
      '--delimiter': 'text', '--fields': 'text', '--characters': 'text', '--bytes': 'text', '--output-delimiter': 'text',
    },
    never: [],
  },
  tr: { flags: 'dscCu', never: [] },
  stat: { flags: '', never: ['-L', '--dereference'] },
  file: {
    flags: 'bihkI',
    long: flags(['--brief', '--mime', '--mime-type', '--mime-encoding', '--no-dereference', '--keep-going']),
    never: ['-C', '--compile', '-m', '--magic-file', '-f', '--files-from', '-z', '-Z', '-L'],
  },
};

export const READ_COMMAND_NAMES: readonly string[] = Object.keys(READ_COMMANDS);

const KIND_WORD: Readonly<Record<ValueKind, string>> = { path: 'FILE', number: 'N', text: 'X', script: 'SCRIPT' };

/** One command's declared options, as the read preface prints them. */
export function readCommandUsage(name: string): string {
  const rule = READ_COMMANDS[name];
  if (rule === undefined) return name;
  const parts: string[] = [];
  if (rule.flags !== '') parts.push(`-[${rule.flags}]`);
  if (rule.countOption) parts.push('-NUM');
  const byKind = (entries: ReadonlyArray<[string, ValueKind | null]>, short: boolean): void => {
    for (const kind of ['number', 'text', 'path', 'script'] as const) {
      const names = entries.filter(([, k]) => k === kind).map(([n]) => (short ? `-${n}` : n));
      if (names.length > 0) parts.push(`${names.join('/')} ${KIND_WORD[kind]}`);
    }
  };
  byKind(Object.entries(rule.values ?? {}), true);
  const longFlags = Object.entries(rule.long ?? {}).filter(([, k]) => k === null).map(([n]) => n);
  if (longFlags.length > 0) parts.push(longFlags.join(' '));
  byKind(Object.entries(rule.long ?? {}), false);
  const predicateFlags = Object.entries(rule.predicates ?? {}).filter(([, k]) => k === null).map(([n]) => n);
  if (predicateFlags.length > 0) parts.push(predicateFlags.join(' '));
  byKind(Object.entries(rule.predicates ?? {}), false);
  return `${name}${parts.length > 0 ? ` ${parts.join('; ')}` : ' (no options)'}`;
}

interface Word {
  /** The word with quotes removed and escapes applied. */
  text: string;
  /** Some part of the word was quoted or escaped. */
  quoted: boolean;
  /** A command substitution (backticks) outside single quotes. `$` forms are caught by the `$` rule. */
  expansion: boolean;
  /** Unquoted brace expansion (`{a,b}`, `{1..3}`) or zsh `=cmd`. */
  braces: boolean;
}

type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: string; fd: string | null };

type Tokenized = { ok: true; tokens: Token[] } | { ok: false; reason: string };

const OPERATOR_START = new Set([';', '&', '|', '(', ')', '<', '>', '\n']);
/** Shell operators, longest first so a longer one wins (`&&` before `&`, `<<<` before `<<`). */
const OPERATORS = ['&>>', '<<<', '<<-', '&&', '||', '|&', ';;', ';&', '&>', '>>', '>|', '>&', '<<', '<>', '<&', '<(', '>(', '|', '&', ';', '(', ')', '<', '>', '\n'];
const REDIRECTS = new Set(['&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '<', '>']);
/** What separates the commands of a pipeline or a list. Every other operator fails closed. */
const SEPARATORS = new Set(['|', '&&', '||', ';', '\n']);

/** Splits a shell command into words and operators, tracking quoting. */
export function tokenizeShell(cmd: string): Tokenized {
  if (cmd.includes('\0')) return { ok: false, reason: 'a NUL byte' };
  if (cmd.includes('\r')) return { ok: false, reason: 'a carriage return' };
  if (cmd.length > 256 * 1024) return { ok: false, reason: 'longer than 256 KiB' };
  const tokens: Token[] = [];
  let cur: Word | null = null;
  const start = (): Word => {
    cur ??= { text: '', quoted: false, expansion: false, braces: false };
    return cur;
  };
  const end = (): void => {
    if (cur) tokens.push({ kind: 'word', word: cur });
    cur = null;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i] ?? '';
    if (c === ' ' || c === '\t') {
      end();
      i++;
      continue;
    }
    if (c === '#' && cur === null) {
      // A comment runs to the end of the line.
      while (i < cmd.length && cmd[i] !== '\n') i++;
      continue;
    }
    if (OPERATOR_START.has(c)) {
      const op = OPERATORS.find((o) => cmd.startsWith(o, i)) ?? c;
      // A run of digits written right before a redirect is its file descriptor (`2>/dev/null`).
      let fd: string | null = null;
      const pending = cur as Word | null;
      if (REDIRECTS.has(op) && pending !== null && !pending.quoted && /^\d+$/.test(pending.text)) {
        fd = pending.text;
        cur = null;
      }
      end();
      tokens.push({ kind: 'op', op, fd });
      i += op.length;
      continue;
    }
    const w = start();
    if (c === '\\') {
      if (i + 1 >= cmd.length) return { ok: false, reason: 'a trailing backslash' };
      const n = cmd[i + 1] ?? '';
      if (n !== '\n') w.text += n;
      w.quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) return { ok: false, reason: 'an unbalanced single quote' };
      w.text += cmd.slice(i + 1, close);
      w.quoted = true;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      w.quoted = true;
      let j = i + 1;
      for (;;) {
        if (j >= cmd.length) return { ok: false, reason: 'an unbalanced double quote' };
        const d = cmd[j] ?? '';
        if (d === '"') break;
        if (d === '\\' && j + 1 < cmd.length) {
          const n = cmd[j + 1] ?? '';
          if (n === '"' || n === '\\' || n === '$' || n === '`') {
            w.text += n;
            j += 2;
            continue;
          }
          if (n === '\n') {
            j += 2;
            continue;
          }
          w.text += d;
          j++;
          continue;
        }
        if (d === '`') w.expansion = true;
        w.text += d;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === "'") return { ok: false, reason: "ANSI-C quoting ($'...')" };
    if (c === '`') w.expansion = true;
    if (c === '=' && w.text === '' && /[A-Za-z_]/.test(cmd[i + 1] ?? '')) w.braces = true; // zsh `=cmd`
    if (c === '{' && /[,]|\.\./.test(braceBody(cmd, i))) w.braces = true;
    w.text += c;
    i++;
  }
  end();
  return { ok: true, tokens };
}

function braceBody(cmd: string, open: number): string {
  const close = cmd.indexOf('}', open);
  return close < 0 ? '' : cmd.slice(open + 1, close);
}

/** Device paths a command may name outside the root. */
const SAFE_DEVICES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);
/** Absolute paths inside a word (quoted code, `--flag=/path`) that start at a well-known top-level directory. */
const EMBEDDED_ABS =
  /(?:^|[^A-Za-z0-9_.~/-])((?:\/(?:Users|home|etc|var|private|root|tmp|opt|usr|System|Library|Volumes|proc|sys|dev|mnt|srv|run|nix|snap|Applications|bin|sbin|cores|net))(?:\/[^\s'"`;|&<>()]*)?)/g;

/** Path-like strings in one word: the word, the value after `=`, and absolute paths embedded in it. */
function candidates(word: Word): string[] {
  const out = new Set<string>();
  if (word.text !== '') out.add(word.text);
  const eq = word.text.indexOf('=');
  if (eq > 0) out.add(word.text.slice(eq + 1));
  for (const m of word.text.matchAll(EMBEDDED_ABS)) if (m[1]) out.add(m[1]);
  return [...out].filter((c) => c !== '');
}

function hasDotDotSegment(path: string): boolean {
  return path.split('/').includes('..');
}

interface Redirect {
  op: string;
  fd: string | null;
  target: Word | null;
}

interface Segment {
  words: Word[];
  redirects: Redirect[];
}

/** `>`-family redirects whose target may be /dev/null. */
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '>&']);

function redirectProblem(r: Redirect): PathProblem | null {
  const shown = `${r.fd ?? ''}${r.op}${r.target?.text ?? ''}`;
  if (r.op === '<<' || r.op === '<<-') return { kind: 'redirect', token: shown, detail: 'a heredoc' };
  if (r.op === '<<<') return { kind: 'redirect', token: shown, detail: 'a here-string' };
  if (r.op.startsWith('<')) return { kind: 'redirect', token: shown, detail: 'an input redirect (name the file as an argument)' };
  if (r.target === null) return { kind: 'syntax', token: shown, detail: 'a redirect with no target' };
  // `2>&1`, `>&2`, `>&-`: a descriptor copy or close opens no file.
  if (r.op === '>&' && !r.target.quoted && /^(?:\d+|-)$/.test(r.target.text)) return null;
  if (OUTPUT_REDIRECTS.has(r.op) && r.target.text === '/dev/null') return null;
  return { kind: 'redirect', token: shown, detail: 'a redirect other than to /dev/null' };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

interface OptionCheck {
  problems: PathProblem[];
  /** Words the command reads as a program, not a path (sed scripts, which sedScriptProblem checks instead). */
  notPaths: Set<Word>;
}

/** A count: digits with an optional sign and size suffix (`-n -5`, `-c 1K`, `-mtime` uses text). */
const NUMBER = /^[+-]?\d+[A-Za-z]{0,3}$/;

/**
 * Parses one allowed command's arguments against its declaration (the command word is not in `args`). Any option
 * not declared fails; every value is checked by its kind, wherever it is written. `pathOf` judges a path value.
 */
function optionProblems(name: string, rule: ReadCommandRule, args: readonly Word[], pathOf: (value: string) => PathProblem[]): OptionCheck {
  const problems: PathProblem[] = [];
  const notPaths = new Set<Word>();
  const scripts: string[] = [];
  const operands: Word[] = [];
  const undeclared = (option: string, why = `is not an option ${name} may take here`): void => {
    problems.push({ kind: 'option', token: option, detail: `${name} ${option} ${why}` });
  };
  /** Checks one value by its kind. `word` is the value's own word when it was written as a separate word. */
  const value = (option: string, kind: ValueKind, text: string | undefined, word: Word | undefined): void => {
    if (text === undefined) {
      undeclared(option, 'needs a value');
      return;
    }
    if (kind === 'path') problems.push(...pathOf(text));
    else if (kind === 'number' && !NUMBER.test(text)) undeclared(option, `takes a number, not ${JSON.stringify(text)}`);
    else if (kind === 'script') {
      scripts.push(text);
      if (word) notPaths.add(word);
    }
  };
  let endOfOptions = false;
  for (let k = 0; k < args.length; k++) {
    const word = args[k] as Word;
    const a = word.text;
    if (rule.predicates) {
      // find: expression words are whole words; a single-letter word may be one of its leading flags.
      if (Object.hasOwn(rule.predicates, a)) {
        const kind = rule.predicates[a];
        if (kind !== null && kind !== undefined) {
          const next = args[++k];
          value(a, kind, next?.text, next);
        }
      } else if (a.startsWith('-') && a !== '-') {
        if (!(a.length === 2 && rule.flags.includes(a[1] ?? ''))) undeclared(a);
      } else {
        operands.push(word);
      }
      continue;
    }
    if (endOfOptions || a === '-' || !a.startsWith('-')) {
      operands.push(word);
      continue;
    }
    if (a === '--') {
      endOfOptions = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const long = eq < 0 ? a : a.slice(0, eq);
      if (rule.long === undefined || !Object.hasOwn(rule.long, long)) {
        undeclared(long, `is not an option ${name} may take here (long options must be spelled in full)`);
        continue;
      }
      const kind = rule.long[long];
      if (kind === null || kind === undefined) {
        if (eq >= 0) undeclared(long, 'takes no value');
        continue;
      }
      if (eq >= 0) {
        value(long, kind, a.slice(eq + 1), kind === 'script' ? word : undefined);
      } else {
        const next = args[++k];
        value(long, kind, next?.text, next);
      }
      continue;
    }
    if (rule.countOption && /^-\d+$/.test(a)) continue;
    for (let j = 1; j < a.length; j++) {
      const flag = a[j] ?? '';
      if (rule.flags.includes(flag)) continue;
      const kind = rule.values !== undefined && Object.hasOwn(rule.values, flag) ? rule.values[flag] : undefined;
      if (kind === undefined) {
        undeclared(`-${flag}`);
        break;
      }
      if (j < a.length - 1) {
        // An attached value (`-f/etc/x`, `-nf/etc/x`): the rest of the word is the value.
        value(`-${flag}`, kind, a.slice(j + 1), kind === 'script' ? word : undefined);
      } else {
        const next = args[++k];
        value(`-${flag}`, kind, next?.text, next);
      }
      break;
    }
  }
  if (name === 'sed') {
    // With no -e or --expression, the first operand is the script.
    if (scripts.length === 0) {
      const script = operands.shift();
      if (script === undefined) {
        undeclared('', 'with no script');
      } else {
        scripts.push(script.text);
        notPaths.add(script);
      }
    }
    for (const script of scripts) {
      const problem = sedScriptProblem(script);
      if (problem !== null) problems.push({ kind: 'option', token: script.slice(0, 120), detail: `sed script: ${problem}` });
    }
  }
  if (rule.maxOperands !== undefined && operands.length > rule.maxOperands) {
    problems.push({ kind: 'option', token: name, detail: `${name} with more than ${rule.maxOperands} operand (${rule.also ?? 'an extra operand'})` });
  }
  return { problems, notPaths };
}

/** sed commands that only print, move or hold text. `q`, `Q` and `l` may take a number. */
const SED_PLAIN = 'pPdDqQ=lnNhHgGxzF';

/**
 * Checks a sed script and returns why it is refused, or null. A small parser of the GNU and BSD grammar that fails
 * closed: only the plain commands above, `s` (no `e` or `w` flag) and `y`, with numeric, `$` and `/regex/`
 * addresses. `e`, `w`, `W`, `r` and `R` run a command or touch a file. Text and branch commands, custom regex
 * delimiters and bracket expressions in a regex (where GNU and BSD find the closing delimiter differently) are
 * refused too.
 */
export function sedScriptProblem(script: string): string | null {
  const s = script;
  let i = 0;
  let depth = 0;
  const blanks = (): void => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  /** Reads up to an unescaped delimiter; `i` starts after the opening one and ends after the closing one. */
  const delimited = (delim: string, regex: boolean): string | null => {
    for (;;) {
      const c = s[i];
      if (c === undefined) return 'an unterminated regex or replacement';
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === delim) {
        i++;
        return null;
      }
      if (regex && c === '[') return 'a bracket expression in a regex';
      if (regex && c === '\n') return 'a line break in a regex';
      i++;
    }
  };
  /** Reads one address: 'none' when there is none, else a problem or null. */
  const address = (): string | null => {
    const c = s[i] ?? '';
    if (/\d/.test(c)) {
      while (/\d/.test(s[i] ?? '')) i++;
      if (s[i] === '~') {
        i++;
        while (/\d/.test(s[i] ?? '')) i++;
      }
      return null;
    }
    if (c === '$') {
      i++;
      return null;
    }
    if (c === '/') {
      i++;
      const problem = delimited('/', true);
      if (problem !== null) return problem;
      while (s[i] === 'I' || s[i] === 'M') i++;
      return null;
    }
    if (c === '\\') return 'a regex address with a custom delimiter';
    return 'none';
  };
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t' || s[i] === ';' || s[i] === '\n') i++;
    if (i >= s.length) break;
    if (s[i] === '#') {
      while (i < s.length && s[i] !== '\n') i++;
      continue;
    }
    if (s[i] === '}') {
      depth--;
      if (depth < 0) return 'an unmatched }';
      i++;
      continue;
    }
    const first = address();
    if (first !== null && first !== 'none') return first;
    if (first === null && s[i] === ',') {
      i++;
      blanks();
      if (s[i] === '+' || s[i] === '~') {
        i++;
        if (!/\d/.test(s[i] ?? '')) return 'a range step with no number';
        while (/\d/.test(s[i] ?? '')) i++;
      } else {
        const second = address();
        if (second === 'none') return 'a range with no end';
        if (second !== null) return second;
      }
    }
    blanks();
    while (s[i] === '!') {
      i++;
      blanks();
    }
    const cmd = s[i];
    if (cmd === undefined) return 'an address with no command';
    i++;
    if (cmd === '{') {
      depth++;
      continue;
    }
    if ('ewWrR'.includes(cmd)) return `the ${cmd} command (${cmd === 'e' ? 'runs a command' : 'reads or writes a file'})`;
    if (SED_PLAIN.includes(cmd)) {
      if ('qQl'.includes(cmd)) {
        blanks();
        while (/\d/.test(s[i] ?? '')) i++;
      }
    } else if (cmd === 's' || cmd === 'y') {
      const delim = s[i];
      if (delim === undefined || delim === '\n' || delim === '\\') return `a ${cmd} command with no usable delimiter`;
      i++;
      const pattern = delimited(delim, true);
      if (pattern !== null) return pattern;
      const replacement = delimited(delim, false);
      if (replacement !== null) return replacement;
      if (cmd === 's') {
        while (/[gpiImM0-9]/.test(s[i] ?? '')) i++;
        if (s[i] === 'e') return 'the s///e flag (runs the pattern space as a command)';
        if (s[i] === 'w' || s[i] === 'W') return 'the s///w flag (writes a file)';
      }
    } else {
      return `the ${cmd} command (only printing commands, s and y are allowed)`;
    }
    blanks();
    const next = s[i];
    if (next !== undefined && next !== ';' && next !== '\n' && next !== '}' && next !== '#') return `text after the ${cmd} command`;
  }
  return depth === 0 ? null : 'an unclosed {';
}

/** Splits the tokens into segments (one simple command each) and reports the operators that are refused. */
function segmentsOf(tokens: readonly Token[], problems: PathProblem[]): Segment[] {
  const segments: Segment[] = [];
  let seg: Segment = { words: [], redirects: [] };
  const flush = (): void => {
    if (seg.words.length > 0 || seg.redirects.length > 0) segments.push(seg);
    seg = { words: [], redirects: [] };
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.kind === 'word') {
      seg.words.push(t.word);
      continue;
    }
    if (SEPARATORS.has(t.op)) {
      flush();
      continue;
    }
    if (REDIRECTS.has(t.op)) {
      const next = tokens[k + 1];
      const target = next?.kind === 'word' ? next.word : null;
      if (target) k++;
      seg.redirects.push({ op: t.op, fd: t.fd, target });
      continue;
    }
    const what =
      t.op === '&'
        ? 'a background job'
        : t.op === '(' || t.op === ')'
          ? 'a subshell or glob qualifier'
          : t.op === '<(' || t.op === '>('
            ? 'process substitution'
            : `the ${JSON.stringify(t.op)} operator`;
    problems.push({ kind: 'syntax', token: t.op, detail: what });
  }
  flush();
  return segments;
}

/** The `~`, `$` and expansion rules for one word, then the path rules unless the word is not a path. */
function wordProblems(word: Word, cwd: string, aliases: readonly string[], changedDir: boolean, isPath = true): PathProblem[] {
  // After quote removal a `~` or `$` may still reach a shell or an expansion: fail closed.
  if (word.text.includes('~')) return [{ kind: 'home', token: word.text, detail: 'a ~ in a word (it can name the home directory)' }];
  if (word.text.includes('$')) return [{ kind: 'expansion', token: word.text, detail: 'a $ in a word (a shell expansion the ratifier cannot resolve)' }];
  if (word.expansion) return [{ kind: 'expansion', token: word.text, detail: 'a command substitution (backticks)' }];
  if (word.braces) return [{ kind: 'expansion', token: word.text, detail: 'brace or = expansion the ratifier cannot resolve' }];
  if (!isPath) return [];
  const problems: PathProblem[] = [];
  for (const candidate of candidates(word)) {
    if (candidate.startsWith('/')) {
      const abs = posix.normalize(candidate);
      if (SAFE_DEVICES.has(abs) || /^\/dev\/fd\/\d+$/.test(abs)) continue;
      const judged = pathInsideRoot(abs, cwd, aliases);
      if (!judged.inside) problems.push({ kind: 'outside-root', token: candidate, detail: `absolute path outside the root (${judged.why})` });
      continue;
    }
    // After a workdir, the ratifier's idea of the working directory may be wrong, so any climb fails.
    if (changedDir && hasDotDotSegment(candidate)) {
      problems.push({ kind: 'cd', token: candidate, detail: 'a relative path that climbs (..) after workdir' });
      continue;
    }
    // Lexically, then by realpath when the path exists (a link in the root that points out).
    const judged = pathInsideRoot(candidate, cwd, aliases);
    if (!judged.inside) problems.push({ kind: 'outside-root', token: candidate, detail: `${judged.why} (${judged.resolved})` });
  }
  return problems;
}

/**
 * Checks one command string. `root` is the leg's cwd; `aliases` are every spelling of the root (see
 * `rootAliases`). Returns every problem found; an empty list means the command is a read that stays in the root.
 */
export function checkCommandPaths(cmd: string, root: string, aliases: readonly string[], options: { workdir?: string | undefined } = {}): PathProblem[] {
  const tokens = tokenizeShell(cmd);
  if (!tokens.ok) return [{ kind: 'untokenizable', token: cmd.slice(0, 200), detail: `cannot tokenize: ${tokens.reason}` }];
  const problems: PathProblem[] = [];
  let cwd = posix.normalize(root);
  let changedDir = false;
  if (options.workdir !== undefined) {
    // exec_command's `workdir` acts as a cd before the command (N17).
    const w = options.workdir;
    if (w.startsWith('~') || w.includes('$')) return [{ kind: 'home', token: w, detail: 'workdir names the home directory or an expansion' }];
    const next = posix.normalize(w.startsWith('/') ? w : posix.join(cwd, w));
    if (!underRoot(next, aliases)) return [{ kind: 'outside-root', token: w, detail: `workdir leaves the root (${next})` }];
    changedDir = next !== cwd;
    cwd = next;
  }
  for (const seg of segmentsOf(tokens.tokens, problems)) {
    for (const r of seg.redirects) {
      const problem = redirectProblem(r);
      if (problem) problems.push(problem);
    }
    const words = [...seg.words];
    while (words.length > 0 && ASSIGNMENT.test((words[0] as Word).text)) {
      const assignment = words.shift() as Word;
      problems.push({ kind: 'command', token: assignment.text, detail: 'an environment assignment before the command' });
      problems.push(...wordProblems(assignment, cwd, aliases, changedDir));
    }
    const command = words[0];
    if (command === undefined) {
      // zsh runs $NULLCMD (cat) for a redirect with no command.
      if (seg.redirects.length > 0) problems.push({ kind: 'syntax', token: seg.redirects.map((r) => r.op).join(' '), detail: 'a redirect with no command' });
      continue;
    }
    const rule = Object.hasOwn(READ_COMMANDS, command.text) ? READ_COMMANDS[command.text] : undefined;
    let notPaths = new Set<Word>();
    if (rule === undefined) {
      problems.push({ kind: 'command', token: command.text, detail: `${command.text} is not one of the read commands (${READ_COMMAND_NAMES.join(', ')})` });
    } else {
      const options = optionProblems(command.text, rule, words.slice(1), (value) =>
        wordProblems({ text: value, quoted: true, expansion: false, braces: false }, cwd, aliases, changedDir),
      );
      problems.push(...options.problems);
      notPaths = options.notPaths;
    }
    for (const word of words) problems.push(...wordProblems(word, cwd, aliases, changedDir, !notPaths.has(word)));
  }
  // A path value written as its own word is judged twice (as a value and as a word); report it once.
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.kind}\u0000${p.token}\u0000${p.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Output of a command that a read-only sandbox denied a write (N15). Seatbelt, Landlock and bwrap spellings. */
export const WRITE_DENIAL = /operation not permitted|read-only file system|\bEROFS\b|permission denied/i;
