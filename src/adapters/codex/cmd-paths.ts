import { posix } from 'node:path';
import { underRoot } from '../paths.js';

/*
 * The outside-root check on codex command strings (plan 4.2, 4.5, N17). It is lexical: paths are parsed from
 * the `cmd` string, because there is no argv field. It fails closed on what it cannot resolve statically:
 * `$HOME` and every other expansion, `$(...)` and backticks, `~`, brace expansion, `cd` followed by a relative
 * path that climbs, and a command it cannot tokenize. It stays a backstop: codex reads are declared unconfined
 * (label `sandboxed-exec`).
 */

export type PathProblemKind = 'outside-root' | 'home' | 'expansion' | 'cd' | 'untokenizable';

export interface PathProblem {
  kind: PathProblemKind;
  token: string;
  detail: string;
}

interface Word {
  /** The word with quotes removed and escapes applied. */
  text: string;
  /** An unquoted `~` starts the word. */
  tilde: boolean;
  /** A `$` expansion, command substitution or backtick appears outside single quotes. */
  expansion: boolean;
  /** Unquoted brace expansion (`{a,b}`, `{1..3}`) or zsh `=cmd`. */
  braces: boolean;
  /** Unquoted glob characters. */
  glob: boolean;
  /** First word of a simple command. */
  commandWord: boolean;
}

type Tokenized = { ok: true; words: Word[] } | { ok: false; reason: string };

const OPERATOR_CHARS = new Set([';', '&', '|', '(', ')', '<', '>', '\n']);

/** Splits a shell command into words, tracking quoting. Operators separate words and start new commands. */
export function tokenizeShell(cmd: string): Tokenized {
  if (cmd.includes('\0')) return { ok: false, reason: 'a NUL byte' };
  if (cmd.length > 256 * 1024) return { ok: false, reason: 'longer than 256 KiB' };
  const words: Word[] = [];
  let cur: Word | null = null;
  let nextIsCommand = true;
  const start = (): Word => {
    if (!cur) {
      cur = { text: '', tilde: false, expansion: false, braces: false, glob: false, commandWord: nextIsCommand };
      nextIsCommand = false;
    }
    return cur;
  };
  const end = (): void => {
    if (cur) words.push(cur);
    cur = null;
  };
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i] ?? '';
    if (c === ' ' || c === '\t' || c === '\r') {
      end();
      i++;
      continue;
    }
    if (c === '#' && cur === null) {
      // A comment runs to the end of the line.
      while (i < cmd.length && cmd[i] !== '\n') i++;
      continue;
    }
    if (OPERATOR_CHARS.has(c)) {
      end();
      // A redirection keeps the command going; the others start a new command.
      if (c !== '<' && c !== '>') nextIsCommand = true;
      // `2>`, `&>`, `>>`, `<<` and friends: consume the operator run.
      while (i < cmd.length && OPERATOR_CHARS.has(cmd[i] ?? '') && cmd[i] !== '\n') i++;
      if (c === '\n') i++;
      continue;
    }
    const w = start();
    if (c === '\\') {
      if (i + 1 >= cmd.length) return { ok: false, reason: 'a trailing backslash' };
      const n = cmd[i + 1] ?? '';
      if (n !== '\n') w.text += n;
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = cmd.indexOf("'", i + 1);
      if (close < 0) return { ok: false, reason: 'an unbalanced single quote' };
      w.text += cmd.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
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
        if (d === '`' || (d === '$' && /[A-Za-z_{(0-9@*#?$!-]/.test(cmd[j + 1] ?? ''))) w.expansion = true;
        w.text += d;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const n = cmd[i + 1] ?? '';
      if (n === "'") return { ok: false, reason: "ANSI-C quoting ($'...')" };
      if (/[A-Za-z_{(0-9@*#?$!-]/.test(n)) w.expansion = true;
      w.text += c;
      i++;
      continue;
    }
    if (c === '`') {
      w.expansion = true;
      w.text += c;
      i++;
      continue;
    }
    if (c === '~' && w.text === '') w.tilde = true;
    if (c === '=' && w.text === '' && /[A-Za-z_]/.test(cmd[i + 1] ?? '')) w.braces = true; // zsh `=cmd`
    if (c === '{' && /[,]|\.\./.test(braceBody(cmd, i))) w.braces = true;
    if (c === '*' || c === '?' || c === '[') w.glob = true;
    w.text += c;
    i++;
  }
  end();
  return { ok: true, words };
}

function braceBody(cmd: string, open: number): string {
  const close = cmd.indexOf('}', open);
  return close < 0 ? '' : cmd.slice(open + 1, close);
}

/** Device paths a command may name outside the root. */
const SAFE_DEVICES = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);
/** System binary directories: an absolute command word here runs a tool, it does not read data. */
const SYSTEM_BIN = ['/bin/', '/usr/bin/', '/usr/local/bin/', '/opt/homebrew/bin/', '/sbin/', '/usr/sbin/'];
/** Absolute paths inside a word (quoted code, `--flag=/path`) that start at a well-known top-level directory. */
const EMBEDDED_ABS =
  /(?:^|[^A-Za-z0-9_.~/-])((?:\/(?:Users|home|etc|var|private|root|tmp|opt|usr|System|Library|Volumes|proc|sys|dev|mnt|srv|run|nix|snap|Applications|bin|sbin|cores|net))(?:\/[^\s'"`;|&<>()]*)?)/g;

function isSafeAbsolute(path: string, commandWord: boolean): boolean {
  if (SAFE_DEVICES.has(path) || /^\/dev\/fd\/\d+$/.test(path)) return true;
  return commandWord && SYSTEM_BIN.some((dir) => path.startsWith(dir) && !path.slice(dir.length).includes('/'));
}

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

/**
 * Checks one command string. `root` is the leg's cwd; `aliases` are every spelling of the root (see
 * `rootAliases`). Returns every problem found; an empty list means no path token leaves the root.
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
    cwd = next;
    changedDir = true;
  }
  const words = tokens.words;
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as Word;
    if (word.expansion) {
      problems.push({ kind: 'expansion', token: word.text, detail: 'a shell expansion the ratifier cannot resolve ($VAR, $(...), backticks)' });
      continue;
    }
    if (word.braces) {
      problems.push({ kind: 'expansion', token: word.text, detail: 'brace or = expansion the ratifier cannot resolve' });
      continue;
    }
    if (word.commandWord && (word.text === 'cd' || word.text === 'pushd' || word.text === 'popd' || word.text === 'chdir')) {
      changedDir = true;
      const target = words[i + 1];
      if (word.text === 'popd' || target === undefined || target.commandWord || target.text === '-' || target.text === '') {
        problems.push({ kind: 'cd', token: word.text, detail: `${word.text} to a directory the ratifier cannot resolve` });
        continue;
      }
      if (target.expansion || target.tilde || target.braces) continue; // reported when the loop reaches it
      const next = posix.normalize(target.text.startsWith('/') ? target.text : posix.join(cwd, target.text));
      if (!underRoot(next, aliases)) {
        problems.push({ kind: 'outside-root', token: target.text, detail: `${word.text} leaves the root (${next})` });
      } else {
        cwd = next;
      }
      i++;
      continue;
    }
    for (const candidate of candidates(word)) {
      if (candidate.startsWith('/')) {
        const abs = posix.normalize(candidate);
        if (underRoot(abs, aliases) || isSafeAbsolute(abs, word.commandWord && candidate === word.text)) continue;
        problems.push({ kind: 'outside-root', token: candidate, detail: `absolute path outside the root${word.glob ? ' (glob)' : ''}` });
        continue;
      }
      if (candidate.startsWith('~')) {
        problems.push({ kind: 'home', token: candidate, detail: '~ names the home directory' });
        continue;
      }
      if (!hasDotDotSegment(candidate)) continue;
      // After a cd, the ratifier's idea of the working directory may be wrong (subshells), so any climb fails.
      if (changedDir) {
        problems.push({ kind: 'cd', token: candidate, detail: 'a relative path that climbs (..) after cd' });
        continue;
      }
      const resolved = posix.normalize(posix.join(cwd, candidate));
      if (!underRoot(resolved, aliases)) {
        problems.push({ kind: 'outside-root', token: candidate, detail: `resolves outside the root (${resolved})${word.glob ? ' (glob)' : ''}` });
      }
    }
  }
  return problems;
}

/** Output of a command that a read-only sandbox denied a write (N15). Seatbelt, Landlock and bwrap spellings. */
export const WRITE_DENIAL = /operation not permitted|read-only file system|\bEROFS\b|permission denied/i;
