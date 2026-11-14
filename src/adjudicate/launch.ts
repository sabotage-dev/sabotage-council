import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { offeredTools } from '../adapters/claude/ratify.js';
import type { ClaudeVersionDecl } from '../adapters/claude/known.js';
import { isObject, str, type Json } from '../adapters/codex/records.js';

/*
 * The headless adjudicator's command line, settings and init gate (plan 6.4). The engine runs the user's unmodified
 * `claude` binary (6.5) as `claude -p`, read-only except for one output file:
 *
 *   - `--restricted`: no code-running tools, file tools confined to the working directory, user, project and local
 *     settings files ignored (so an installed plugin, a user hook or a user allow rule never loads);
 *   - `--permission-mode dontAsk` and `--permission-prompts none`: a pinned mode, nothing waits for a prompt;
 *   - `--tools Read,Glob,Grep,Edit` and `--allowedTools Read Glob Grep "Edit(./_mainloop/**)"`: the only write is an
 *     Edit under `_mainloop/`, where the placeholder output file already exists;
 *   - `--strict-mcp-config` with no `--mcp-config`: no MCP server;
 *   - `--setting-sources ""` from the version's declaration, as for a Claude seat (measured in P2: any set without
 *     `user` drops installed-plugin tools and user hooks; defence in depth beside `--restricted`);
 *   - `--settings <run dir>/settings.json`: `permissions.blockReadsOutsideWorkingDirectories` and the PreToolUse
 *     realpath hook (hook.ts). With `ANTHROPIC_API_KEY` the run is `--bare`, which skips hooks, so the settings carry
 *     only the key and the path check is `--restricted` plus the key.
 *
 * The prompt goes on stdin (measured on 2.1.322: a positional prompt after the variadic `--disallowedTools` list is
 * read as one more tool name).
 */

/** The only tools the adjudicator may be offered or use (plan 6.4). */
export const ADJUDICATOR_TOOLS = ['Read', 'Glob', 'Grep', 'Edit'] as const;

/** The output dir inside the working copy: the only place the adjudicator may edit. */
export const MAINLOOP_DIR = '_mainloop';
/** The engine's inputs inside the working copy: readable, never editable. */
export const COUNCIL_DIR = '_council';
/** The output file, relative to the working copy. */
export const OUTPUT_FILE = `${MAINLOOP_DIR}/ADJUDICATION.json`;
/** What the placeholder output file holds before the run: one Edit replaces it with the whole document. */
export const OUTPUT_PLACEHOLDER = '{}\n';

/** The one write rule (plan 6.4): Edit below `_mainloop/`, relative to the working directory. */
export const EDIT_RULE = `Edit(./${MAINLOOP_DIR}/**)`;

export interface AdjudicatorArgsInput {
  model: string;
  effort: string;
  sessionId: string;
  settingsFile: string;
  decl: ClaudeVersionDecl;
  /** `ANTHROPIC_API_KEY` is set: `--bare` (no plugins, user hooks or CLAUDE.md discovery, and no hook of ours). */
  bare: boolean;
  maxTurns?: number | undefined;
}

export function adjudicatorArgs(input: AdjudicatorArgsInput): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    input.model,
    '--effort',
    input.effort,
    '--restricted',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--tools',
    ADJUDICATOR_TOOLS.join(','),
    '--strict-mcp-config',
    '--setting-sources',
    input.decl.settingSources,
    '--settings',
    input.settingsFile,
    '--session-id',
    input.sessionId,
  ];
  if (input.bare) args.push('--bare');
  if (input.maxTurns !== undefined) args.push('--max-turns', String(input.maxTurns));
  // The variadic lists go last; nothing positional follows them (the prompt is on stdin).
  const denied = input.decl.nonReadBuiltins.filter((t) => t !== 'Edit');
  args.push('--allowedTools', 'Read', 'Glob', 'Grep', EDIT_RULE, '--disallowedTools', ...denied);
  return args;
}

/** One PreToolUse hook command (hook.ts), run on every tool call before it executes. */
export interface HookCommand {
  /** The full shell command line Claude Code runs. */
  command: string;
}

/**
 * The run's settings JSON. Without `--bare` it carries the PreToolUse hook on every tool (`*`); with `--bare`
 * hooks are skipped by the CLI, so none is written (plan 6.4).
 */
export function adjudicatorSettings(hook: HookCommand | null): Record<string, unknown> {
  const settings: Record<string, unknown> = { permissions: { blockReadsOutsideWorkingDirectories: true } };
  if (hook !== null) settings['hooks'] = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hook.command }] }] };
  return settings;
}

/**
 * The init gate (plan 6.4): read `system/init` before the first turn, and stop the run, recording `setup` and no
 * adjudication, when `tools` is not a subset of {Read, Glob, Grep, Edit} or `permissionMode` is not `dontAsk`. A
 * missing or malformed tools list is a problem, never an empty offer.
 */
export function adjudicatorInitProblem(init: Record<string, unknown>): string | null {
  const offer = offeredTools(init);
  if (!offer.ok) return `system/init ${offer.problem}`;
  const allowed: readonly string[] = ADJUDICATOR_TOOLS;
  const extra = offer.tools.filter((t) => !allowed.includes(t));
  if (extra.length > 0) {
    const plugin = extra.some((t) => t.startsWith('mcp__'));
    return `system/init offered ${extra.join(', ')} beyond ${ADJUDICATOR_TOOLS.join(', ')}${plugin ? ': a plugin or MCP tool reached the adjudicator' : ''}`;
  }
  if (init['permissionMode'] !== 'dontAsk') return `system/init permissionMode ${String(init['permissionMode'])}, not dontAsk`;
  return null;
}

/**
 * Reads a growing stream-json file incrementally: each call parses only the bytes written since the last one, so
 * the run can be polled every few milliseconds until `system/init` arrives (the gate) without re-reading the file.
 */
export class StreamWatch {
  private offset = 0;
  private pending = '';
  init: Json | null = null;
  result = false;

  constructor(private readonly path: string) {}

  poll(): { init: Json | null; result: boolean } {
    if (!existsSync(this.path)) return { init: this.init, result: this.result };
    const size = statSync(this.path).size;
    if (size > this.offset) {
      const fd = openSync(this.path, 'r');
      try {
        const buffer = Buffer.alloc(size - this.offset);
        const n = readSync(fd, buffer, 0, buffer.length, this.offset);
        this.offset += n;
        this.pending += buffer.subarray(0, n).toString('utf8');
      } finally {
        closeSync(fd);
      }
      const lines = this.pending.split('\n');
      this.pending = lines.pop() ?? '';
      for (const line of lines) this.take(line);
    }
    return { init: this.init, result: this.result };
  }

  private take(line: string): void {
    if (line.trim() === '') return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(row)) return;
    const type = str(row['type']);
    if (type === 'system' && str(row['subtype']) === 'init' && this.init === null) this.init = row;
    if (type === 'result') this.result = true;
  }
}
