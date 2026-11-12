import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FailureClass } from '../../config/vocab.js';
import { pathInsideRoot, realpathOrNull, rootAliases } from '../paths.js';
import { fromNonceLine, nonceOnFirstLine, verdictOf, type Ratification, type RatificationCheck } from '../types.js';
import { classifyCodexText } from './classify.js';
import { checkCommandPaths, WRITE_DENIAL, type PathProblem } from './cmd-paths.js';
import { scanExecInput } from './exec-input.js';
import { callRule, codexDecl, type CallClass, type CodexVersionDecl } from './native.js';
import {
  findRollout,
  isObject,
  num,
  ownLines,
  readEvents,
  readRollout,
  scanChildren,
  str,
  THREAD_ID,
  type CodexEvents,
  type Json,
  type Rollout,
} from './records.js';

/*
 * Codex ratification (plan 4.5), fail closed. A leg ratifies only when its own rollout, and the rollout of every
 * agent it spawned, passes every check. Each check below is named; the mutation table removes one at a time.
 */

export interface CodexRatifyInput {
  /** Realpath of the root. */
  root: string;
  nonce: string;
  model: string;
  effort: string;
  /** The CLI version preflight saw. Undeclared versions fail. */
  cliVersion: string;
  codexHome: string;
  eventsFile: string;
  stderrFile: string;
  lastFile: string;
  startedAt: Date;
  /** The supervisor saw the wall-clock cap expire. */
  timedOut: boolean;
  rootUnchanged: (() => { unchanged: boolean; changes: string[] }) | undefined;
  /** Caps on the agent tree (fail closed past them). */
  maxChildren?: number | undefined;
  maxDepth?: number | undefined;
}

export interface CallRecord {
  thread: string;
  name: string;
  namespace: string | null;
  callId: string | null;
  offer: string | null;
  class: CallClass | null;
}

export interface CommandRecord {
  thread: string;
  cmd: string;
  problems: PathProblem[];
}

export interface ThreadReport {
  threadId: string;
  path: string | null;
  role: 'leg' | 'child';
  agentPath: string;
  parent: string | null;
  depth: number;
  checks: RatificationCheck[];
  model: string | null;
  effort: string | null;
  cwd: string | null;
  offered: string[];
  calls: CallRecord[];
  commands: CommandRecord[];
  children: string[];
}

interface Tree {
  threadIds: Set<string>;
  paths: Set<string>;
}

interface Activity {
  callId: string | null;
  kind: string | null;
  threadId: string | null;
  agentPath: string | null;
}

function check(checks: RatificationCheck[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

/**
 * The text parts of a call output, plus the `output` field of every JSON chunk among them (an exec result is a
 * list of parts; each command's result is a JSON chunk with `exit_code` and `output`).
 */
function outputTexts(payload: Json): string[] {
  const output = payload['output'];
  const parts: string[] = [];
  if (typeof output === 'string') {
    parts.push(output);
  } else if (Array.isArray(output)) {
    for (const part of output) {
      if (isObject(part) && typeof part['text'] === 'string') parts.push(part['text']);
    }
  } else if (output !== undefined && output !== null) {
    parts.push(JSON.stringify(output));
  }
  const out = [...parts];
  for (const part of parts) {
    try {
      const chunk: unknown = JSON.parse(part);
      if (isObject(chunk) && typeof chunk['output'] === 'string') out.push(chunk['output']);
    } catch {
      // Not a JSON chunk; the raw text is checked as it is.
    }
  }
  return out;
}

function offeredNames(r: Rollout): string[] {
  const names = new Set<string>();
  for (const line of r.lines) {
    if (line.type !== 'world_state') continue;
    const state = isObject(line.payload['state']) ? line.payload['state'] : null;
    const tools = state ? state['top_level_tools'] : undefined;
    if (Array.isArray(tools)) for (const t of tools) if (typeof t === 'string') names.add(t);
    // Later world_state lines are deltas; a null value removes a tool from the offer.
    if (isObject(tools)) for (const [t, v] of Object.entries(tools)) if (v !== null) names.add(t);
  }
  return [...names].sort();
}

function activities(r: Rollout): Activity[] {
  const out: Activity[] = [];
  for (const line of ownLines(r)) {
    if (line.type !== 'event_msg' || str(line.payload['type']) !== 'item_completed') continue;
    const item = isObject(line.payload['item']) ? line.payload['item'] : null;
    if (!item || str(item['type']) !== 'SubAgentActivity') continue;
    out.push({
      callId: str(item['id']),
      kind: str(item['kind']),
      threadId: str(item['agent_thread_id']),
      agentPath: str(item['agent_path']),
    });
  }
  return out;
}

/** Activity kinds that act on an agent that already exists; any other kind (`started`) starts a child. */
const INTERACTION_KINDS = new Set(['interacted', 'completed', 'interrupted', 'closed', 'waited']);

function startsChild(a: Activity): boolean {
  return a.threadId !== null && !INTERACTION_KINDS.has(a.kind ?? '');
}

const TARGET_FIELDS = ['target', 'agent', 'agent_id', 'agent_path', 'id', 'thread_id', 'task_name', 'to'];
const TARGET_LIST_FIELDS = ['targets', 'agents', 'agent_ids', 'ids', 'thread_ids'];

function parseArgs(raw: unknown): Json {
  if (isObject(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const value: unknown = JSON.parse(raw);
    return isObject(value) ? value : {};
  } catch {
    return {};
  }
}

function targetInTree(target: string, callerPath: string, tree: Tree): boolean {
  if (THREAD_ID.test(target)) return tree.threadIds.has(target);
  if (target.startsWith('/')) return tree.paths.has(target);
  if (tree.paths.has(`${callerPath}/${target}`)) return true;
  return [...tree.paths].some((p) => p.endsWith(`/${target}`));
}

function sameDir(a: string, aliases: readonly string[]): boolean {
  const n = posix.normalize(a.replace(/^file:\/\//, '')).replace(/\/+$/, '');
  if (aliases.includes(n)) return true;
  const real = realpathOrNull(n);
  return real !== null && aliases.includes(real);
}

interface ThreadInput {
  rollout: Rollout | null;
  threadId: string;
  path: string | null;
  role: 'leg' | 'child';
  parent: string | null;
  depth: number;
}

/** Ratifies one thread's own records under the same checks for the leg and every child (N30). */
function ratifyThread(t: ThreadInput, input: CodexRatifyInput, decl: CodexVersionDecl, tree: Tree, aliases: readonly string[]): ThreadReport {
  const checks: RatificationCheck[] = [];
  const report: ThreadReport = {
    threadId: t.threadId,
    path: t.path,
    role: t.role,
    agentPath: '/root',
    parent: t.parent,
    depth: t.depth,
    checks,
    model: null,
    effort: null,
    cwd: null,
    offered: [],
    calls: [],
    commands: [],
    children: [],
  };
  const r = t.rollout;
  check(checks, 'record', r !== null && r.meta !== null && str(r.meta['id']) === t.threadId, r === null ? 'no rollout found for the thread' : `rollout ${r.path}`);
  if (r === null || r.meta === null) return report;
  const meta = r.meta;
  report.agentPath = str(meta['agent_path']) ?? '/root';
  check(checks, 'record-parse', r.malformed === 0, r.malformed === 0 ? 'every line parses' : `${r.malformed} malformed line(s)`);

  const version = str(meta['cli_version']);
  check(checks, 'cli-version', version === input.cliVersion, `session_meta.cli_version ${String(version)}, preflight ${input.cliVersion}`);
  const originator = str(meta['originator']);
  check(checks, 'originator', originator === 'codex_exec', `session_meta.originator ${String(originator)}`);

  const own = ownLines(r);
  const contexts = own.filter((l) => l.type === 'turn_context').map((l) => l.payload);
  const metaCwd = str(meta['cwd']);
  report.cwd = metaCwd;
  const cwds = [metaCwd, ...contexts.map((c) => str(c['cwd']))];
  const badCwd = cwds.filter((c) => c === null || !sameDir(c, aliases));
  check(checks, 'cwd', contexts.length > 0 && badCwd.length === 0, badCwd.length === 0 ? `cwd = root (${contexts.length} turn_context)` : `cwd not the root: ${badCwd.map(String).join(', ')}`);

  const models = contexts.map((c) => str(c['model']));
  report.model = models.find((m) => m !== null) ?? null;
  check(checks, 'model', contexts.length > 0 && models.every((m) => m === input.model), `turn_context.model ${[...new Set(models)].map(String).join(', ') || 'none'}; pin ${input.model}`);
  const efforts = contexts.map((c) => str(c['effort']));
  report.effort = efforts.find((e) => e !== null) ?? null;
  check(checks, 'effort', contexts.length > 0 && efforts.every((e) => e === input.effort), `turn_context.effort ${[...new Set(efforts)].map(String).join(', ') || 'none'}; pin ${input.effort}`);
  const sandboxes = contexts.map((c) => (isObject(c['sandbox_policy']) ? str(c['sandbox_policy']['type']) : null));
  check(checks, 'sandbox', contexts.length > 0 && sandboxes.every((s) => s === 'read-only'), `sandbox_policy.type ${[...new Set(sandboxes)].map(String).join(', ') || 'none'}`);
  // Round 1: the network policy the recorded legs run under. Anything else, or no value, fails.
  const networks = contexts.map((c) => (isObject(c['permission_profile']) ? str(c['permission_profile']['network']) : null));
  check(checks, 'network', contexts.length > 0 && networks.every((n) => n === 'restricted'), `permission_profile.network ${[...new Set(networks)].map(String).join(', ') || 'none'}`);
  const approvals = contexts.map((c) => str(c['approval_policy']));
  check(checks, 'approval', contexts.length > 0 && approvals.every((a) => a === 'never'), `approval_policy ${[...new Set(approvals)].map(String).join(', ') || 'none'}`);

  const reroutes = own.filter((l) => l.type === 'event_msg' && /reroute/i.test(str(l.payload['type']) ?? ''));
  check(checks, 'no-reroute', reroutes.length === 0, reroutes.length === 0 ? 'no model_reroute event' : `${reroutes.length} reroute event(s)`);

  // Offer check: exact membership in the declared list (N29).
  report.offered = offeredNames(r);
  const undeclared = report.offered.filter((name) => !decl.nativeOffer.includes(name));
  check(
    checks,
    'offered',
    report.offered.length > 0 && undeclared.length === 0,
    report.offered.length === 0 ? 'no world_state.top_level_tools in the record' : undeclared.length === 0 ? `${report.offered.length} offered, all declared` : `offered outside the declared list: ${undeclared.join(', ')}`,
  );

  // Use check: map every call to its offer and class (N28), then apply the class rule.
  const calls = own.filter(
    (l) => l.type === 'response_item' && (str(l.payload['type']) === 'function_call' || str(l.payload['type']) === 'custom_tool_call'),
  );
  const unknownCalls: string[] = [];
  const execInputs: string[] = [];
  const execCallIds = new Set<string>();
  const targeted: Array<{ name: string; callId: string | null; args: Json }> = [];
  const waits: Array<{ name: string; args: Json }> = [];
  const inputs: string[] = [];
  for (const line of calls) {
    const name = str(line.payload['name']) ?? '';
    const namespace = str(line.payload['namespace']);
    const callId = str(line.payload['call_id']);
    const rule = callRule(decl, name, namespace);
    report.calls.push({ thread: t.threadId, name, namespace, callId, offer: rule?.offer ?? null, class: rule?.class ?? null });
    if (!rule || !decl.nativeOffer.includes(rule.offer)) {
      unknownCalls.push(namespace ? `${namespace}.${name}` : name);
      continue;
    }
    if (rule.class === 'command') {
      execInputs.push(str(line.payload['input']) ?? str(line.payload['arguments']) ?? '');
      if (callId !== null) execCallIds.add(callId);
    }
    else if (rule.class === 'targeted') targeted.push({ name, callId, args: parseArgs(line.payload['arguments']) });
    else if (rule.class === 'wait') waits.push({ name, args: parseArgs(line.payload['arguments']) });
    else if (rule.class === 'input') inputs.push(name);
  }
  check(checks, 'calls', unknownCalls.length === 0, unknownCalls.length === 0 ? `${calls.length} call(s), all declared` : `undeclared call(s): ${unknownCalls.join(', ')}`);
  if (inputs.length > 0) check(checks, 'input-requests', true, `request_user_input called ${inputs.length} time(s); nothing answers it headless`);

  // The command channel: every nested call in every exec script (N16, N18), plus every command the record
  // shows ran.
  const parsedCmds = new Set<string>();
  const scanProblems: string[] = [];
  const nestedUsed: string[] = [];
  for (const script of execInputs) {
    const scan = scanExecInput(script);
    if (!scan.ok) scanProblems.push(scan.reason);
    for (const call of scan.calls) {
      nestedUsed.push(call.tool);
      const rule = decl.execNested[call.tool];
      if (!rule) {
        scanProblems.push(`exec called the undeclared nested tool ${call.tool}`);
        continue;
      }
      if (rule.class === 'forbidden') {
        scanProblems.push(`exec called ${call.tool}: ${rule.why}`);
        continue;
      }
      if (call.tool === 'view_image') {
        const p = call.args['path'];
        const judged = typeof p === 'string' ? pathInsideRoot(p, input.root, aliases) : null;
        if (!judged?.inside) scanProblems.push(`view_image path ${String(p)} ${judged?.why ?? 'is not a literal'}`);
        continue;
      }
      if (rule.class !== 'command') continue;
      const unknown = Object.keys(call.args).filter((k) => !decl.execCommandArgs.includes(k));
      if (unknown.length > 0) scanProblems.push(`exec_command with undeclared argument(s) ${unknown.join(', ')}`);
      const sandbox = call.args['sandbox_permissions'];
      if (sandbox !== undefined && sandbox !== 'use_default') scanProblems.push(`exec_command asked for sandbox_permissions ${String(sandbox)}`);
      if (call.args['prefix_rule'] !== undefined) scanProblems.push('exec_command carried a prefix_rule (an escalation request)');
      const shell = call.args['shell'];
      if (shell !== undefined && (typeof shell !== 'string' || !/^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)$/.test(shell))) {
        scanProblems.push(`exec_command with shell ${String(shell)}`);
      }
      const workdir = call.args['workdir'];
      if (workdir !== undefined && typeof workdir !== 'string') scanProblems.push('exec_command with a non-string workdir');
      if (call.cmd === null) {
        scanProblems.push('exec_command with no cmd');
        continue;
      }
      parsedCmds.add(call.cmd);
      report.commands.push({
        thread: t.threadId,
        cmd: call.cmd,
        problems: checkCommandPaths(call.cmd, input.root, aliases, { workdir: typeof workdir === 'string' ? workdir : undefined }),
      });
    }
  }
  const executions = own
    .filter((l) => l.type === 'event_msg' && str(l.payload['type']) === 'item_completed')
    .map((l) => (isObject(l.payload['item']) ? l.payload['item'] : {}))
    .filter((item) => str(item['type']) === 'CommandExecution');
  const unparsed: string[] = [];
  const badCmdCwd: string[] = [];
  for (const item of executions) {
    // Every command runs in the root itself (strip file://); a workdir elsewhere in the root fails too.
    const itemCwd = str(item['cwd']);
    if (itemCwd === null || !sameDir(itemCwd, aliases)) badCmdCwd.push(String(itemCwd));
    const argv = Array.isArray(item['command']) ? item['command'].filter((a): a is string => typeof a === 'string') : [];
    // The wrapper is `[shell, -lc, inner]`; only the inner command is a command string (N16).
    const inner = argv.length === 3 && /^-l?c$/.test(argv[1] ?? '') ? (argv[2] ?? '') : null;
    if (inner === null) {
      unparsed.push(argv.join(' ').slice(0, 120));
      continue;
    }
    if (!parsedCmds.has(inner)) unparsed.push(inner.slice(0, 120));
  }
  const pathProblems = report.commands.flatMap((c) => c.problems.map((p) => `${p.kind}: ${p.token} (${p.detail}) in "${c.cmd.slice(0, 120)}"`));
  // The records backstop: every recorded item is a declared type, and every image read is inside the root.
  const itemProblems: string[] = [];
  for (const line of own) {
    if (line.type !== 'event_msg' || str(line.payload['type']) !== 'item_completed') continue;
    const item = isObject(line.payload['item']) ? line.payload['item'] : null;
    const type = item ? str(item['type']) : null;
    const rule = type === null ? undefined : decl.recordItems[type];
    if (item === null || rule === undefined) {
      itemProblems.push(`a recorded ${String(type)} item`);
    } else if (rule === 'image') {
      const raw = str(item['path']);
      let path: string | null = null;
      try {
        path = raw === null ? null : raw.startsWith('file://') ? fileURLToPath(raw) : raw;
      } catch {
        path = null;
      }
      const where = path === null ? null : pathInsideRoot(path, input.root, aliases);
      if (where === null || !where.inside) itemProblems.push(`an image read of ${String(raw)} (${where?.why ?? 'no readable path'})`);
    } else if (rule === 'mcp-list') {
      const tool = str(item['tool']);
      if (str(item['server']) !== 'codex' || (tool !== 'list_mcp_resources' && tool !== 'list_mcp_resource_templates')) {
        itemProblems.push(`an MCP call ${String(item['server'])}.${String(tool)}`);
      }
    }
  }
  check(
    checks,
    'records',
    itemProblems.length === 0,
    itemProblems.length === 0 ? 'every recorded item is a declared read or conversation item' : itemProblems.join('; '),
  );
  check(
    checks,
    'commands',
    scanProblems.length === 0 && unparsed.length === 0 && pathProblems.length === 0 && badCmdCwd.length === 0,
    scanProblems.length + unparsed.length + pathProblems.length + badCmdCwd.length === 0
      ? `${parsedCmds.size} command(s) parsed, every one a read inside the root; nested tools used: ${[...new Set(nestedUsed)].sort().join(', ') || 'none'}`
      : [
          ...scanProblems.map((s) => `exec script: ${s}`),
          ...unparsed.map((u) => `ran but not in any exec script: ${u}`),
          ...pathProblems,
          ...badCmdCwd.map((c) => `a command ran in ${c}, not the root`),
        ].join('; '),
  );

  // Write denials appear only in the exec outputs (N15), and in command items when they show at all.
  // exec is the only custom tool, so every custom_tool_call_output is checked, attributed or not; a
  // function_call_output is checked when it answers an exec call.
  const outputs = own
    .filter((l) => {
      if (l.type !== 'response_item') return false;
      const type = str(l.payload['type']);
      return type === 'custom_tool_call_output' || (type === 'function_call_output' && execCallIds.has(str(l.payload['call_id']) ?? ''));
    })
    .flatMap((l) => outputTexts(l.payload));
  for (const item of executions) outputs.push(str(item['aggregated_output']) ?? '');
  const denials = outputs.filter((o) => WRITE_DENIAL.test(o));
  check(checks, 'write-denial', denials.length === 0, denials.length === 0 ? 'no command was denied a write' : `write denied: ${denials[0]?.slice(0, 160) ?? ''}`);

  // Calls on other agents act only on this leg's own agents (N30).
  const acts = activities(r);
  report.children = [...new Set(acts.filter(startsChild).filter((a) => a.threadId !== t.parent && a.threadId !== t.threadId).map((a) => a.threadId as string))];
  const badTargets: string[] = [];
  for (const a of acts) {
    if (a.threadId === null || !tree.threadIds.has(a.threadId)) badTargets.push(`${a.kind ?? 'activity'} on ${String(a.threadId)} (${a.agentPath ?? 'no path'})`);
  }
  for (const call of targeted) {
    const act = acts.find((a) => a.callId !== null && a.callId === call.callId);
    const named = TARGET_FIELDS.map((f) => str(call.args[f])).find((v) => v !== null) ?? null;
    if (act?.threadId) {
      if (!tree.threadIds.has(act.threadId)) badTargets.push(`${call.name} -> ${act.threadId}`);
    } else if (named === null) {
      badTargets.push(`${call.name} with no target the record resolves`);
    }
    if (named !== null && !targetInTree(named, report.agentPath, tree)) badTargets.push(`${call.name} -> ${named}`);
  }
  for (const wait of waits) {
    for (const field of TARGET_LIST_FIELDS) {
      const list = wait.args[field];
      if (!Array.isArray(list)) continue;
      for (const v of list) if (typeof v !== 'string' || !targetInTree(v, report.agentPath, tree)) badTargets.push(`${wait.name} -> ${String(v)}`);
    }
    // A single named target (`thread_id`, `target`, `agent_id`, `id`, ...) is checked the same way (round 1).
    for (const field of TARGET_FIELDS) {
      const v = wait.args[field];
      if (v === undefined || v === null) continue;
      if (typeof v !== 'string' || !targetInTree(v, report.agentPath, tree)) badTargets.push(`${wait.name} -> ${field} ${String(v)}`);
    }
  }
  for (const line of own) {
    if (line.type !== 'event_msg' || str(line.payload['type']) !== 'item_completed') continue;
    const item = isObject(line.payload['item']) ? line.payload['item'] : null;
    if (!item || str(item['type']) !== 'CollabAgentToolCall') continue;
    const receivers = Array.isArray(item['receiver_thread_ids']) ? item['receiver_thread_ids'] : [];
    for (const v of receivers) if (typeof v !== 'string' || !tree.threadIds.has(v)) badTargets.push(`${str(item['tool']) ?? 'collab'} -> ${String(v)}`);
  }
  check(checks, 'targets', badTargets.length === 0, badTargets.length === 0 ? `${targeted.length + waits.length} orchestration call(s) on this leg's own agents` : `outside this leg's agents: ${badTargets.join('; ')}`);

  // Clean completion of this thread's own turn(s).
  const complete = own.filter((l) => l.type === 'event_msg' && str(l.payload['type']) === 'task_complete');
  const aborted = own.filter((l) => l.type === 'event_msg' && str(l.payload['type']) === 'turn_aborted');
  const errors = own.filter((l) => l.type === 'event_msg' && /^(?:error|stream_error)$/.test(str(l.payload['type']) ?? ''));
  check(
    checks,
    'completion',
    complete.length > 0 && aborted.length === 0 && errors.length === 0 && !r.tornTail,
    `task_complete ${complete.length}, turn_aborted ${aborted.length}, error events ${errors.length}${r.tornTail ? ', torn last line' : ''}`,
  );

  const tokenCounts = own.filter((l) => l.type === 'event_msg' && str(l.payload['type']) === 'token_count' && isObject(l.payload['info']));
  check(checks, 'tokens', tokenCounts.length > 0, `${tokenCounts.length} token_count event(s)`);
  return report;
}

function lastAgentMessage(r: Rollout | null): string | null {
  if (!r) return null;
  const done = ownLines(r).filter((l) => l.type === 'event_msg' && str(l.payload['type']) === 'task_complete');
  return done.length > 0 ? str(done[done.length - 1]?.payload['last_agent_message']) : null;
}

/** The leg's answer: `-o last.txt`, else the last agent message in the stream, else the rollout's task_complete. */
export function codexAnswer(events: CodexEvents, lastFile: string, rollout: Rollout | null): { text: string | null; source: string } {
  if (existsSync(lastFile)) {
    const text = readFileSync(lastFile, 'utf8');
    if (text.trim() !== '') return { text, source: 'last.txt' };
  }
  const fromEvents = events.agentMessages[events.agentMessages.length - 1];
  if (fromEvents !== undefined && fromEvents.trim() !== '') return { text: fromEvents, source: 'events.jsonl' };
  return { text: lastAgentMessage(rollout), source: 'rollout task_complete' };
}

const CLASS_OF_CHECK: Readonly<Record<string, FailureClass>> = {
  events: 'setup',
  'stream-reroute': 'model',
  'stream-completion': 'transport',
  record: 'setup',
  'record-parse': 'setup',
  'cli-version': 'setup',
  originator: 'setup',
  cwd: 'contaminated',
  model: 'model',
  effort: 'model',
  'no-reroute': 'model',
  sandbox: 'contaminated',
  network: 'contaminated',
  approval: 'contaminated',
  offered: 'contaminated',
  calls: 'contaminated',
  commands: 'contaminated',
  // An undeclared nested call, an image read outside the root or a foreign MCP call: never relaunched in this root.
  records: 'contaminated',
  'write-denial': 'contaminated',
  targets: 'contaminated',
  children: 'contaminated',
  'root-unchanged': 'contaminated',
  completion: 'transport',
  tokens: 'empty',
  answer: 'empty',
  nonce: 'empty',
};

const PRECEDENCE: readonly FailureClass[] = ['contaminated', 'usage_limit', 'auth', 'model', 'capacity', 'transport', 'setup', 'timeout', 'empty'];

/** The leg's failure class from its failed checks, the error signatures and the cap. */
export function codexFailureClass(failed: readonly string[], signature: FailureClass | null, timedOut: boolean): FailureClass | null {
  if (failed.length === 0) return null;
  const classes = new Set<FailureClass>(failed.map((name) => CLASS_OF_CHECK[name] ?? 'setup'));
  if (classes.has('contaminated')) return 'contaminated';
  if (signature !== null) return signature;
  if (timedOut) return 'timeout';
  for (const cls of PRECEDENCE) if (classes.has(cls)) return cls;
  return 'setup';
}

export function codexSignature(events: CodexEvents, stderrFile: string): FailureClass | null {
  const stderr = existsSync(stderrFile) ? readFileSync(stderrFile, 'utf8') : '';
  return classifyCodexText([stderr, ...events.turnFailed, ...events.errors, ...events.errorItems]);
}

/** Ratifies a codex leg from its stream, its rollout and the rollouts of every agent it spawned. */
export function ratifyCodexLeg(input: CodexRatifyInput): Ratification {
  const decl = codexDecl(input.cliVersion);
  const aliases = rootAliases(input.root);
  const events = readEvents(input.eventsFile);
  const checks: RatificationCheck[] = [];
  const signature = codexSignature(events, input.stderrFile);

  check(
    checks,
    'events',
    events.threadId !== null && events.malformed === 0 && !events.tornTail,
    events.threadId === null
      ? 'no thread.started in the stream'
      : `thread ${events.threadId}; ${events.malformed} malformed${events.tornTail ? '; the last line is torn' : ''}`,
  );
  const reroutes = events.errorItems.filter((m) => /model rerouted/i.test(m));
  check(checks, 'stream-reroute', reroutes.length === 0, reroutes.length === 0 ? 'no reroute item in the stream' : reroutes.join('; '));
  check(checks, 'stream-completion', events.turnCompleted && events.turnFailed.length === 0, events.turnCompleted ? 'turn.completed' : `no turn.completed${events.turnFailed.length > 0 ? `; turn.failed: ${events.turnFailed.join('; ')}` : ''}`);

  const reports: ThreadReport[] = [];
  let legRollout: Rollout | null = null;
  if (decl === null) {
    check(checks, 'cli-version', false, `codex ${input.cliVersion} has no declared native list`);
  } else if (events.threadId !== null) {
    // Collect the agent tree first (N12): SubAgentActivity ids, then rollouts that name a tree thread as parent.
    const legPath = findRollout(input.codexHome, events.threadId, input.startedAt);
    legRollout = legPath ? readRollout(legPath) : null;
    const maxChildren = input.maxChildren ?? 32;
    const maxDepth = input.maxDepth ?? 4;
    const tree: Tree = { threadIds: new Set([events.threadId]), paths: new Set(['/root']) };
    const queue: ThreadInput[] = [{ rollout: legRollout, threadId: events.threadId, path: legPath, role: 'leg', parent: null, depth: 0 }];
    const known = new Map<string, ThreadInput>([[events.threadId, queue[0] as ThreadInput]]);
    let overflow = '';
    for (let qi = 0; qi < queue.length; qi++) {
      const t = queue[qi] as ThreadInput;
      if (t.rollout?.meta) {
        const p = str(t.rollout.meta['agent_path']);
        if (p) tree.paths.add(p);
      }
      const childIds = new Set<string>();
      for (const a of t.rollout ? activities(t.rollout) : []) {
        if (!startsChild(a) || a.threadId === t.parent || a.threadId === t.threadId) continue;
        if (a.agentPath) tree.paths.add(a.agentPath);
        childIds.add(a.threadId as string);
      }
      for (const [id] of scanChildren(input.codexHome, new Set([t.threadId]), input.startedAt)) childIds.add(id);
      for (const id of childIds) {
        if (known.has(id)) continue;
        if (known.size > maxChildren) {
          overflow = `more than ${maxChildren} agents`;
          break;
        }
        if (t.depth + 1 > maxDepth) {
          overflow = `agents nested deeper than ${maxDepth}`;
          break;
        }
        const path = findRollout(input.codexHome, id, input.startedAt);
        const child: ThreadInput = { rollout: path ? readRollout(path) : null, threadId: id, path, role: 'child', parent: t.threadId, depth: t.depth + 1 };
        tree.threadIds.add(id);
        known.set(id, child);
        queue.push(child);
      }
    }
    for (const t of queue) reports.push(ratifyThread(t, input, decl, tree, aliases));
    checks.push(...(reports[0] as ThreadReport).checks);
    const children = reports.slice(1);
    const failedChildren = children.filter((c) => c.checks.length === 0 || c.checks.some((k) => !k.ok));
    check(
      checks,
      'children',
      failedChildren.length === 0 && overflow === '',
      overflow !== ''
        ? overflow
        : children.length === 0
          ? 'no subagent'
          : failedChildren.length === 0
            ? `${children.length} subagent(s), each ratified`
            : failedChildren
                .map((c) => `${c.agentPath} (${c.threadId}): ${c.checks.filter((k) => !k.ok).map((k) => `${k.name}: ${k.detail}`).join('; ')}`)
                .join(' | '),
    );
  }

  const answer = codexAnswer(events, input.lastFile, legRollout);
  check(checks, 'answer', answer.text !== null && answer.text.trim() !== '', answer.text === null ? 'no answer' : `answer from ${answer.source}`);
  // Plan 4.5 item 8: the first non-empty line of the original answer is exactly `NONCE: <nonce>`.
  const nonce = nonceOnFirstLine(answer.text, input.nonce);
  const nonceSeen = nonce.ok;
  check(checks, 'nonce', nonceSeen, nonce.detail);
  const residue = input.rootUnchanged?.();
  check(checks, 'root-unchanged', residue?.unchanged === true, residue === undefined ? 'no residue sweep was given (fails closed)' : residue.unchanged ? 'tree hash unchanged' : `root changed: ${residue.changes.slice(0, 10).join(', ')}`);

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const failureClass = codexFailureClass(failed, signature, input.timedOut);
  const { ok, status } = verdictOf(checks, failureClass);

  const leg = reports[0];
  const tokenLine = legRollout
    ? [...ownLines(legRollout)].reverse().find((l) => l.type === 'event_msg' && str(l.payload['type']) === 'token_count' && isObject(l.payload['info']))
    : undefined;
  const info = tokenLine && isObject(tokenLine.payload['info']) ? tokenLine.payload['info'] : {};
  const total = isObject(info['total_token_usage']) ? info['total_token_usage'] : {};
  const limits = tokenLine && isObject(tokenLine.payload['rate_limits']) ? tokenLine.payload['rate_limits'] : null;
  const windows = limits
    ? (['primary', 'secondary'] as const)
        .map((k) => (isObject(limits[k]) ? { pct: num(limits[k]['used_percent']), minutes: num(limits[k]['window_minutes']) } : null))
        .filter((w): w is { pct: number | null; minutes: number | null } => w !== null)
    : [];
  const pcts = windows.map((w) => w.pct).filter((p): p is number => p !== null);
  const complete = legRollout ? ownLines(legRollout).filter((l) => l.type === 'event_msg' && str(l.payload['type']) === 'task_complete') : [];
  const durationMs = complete.length > 0 ? num(complete[complete.length - 1]?.payload['duration_ms']) : null;

  return {
    status,
    ok,
    failureClass,
    checks,
    enforcement: 'sandboxed-exec',
    recordPath: leg?.path ?? null,
    sessionId: events.threadId,
    cliVersion: legRollout?.meta ? str(legRollout.meta['cli_version']) : null,
    modelObserved: leg?.model ?? null,
    effortObserved: leg?.effort ?? null,
    cwdObserved: leg?.cwd ?? null,
    cwdOk: leg?.checks.find((c) => c.name === 'cwd')?.ok ?? false,
    toolsOffered: leg?.offered ?? [],
    toolsUsed: [...new Set(reports.flatMap((r) => r.calls.map((c) => c.offer ?? (c.namespace ? `${c.namespace}.${c.name}` : c.name))))].sort(),
    tokensIn: num(total['input_tokens']) ?? events.usage?.input ?? null,
    tokensOut: num(total['output_tokens']) ?? events.usage?.output ?? null,
    costUsd: null,
    credits: null,
    quotaUsedPct: pcts.length > 0 ? Math.max(...pcts) : null,
    quotaNote: limits
      ? `plan ${str(limits['plan_type']) ?? 'unknown'}; ${windows.map((w) => `${w.minutes ?? '?'} min window ${w.pct ?? '?'}%`).join(', ')}`
      : null,
    durationMs,
    nonceSeen,
    rootMutated: residue === undefined ? null : !residue.unchanged,
    detail: {
      threads: reports.map((r) => ({
        thread: r.threadId,
        role: r.role,
        agentPath: r.agentPath,
        parent: r.parent,
        record: r.path,
        model: r.model,
        effort: r.effort,
        failed: r.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
      })),
      commands: reports.flatMap((r) => r.commands),
      calls: reports.flatMap((r) => r.calls),
      signature,
    },
  };
}

/** Re-exported for the adapter: the answer from the NONCE line on. */
export function codexCollect(input: Pick<CodexRatifyInput, 'codexHome' | 'eventsFile' | 'lastFile' | 'nonce' | 'startedAt'>): ReturnType<typeof fromNonceLine> {
  const events = readEvents(input.eventsFile);
  const path = events.threadId ? findRollout(input.codexHome, events.threadId, input.startedAt) : null;
  const answer = codexAnswer(events, input.lastFile, path ? readRollout(path) : null);
  return fromNonceLine(answer.text, input.nonce, answer.source);
}

