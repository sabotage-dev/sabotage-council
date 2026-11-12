import { posix } from 'node:path';
import { pathInsideRoot, underRoot } from '../paths.js';

/*
 * The command check on codex command strings (plan 4.2, 4.5, N17, round 1 fold). Codex reads are declared
 * unconfined (label `sandboxed-exec`), so this check is what keeps a codex leg's reads inside the root. It is
 * lexical: the `cmd` string is parsed, because there is no argv field.
 *
 * A command passes only when every pipeline segment (split on `|`, `&&`, `||`, `;` and newlines) runs one of the
 * read commands in READ_COMMANDS with none of its refused options, and every word stays inside the root. It fails
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

/** How one read command is checked. The read preface (launch.ts) is built from the same data. */
export interface ReadCommandRule {
  /**
   * Options refused outright. `-x` is a short flag, also inside a cluster such as `-nx`; `--name` also refuses
   * `--name=...`. For `find` (predicates), each entry is a whole predicate word.
   */
  refused: readonly string[];
  /** Short flags that take a value: the rest of the cluster, or the next word. */
  shortValues?: string;
  /** Refused entries are whole predicate words (find). */
  predicates?: boolean;
  /** At most this many operands (uniq: one input, never an output file). */
  maxOperands?: number;
  /** A refusal that is not an option, for the preface. */
  also?: string;
}

/**
 * The read commands a codex leg may run, in preface order. Measured: real codex council legs use sed, nl, rg, cat,
 * pwd, head, wc, tail, ls, diff and find. The refused options run a program, write a file, or read a list of file
 * names the command line does not show.
 */
export const READ_COMMANDS: Readonly<Record<string, ReadCommandRule>> = {
  rg: { refused: ['--pre', '--pre-glob', '-z', '--search-zip', '--hostname-bin'], shortValues: 'ABCdEefgjMmrtT' },
  grep: { refused: [] },
  sed: { refused: ['-i', '-I', '--in-place', '-f', '--file'], also: 'a script with an e, w, W, r or R command' },
  nl: { refused: [] },
  cat: { refused: [] },
  head: { refused: [] },
  tail: { refused: [] },
  wc: { refused: ['--files0-from'] },
  ls: { refused: [] },
  pwd: { refused: [] },
  find: {
    refused: ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '-files0-from'],
    predicates: true,
  },
  diff: { refused: [] },
  sort: { refused: ['-o', '--output', '--compress-program', '--files0-from'], shortValues: 'ktST' },
  uniq: { refused: [], shortValues: 'fsw', maxOperands: 1, also: 'an output file operand' },
  cut: { refused: [] },
  tr: { refused: [] },
  stat: { refused: [] },
  file: { refused: ['-f', '--files-from'] },
};

export const READ_COMMAND_NAMES: readonly string[] = Object.keys(READ_COMMANDS);

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

/** Option problems for one allowed command (the command word is not in `args`). */
function optionProblems(name: string, rule: ReadCommandRule, args: readonly Word[]): OptionCheck {
  if (name === 'sed') return sedProblems(args);
  const out: PathProblem[] = [];
  const refuse = (token: string): void => {
    out.push({ kind: 'option', token, detail: `${name} ${token} is refused (it runs a program, writes a file or reads a hidden file list)` });
  };
  let operands = 0;
  let endOfOptions = false;
  for (let k = 0; k < args.length; k++) {
    const a = (args[k] as Word).text;
    if (rule.predicates) {
      if (rule.refused.includes(a)) refuse(a);
      continue;
    }
    if (endOfOptions || !a.startsWith('-') || a === '-') {
      operands++;
      continue;
    }
    if (a === '--') {
      endOfOptions = true;
      continue;
    }
    if (a.startsWith('--')) {
      const long = a.split('=', 1)[0] ?? a;
      if (rule.refused.includes(long)) refuse(long);
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const flag = a[j] ?? '';
      if (rule.refused.includes(`-${flag}`)) {
        refuse(`-${flag}`);
        break;
      }
      if (rule.shortValues?.includes(flag)) {
        if (j === a.length - 1) k++; // the value is the next word
        break;
      }
    }
  }
  if (rule.maxOperands !== undefined && operands > rule.maxOperands) {
    out.push({ kind: 'option', token: name, detail: `${name} with more than ${rule.maxOperands} operand (${rule.also ?? 'an extra operand'})` });
  }
  return { problems: out, notPaths: new Set() };
}

/** sed flags that take no value, and the long options that are only flags. */
const SED_SHORT_FLAGS = 'nErsuz';
const SED_LONG_FLAGS = ['--quiet', '--silent', '--regexp-extended', '--separate', '--unbuffered', '--null-data', '--posix', '--debug', '--sandbox'];

function sedProblems(args: readonly Word[]): OptionCheck {
  const out: PathProblem[] = [];
  const refuse = (token: string, why = 'is refused'): void => {
    out.push({ kind: 'option', token, detail: `sed ${token} ${why}`.replace(/\s+/g, ' ') });
  };
  const scripts: Array<{ text: string; word: Word | undefined }> = [];
  const operands: Word[] = [];
  let endOfOptions = false;
  for (let k = 0; k < args.length; k++) {
    const word = args[k] as Word;
    const a = word.text;
    if (endOfOptions || !a.startsWith('-') || a === '-') {
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
      if (long === '--expression') {
        const value = eq < 0 ? args[++k] : word;
        scripts.push({ text: eq < 0 ? (value?.text ?? '') : a.slice(eq + 1), word: value });
      } else if (long === '--line-length') {
        if (eq < 0) k++;
      } else if (!(eq < 0 && SED_LONG_FLAGS.includes(long))) {
        refuse(long);
      }
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const flag = a[j] ?? '';
      if (flag === 'e') {
        const value = j < a.length - 1 ? word : args[++k];
        scripts.push({ text: j < a.length - 1 ? a.slice(j + 1) : (value?.text ?? ''), word: value });
        break;
      }
      if (flag === 'l') {
        if (j === a.length - 1) k++;
        break;
      }
      if (!SED_SHORT_FLAGS.includes(flag)) {
        refuse(`-${flag}`);
        break;
      }
    }
  }
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) refuse('', 'with no script');
    else scripts.push({ text: script.text, word: script });
  }
  const notPaths = new Set<Word>();
  for (const script of scripts) {
    if (script.word) notPaths.add(script.word);
    const problem = sedScriptProblem(script.text);
    if (problem !== null) out.push({ kind: 'option', token: script.text.slice(0, 120), detail: `sed script: ${problem}` });
  }
  return { problems: out, notPaths };
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
      const options = optionProblems(command.text, rule, words.slice(1));
      problems.push(...options.problems);
      notPaths = options.notPaths;
    }
    for (const word of words) problems.push(...wordProblems(word, cwd, aliases, changedDir, !notPaths.has(word)));
  }
  return problems;
}

/** Output of a command that a read-only sandbox denied a write (N15). Seatbelt, Landlock and bwrap spellings. */
export const WRITE_DENIAL = /operation not permitted|read-only file system|\bEROFS\b|permission denied/i;
