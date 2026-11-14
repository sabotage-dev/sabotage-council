import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { FailureClass } from '../config/vocab.js';
import { pathInsideRoot, rootAliases } from '../adapters/paths.js';
import { verdictOf, type RatificationCheck, type RatificationStatus } from '../adapters/types.js';
import { claudeErrorTexts, classifyClaudeText, claudeAnswer, offeredTools } from '../adapters/claude/ratify.js';
import { modelMatches } from '../adapters/claude/known.js';
import { findTranscript, readClaudeStream, readTranscript, toolPaths, transcriptFacts, type ToolUse } from '../adapters/claude/records.js';
import { isObject, num, str } from '../adapters/codex/records.js';
import { ADJUDICATOR_TOOLS, MAINLOOP_DIR, OUTPUT_PLACEHOLDER } from './launch.js';

/*
 * Ratification of one headless adjudicator launch (plan 6.4, 4.5, fail closed), from the CLI's own records: the
 * stream-json output, the transcript under the projects dir, the hook's log, and the working copy itself. A run that
 * was offered or used a tool beyond {Read, Glob, Grep, Edit}, named a path outside the copy (from the transcript, even
 * a denied attempt), edited outside `_mainloop/`, changed the copy, or met a permission denial is CONTAMINATED: like a
 * contaminated leg it is not an adjudication and nothing it wrote is read.
 */

export interface AdjudicatorRatifyInput {
  /** The working copy (the run's cwd). */
  root: string;
  model: string;
  effort: string;
  sessionId: string;
  cliVersion: string;
  streamFile: string;
  stderrFile: string;
  projectsDir: string;
  /** The hook's decision log; null on a `--bare` run (no hook). */
  hookLog: string | null;
  timedOut: boolean;
  /** The init gate stopped the run before its first turn. */
  initGate: string | null;
  /** Whether the copy, without `_council/` and `_mainloop/`, still hashes to the sealed tree, and `_council/` is as written. */
  copyUnchanged: () => { unchanged: boolean; changes: string[] };
  /** The output file; it must exist and no longer be the placeholder. */
  output: string;
}

export interface AdjudicatorRatification {
  status: RatificationStatus;
  ok: boolean;
  failureClass: FailureClass | null;
  checks: RatificationCheck[];
  recordPath: string | null;
  sessionId: string | null;
  cliVersion: string | null;
  modelObserved: string | null;
  effortObserved: string | null;
  toolsOffered: string[];
  toolsUsed: string[];
  permissionDenials: unknown[];
  costUsd: number | null;
  durationMs: number | null;
  turns: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  detail: Record<string, unknown>;
}

const CLASS_OF_CHECK: Readonly<Record<string, FailureClass>> = {
  stream: 'setup',
  'init-gate': 'setup',
  'cli-version': 'setup',
  session: 'setup',
  transcript: 'setup',
  hook: 'setup',
  offered: 'contaminated',
  'permission-mode': 'contaminated',
  cwd: 'contaminated',
  'tools-used': 'contaminated',
  'tool-paths': 'contaminated',
  'edit-paths': 'contaminated',
  sidechains: 'contaminated',
  'permission-denials': 'contaminated',
  'hook-denials': 'contaminated',
  'copy-unchanged': 'contaminated',
  model: 'model',
  'model-usage': 'model',
  effort: 'model',
  result: 'transport',
  output: 'empty',
};

const PRECEDENCE: readonly FailureClass[] = ['contaminated', 'model', 'setup', 'transport', 'timeout', 'empty'];

/**
 * The run's failure class. A run the init gate stopped is `setup` (plan 6.4): the offer and the mode it was stopped for
 * are the reason, not contamination. It is contaminated only when something ran anyway (a tool use, a path, a change
 * to the copy), which means the gate lost a race.
 */
function failureClassOf(failed: readonly string[], signature: FailureClass | null, timedOut: boolean, gated: boolean): FailureClass | null {
  if (failed.length === 0) return null;
  const counted = gated ? failed.filter((n) => n !== 'offered' && n !== 'permission-mode') : failed;
  const classes = new Set<FailureClass>(counted.map((n) => CLASS_OF_CHECK[n] ?? 'setup'));
  if (classes.has('contaminated')) return 'contaminated';
  if (gated) return 'setup';
  if (signature !== null) return signature;
  if (timedOut) return 'timeout';
  for (const cls of PRECEDENCE) if (classes.has(cls)) return cls;
  return 'setup';
}

/** Every path an adjudicator tool call names: the seat reads, plus Edit's `file_path`. */
export function adjudicatorToolPaths(use: ToolUse): string[] {
  if (use.name === 'Edit') {
    const p = use.input['file_path'];
    return typeof p === 'string' && p !== '' ? [p] : [];
  }
  return toolPaths(use);
}

interface HookEntry {
  tool: string | null;
  decision: string;
}

function readHookLog(path: string): { entries: HookEntry[]; malformed: number } {
  if (!existsSync(path)) return { entries: [], malformed: 0 };
  const entries: HookEntry[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      entries.push({ tool: typeof row['tool'] === 'string' ? row['tool'] : null, decision: String(row['decision']) });
    } catch {
      malformed++;
    }
  }
  return { entries, malformed };
}

export function ratifyAdjudicatorRun(input: AdjudicatorRatifyInput): AdjudicatorRatification {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const aliases = rootAliases(input.root);
  const stream = readClaudeStream(input.streamFile);
  const stderr = existsSync(input.stderrFile) ? readFileSync(input.stderrFile, 'utf8') : '';
  const signature = classifyClaudeText(claudeErrorTexts(stream, stderr));
  const init = stream.init;
  const result = stream.result;

  check('stream', init !== null && stream.malformed === 0 && stream.extraInit === 0 && !stream.tornTail, init === null ? 'no system/init in the stream' : `init + ${result ? 'result' : 'no result'}; ${stream.malformed} malformed${stream.tornTail ? '; the last line is torn' : ''}`);
  if (input.initGate !== null) check('init-gate', false, input.initGate);
  const observedVersion = init ? str(init['claude_code_version']) : null;
  check('cli-version', observedVersion === input.cliVersion, `system/init claude_code_version ${String(observedVersion)}, preflight ${input.cliVersion}`);
  const initSession = init ? str(init['session_id']) : null;
  const resultSession = result ? str(result['session_id']) : null;
  check('session', initSession === input.sessionId && (result === null || resultSession === input.sessionId), `init ${String(initSession)}, result ${String(resultSession)}, launched ${input.sessionId}`);

  const offer = init ? offeredTools(init) : null;
  const offered = offer?.ok ? offer.tools : [];
  const allowed: readonly string[] = ADJUDICATOR_TOOLS;
  const extra = offered.filter((t) => !allowed.includes(t));
  check(
    'offered',
    offer !== null && offer.ok && extra.length === 0,
    offer === null ? 'no init' : !offer.ok ? `system/init ${offer.problem}` : extra.length === 0 ? `offered ${offered.join(', ') || 'nothing'}` : `offered beyond ${ADJUDICATOR_TOOLS.join(', ')}: ${extra.join(', ')}`,
  );
  const mode = init ? str(init['permissionMode']) : null;
  check('permission-mode', mode === 'dontAsk', `permissionMode ${String(mode)}`);

  const transcriptPath = findTranscript(input.projectsDir, input.sessionId);
  const transcript = transcriptPath ? readTranscript(transcriptPath) : null;
  const facts = transcript ? transcriptFacts(transcript) : null;
  // A run the gate stopped never reached a turn: there is no transcript to read, and nothing ran to audit.
  const gated = input.initGate !== null;
  const answer = claudeAnswer(stream);
  const finalRequest = stream.messageIds[stream.messageIds.length - 1] ?? null;
  const covered =
    facts !== null &&
    ((answer !== null && facts.assistantTexts.includes(answer)) || (finalRequest !== null && facts.assistantIds.includes(finalRequest)) || (answer === null && finalRequest === null));
  if (!gated) {
    check(
      'transcript',
      transcript !== null && facts !== null && transcript.malformed === 0 && !transcript.tornTail && covered && facts.sessionIds.every((s) => s === input.sessionId),
      transcript === null
        ? `no transcript for session ${input.sessionId} under ${input.projectsDir}`
        : `transcript ${transcript.path}; ${transcript.malformed} malformed${transcript.tornTail ? '; the last line is torn' : ''}${covered ? '' : `; it ends before the final answer (request ${String(finalRequest)})`}`,
    );
  }

  const initCwd = init ? str(init['cwd']) : null;
  const badCwd = [...new Set([initCwd, ...(facts?.cwds ?? [])].filter((c) => c === null || !aliases.includes(c.replace(/\/+$/, ''))))];
  check('cwd', initCwd !== null && badCwd.length === 0, badCwd.length === 0 ? 'cwd = the working copy in init and the transcript' : `cwd not the working copy: ${badCwd.map(String).join(', ')}`);

  const initModel = init ? str(init['model']) : null;
  if (!gated) {
    const requestModels = (facts?.requests ?? []).map((r) => r.model);
    const assistantModels = facts?.assistantModels ?? [];
    const badModels = [...new Set([initModel, ...requestModels, ...assistantModels].filter((m) => m === null || !modelMatches(m, input.model)))];
    check('model', initModel !== null && requestModels.length > 0 && badModels.length === 0, badModels.length === 0 ? `model ${input.model} in init, ${requestModels.length} request(s)` : `model not the pin ${input.model}: ${badModels.map(String).join(', ')}`);
    const usage = result && isObject(result['modelUsage']) ? Object.keys(result['modelUsage']) : [];
    const badUsage = usage.filter((m) => !modelMatches(m, input.model));
    check('model-usage', result !== null && usage.length > 0 && badUsage.length === 0, usage.length === 0 ? 'no modelUsage in the result' : badUsage.length === 0 ? `modelUsage ${usage.join(', ')}` : `modelUsage beyond the pin: ${badUsage.join(', ')}`);
    const efforts = (facts?.requests ?? []).map((r) => r.effort);
    const badEfforts = [...new Set(efforts.filter((e) => e !== input.effort))];
    check('effort', efforts.length > 0 && badEfforts.length === 0, efforts.length === 0 ? 'no api-request effort in the transcript' : badEfforts.length === 0 ? `effort ${input.effort} on ${efforts.length} request(s)` : `effort not the pin ${input.effort}: ${badEfforts.map(String).join(', ')}`);
  }

  const uses = [...stream.toolUses, ...(facts?.toolUses ?? [])];
  const forbidden = [...new Set(uses.map((u) => u.name).filter((n) => !allowed.includes(n)))];
  check('tools-used', forbidden.length === 0, forbidden.length === 0 ? `${uses.length} tool use(s), all ${ADJUDICATOR_TOOLS.join('/')}` : `tools beyond the adjudicator's set: ${forbidden.join(', ')}`);
  const outside: string[] = [];
  const badEdits: string[] = [];
  const outDir = posix.join(input.root, MAINLOOP_DIR);
  const outAliases = rootAliases(outDir);
  for (const use of uses) {
    for (const p of adjudicatorToolPaths(use)) {
      const judged = pathInsideRoot(p, input.root, aliases);
      if (!judged.inside) outside.push(`${use.name} ${p} (${judged.why})`);
      else if (use.name === 'Edit' && !pathInsideRoot(p, input.root, outAliases).inside) badEdits.push(`Edit ${p}`);
    }
  }
  // A glob that climbs (`..`) is judged by the hook too; here any `..` in a pattern fails closed.
  for (const use of uses) {
    const pattern = use.name === 'Glob' ? use.input['pattern'] : use.name === 'Grep' ? use.input['glob'] : undefined;
    if (typeof pattern === 'string' && pattern.includes('..')) outside.push(`${use.name} pattern ${pattern} (climbs)`);
  }
  check('tool-paths', outside.length === 0, outside.length === 0 ? 'every tool path inside the working copy' : [...new Set(outside)].join('; '));
  check('edit-paths', badEdits.length === 0, badEdits.length === 0 ? `every Edit under ${MAINLOOP_DIR}/` : [...new Set(badEdits)].join('; '));
  check('sidechains', (facts?.sidechains ?? 0) === 0, `${facts?.sidechains ?? 0} sidechain entr(ies)`);

  const denials = result && Array.isArray(result['permission_denials']) ? (result['permission_denials'] as unknown[]) : [];
  check('permission-denials', denials.length === 0, `${denials.length} permission denial(s)${denials.length > 0 ? `: ${JSON.stringify(denials).slice(0, 300)}` : ''}`);

  // The hook is the second line: on a run with hooks, every tool call the transcript shows has a hook decision.
  const hook = input.hookLog === null ? null : readHookLog(input.hookLog);
  if (hook !== null && !gated) {
    const calls = facts?.toolUses.length ?? 0;
    const denied = hook.entries.filter((e) => e.decision !== 'allow');
    check(
      'hook',
      hook.malformed === 0 && hook.entries.length >= calls,
      `${hook.entries.length} hook decision(s) for ${calls} tool call(s)${denied.length > 0 ? `, ${denied.length} denied` : ''}${hook.malformed > 0 ? `; ${hook.malformed} malformed log line(s)` : ''}`,
    );
    if (denied.length > 0) check('hook-denials', false, `the hook denied ${denied.length} call(s): ${denied.map((d) => d.tool ?? '?').join(', ')}`);
  }

  if (!gated) {
    const subtype = result ? str(result['subtype']) : null;
    check('result', result !== null && result['is_error'] === false && subtype === 'success', result === null ? 'no result line' : `is_error ${String(result['is_error'])}, subtype ${String(subtype)}`);
    let text: string | null = null;
    try {
      text = readFileSync(input.output, 'utf8');
    } catch {
      text = null;
    }
    check('output', text !== null && text.trim() !== '' && text !== OUTPUT_PLACEHOLDER, text === null ? 'no output file' : text === OUTPUT_PLACEHOLDER ? 'the output is still the placeholder' : `${text.length} byte(s) written`);
  }

  const residue = input.copyUnchanged();
  check('copy-unchanged', residue.unchanged, residue.unchanged ? `the copy outside ${MAINLOOP_DIR}/ is as sealed` : `the copy changed: ${residue.changes.slice(0, 10).join(', ')}`);

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const failureClass = failureClassOf(failed, signature, input.timedOut, gated);
  const { ok, status } = verdictOf(checks, failureClass);
  const usageRow = result && isObject(result['usage']) ? result['usage'] : {};
  return {
    status,
    ok,
    failureClass,
    checks,
    recordPath: transcriptPath,
    sessionId: initSession,
    cliVersion: observedVersion,
    modelObserved: initModel,
    effortObserved: (facts?.requests ?? []).map((r) => r.effort).find((e) => e !== null) ?? null,
    toolsOffered: offered,
    toolsUsed: [...new Set(uses.map((u) => u.name))].sort(),
    permissionDenials: denials,
    costUsd: result ? num(result['total_cost_usd']) : null,
    durationMs: result ? num(result['duration_ms']) : null,
    turns: result ? num(result['num_turns']) : null,
    tokensIn: num(usageRow['input_tokens']),
    tokensOut: num(usageRow['output_tokens']),
    detail: {
      toolUses: uses.map((u) => ({ name: u.name, paths: adjudicatorToolPaths(u), source: u.source })),
      hookDecisions: hook?.entries ?? null,
      instructionFiles: facts?.instructionFiles ?? [],
      apiErrors: facts?.apiErrors ?? [],
      signature,
    },
  };
}
