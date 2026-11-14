import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookCommand } from './launch.js';

/*
 * The adjudicator's PreToolUse hook (plan 6.4): a second line beside `--restricted` and the settings key. Claude Code
 * runs it before every tool call, with the call as JSON on stdin; it re-checks every file path by realpath against
 * the working copy and denies the call (exit 0 with a `permissionDecision: "deny"`) when:
 *
 *   - the tool is not Read, Glob, Grep or Edit (a tool that reached the run past the init gate never executes);
 *   - the session's cwd is not the working copy;
 *   - a path names the home directory (`~`), climbs (`..` anywhere in a glob), resolves outside the copy, or is a
 *     link that does not resolve;
 *   - an Edit targets anything outside `_mainloop/`;
 *   - anything in the hook itself fails (fail closed).
 *
 * Every decision is appended to a log in the run dir, outside the copy: the record that the hook ran on every call.
 * The script is standalone (Node built-ins only), so it runs whatever the engine was installed from. `--bare` skips
 * hooks, so a `--bare` run has none (the API-key route).
 */

export const HOOK_SOURCE = String.raw`// sabotage-council: the headless adjudicator's PreToolUse hook (generated; plan 6.4).
import { appendFileSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

const [rootArg, log] = process.argv.slice(2);
const ALLOWED = ['Read', 'Glob', 'Grep', 'Edit'];
const OUT = '_mainloop';

function realish(p) {
  // The realpath of the longest existing prefix, with the rest appended (a path the tool would create).
  const rest = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      let link = false;
      try {
        link = lstatSync(cur).isSymbolicLink();
      } catch {
        link = false;
      }
      if (link) throw new Error('a link that does not resolve: ' + cur);
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.unshift(basename(cur));
      cur = parent;
    }
  }
}

function within(base, p) {
  return p === base || p.startsWith(base + sep);
}

function decide(input, root) {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!ALLOWED.includes(tool)) return { deny: 'tool ' + tool + ' is not Read, Glob, Grep or Edit', paths: [] };
  const cwd = typeof input.cwd === 'string' ? input.cwd : root;
  if (realish(resolve(cwd)) !== root) return { deny: 'the session cwd ' + cwd + ' is not the working copy', paths: [] };
  const ti = input.tool_input !== null && typeof input.tool_input === 'object' ? input.tool_input : {};
  const checks = [];
  const field = (name) => (typeof ti[name] === 'string' && ti[name] !== '' ? ti[name] : null);
  if (tool === 'Read' || tool === 'Edit') {
    const p = field('file_path');
    if (p === null) return { deny: tool + ' names no file_path', paths: [] };
    checks.push({ path: p, kind: 'path' });
  }
  if (tool === 'Glob' || tool === 'Grep') {
    const base = field('path');
    if (base !== null) checks.push({ path: base, kind: 'path' });
    const pattern = field(tool === 'Glob' ? 'pattern' : 'glob');
    if (pattern !== null) checks.push({ path: pattern, kind: 'glob', base: base ?? root });
  }
  const paths = checks.map((c) => c.path);
  for (const c of checks) {
    if (c.path.startsWith('~')) return { deny: c.path + ' names the home directory', paths };
    let target = c.path;
    if (c.kind === 'glob') {
      if (c.path.includes('..')) return { deny: 'the pattern ' + c.path + ' climbs (..)', paths };
      const meta = c.path.search(/[*?[{]/);
      const literal = meta < 0 ? c.path : c.path.slice(0, meta);
      target = isAbsolute(literal) ? literal : join(isAbsolute(c.base) ? c.base : join(root, c.base), literal);
    }
    const abs = resolve(root, target);
    const real = realish(abs);
    if (!within(root, real)) return { deny: c.path + ' resolves outside the working copy (' + real + ')', paths };
    if (tool === 'Edit' && !within(join(root, OUT), real)) return { deny: 'Edit is allowed only under ' + OUT + '/, not ' + c.path, paths };
  }
  return { deny: null, paths };
}

let decision = { deny: 'the hook could not read its input', paths: [] };
let input = {};
try {
  const root = realpathSync(rootArg);
  input = JSON.parse(readFileSync(0, 'utf8'));
  decision = decide(input, root);
} catch (error) {
  decision = { deny: 'the hook failed closed: ' + (error && error.message ? error.message : String(error)), paths: decision.paths };
}
try {
  appendFileSync(
    log,
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: input.tool_name ?? null,
      tool_use_id: input.tool_use_id ?? null,
      paths: decision.paths,
      decision: decision.deny === null ? 'allow' : 'deny',
      reason: decision.deny,
    }) + '\n',
  );
} catch {
  // The log is evidence, not the gate: a failed write still decides below (ratification notices the gap).
}
if (decision.deny !== null) {
  try {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.deny } }) + '\n');
  } catch {
    process.stderr.write(decision.deny + '\n');
    process.exit(2);
  }
}
process.exit(0);
`;

/** Single-quotes one word for `sh`. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

export interface WrittenHook extends HookCommand {
  script: string;
  log: string;
}

/**
 * Writes the hook script into the run dir (outside the working copy) and returns the command that runs it with
 * the working copy and the log path as its arguments. `node` is the engine's own Node binary.
 */
export function writeHook(runDir: string, workRoot: string, node: string = process.execPath): WrittenHook {
  const script = join(runDir, 'pretooluse-hook.mjs');
  const log = join(runDir, 'hook.log');
  writeFileSync(script, HOOK_SOURCE, { mode: 0o600 });
  writeFileSync(log, '', { mode: 0o600 });
  return { script, log, command: [node, script, workRoot, log].map(shellQuote).join(' ') };
}
