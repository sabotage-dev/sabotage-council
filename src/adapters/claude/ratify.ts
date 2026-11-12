import { existsSync, readFileSync } from 'node:fs';
import type { FailureClass } from '../../config/vocab.js';
import { pathInsideRoot, rootAliases } from '../paths.js';
import { verdictOf, type Ratification, type RatificationCheck } from '../types.js';
import { isObject, num, str } from '../codex/records.js';
import { CLAUDE_READ_TOOLS, modelMatches } from './known.js';
import { findTranscript, readClaudeStream, readTranscript, toolPaths, transcriptFacts, type ClaudeStream } from './records.js';

/*
 * Claude failure signatures (plan 4.4) and ratification (plan 4.5), fail closed. Signatures are applied to
 * stderr and to error records (an `is_error` result's text, `api_error_status`, `subtype`), never to an answer.
 */

export const CLAUDE_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  {
    class: 'usage_limit',
    pattern: /usage limit|limit reached|hit your (?:usage )?limit|spend(?:ing)? (?:cap|limit)|credit balance is too low|\bstatus 402\b|error_max_budget_usd|max(?:imum)? budget/i,
  },
  {
    class: 'auth',
    pattern: /\bstatus 40[13]\b|authentication_error|permission_error|invalid (?:x-)?api[ -]?key|oauth token (?:has )?expired|please run \/login|not logged in|login (?:has )?expired/i,
  },
  { class: 'model', pattern: /unrecognized_model|issue with the selected model|not_found_error|\bstatus 404\b|model .*(?:not found|does not exist)/i },
  { class: 'capacity', pattern: /overloaded|\bstatus 529\b|\bstatus 429\b|rate_limit_error|rate limit/i },
  { class: 'timeout', pattern: /error_max_turns|maximum number of turns|max turns/i },
  { class: 'transport', pattern: /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|network error|connection error/i },
  { class: 'setup', pattern: /Input must be provided|unknown option|error: option|invalid settings|settings file|not a valid UUID/i },
];

/** The error text of a claude leg: stderr plus the error fields of the `result` line. */
export function claudeErrorTexts(stream: ClaudeStream, stderr: string): string[] {
  const texts = [stderr];
  const r = stream.result;
  if (r) {
    const status = num(r['api_error_status']);
    if (status !== null) texts.push(`status ${status}`);
    const subtype = str(r['subtype']);
    if (subtype !== null && subtype !== 'success') texts.push(subtype);
    if (r['is_error'] === true) texts.push(str(r['result']) ?? '');
  }
  return texts;
}

export function classifyClaudeText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of CLAUDE_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}

export interface ClaudeRatifyInput {
  root: string;
  nonce: string;
  model: string;
  effort: string;
  sessionId: string;
  streamFile: string;
  stderrFile: string;
  projectsDir: string;
  timedOut: boolean;
  rootUnchanged: (() => { unchanged: boolean; changes: string[] }) | undefined;
  /** The init gate stopped the leg before its first turn (plan 6.4). */
  initGate?: string | null | undefined;
}

const CLASS_OF_CHECK: Readonly<Record<string, FailureClass>> = {
  stream: 'setup',
  session: 'setup',
  transcript: 'setup',
  'init-gate': 'setup',
  cwd: 'contaminated',
  model: 'model',
  'model-usage': 'model',
  effort: 'model',
  offered: 'contaminated',
  'permission-mode': 'contaminated',
  'tools-used': 'contaminated',
  'tool-paths': 'contaminated',
  sidechains: 'contaminated',
  'permission-denials': 'contaminated',
  'root-unchanged': 'contaminated',
  result: 'transport',
  answer: 'empty',
  nonce: 'empty',
};

const PRECEDENCE: readonly FailureClass[] = ['contaminated', 'model', 'setup', 'transport', 'timeout', 'empty'];

export function claudeFailureClass(failed: readonly string[], signature: FailureClass | null, timedOut: boolean): FailureClass | null {
  if (failed.length === 0) return null;
  const classes = new Set<FailureClass>(failed.map((name) => CLASS_OF_CHECK[name] ?? 'setup'));
  if (classes.has('contaminated')) return 'contaminated';
  if (signature !== null) return signature;
  if (timedOut) return 'timeout';
  for (const cls of PRECEDENCE) if (classes.has(cls)) return cls;
  return 'setup';
}

function check(checks: RatificationCheck[], name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

/** The answer: the `result` line's text on success, else the last assistant text block. */
export function claudeAnswer(stream: ClaudeStream): string | null {
  const r = stream.result;
  if (r && r['is_error'] !== true) {
    const text = str(r['result']);
    if (text !== null && text.trim() !== '') return text;
  }
  const last = stream.texts[stream.texts.length - 1];
  return last !== undefined && last.trim() !== '' ? last : null;
}

const READ_SET: readonly string[] = CLAUDE_READ_TOOLS;

export function ratifyClaudeLeg(input: ClaudeRatifyInput): Ratification {
  const checks: RatificationCheck[] = [];
  const aliases = rootAliases(input.root);
  const stream = readClaudeStream(input.streamFile);
  const stderr = existsSync(input.stderrFile) ? readFileSync(input.stderrFile, 'utf8') : '';
  const signature = classifyClaudeText(claudeErrorTexts(stream, stderr));
  const init = stream.init;
  const result = stream.result;

  check(checks, 'stream', init !== null && stream.malformed === 0 && stream.extraInit === 0, init === null ? 'no system/init in the stream' : `init + ${result ? 'result' : 'no result'}; ${stream.malformed} malformed`);
  if (input.initGate) check(checks, 'init-gate', false, input.initGate);
  const initSession = init ? str(init['session_id']) : null;
  const resultSession = result ? str(result['session_id']) : null;
  check(checks, 'session', initSession === input.sessionId && (result === null || resultSession === input.sessionId), `init ${String(initSession)}, result ${String(resultSession)}, launched ${input.sessionId}`);

  const offered = init && Array.isArray(init['tools']) ? init['tools'].filter((t): t is string => typeof t === 'string') : [];
  const extra = offered.filter((t) => !READ_SET.includes(t));
  check(checks, 'offered', init !== null && extra.length === 0, init === null ? 'no init' : extra.length === 0 ? `offered ${offered.join(', ') || 'nothing'}` : `offered beyond Read/Glob/Grep: ${extra.join(', ')}`);
  const mode = init ? str(init['permissionMode']) : null;
  check(checks, 'permission-mode', mode === 'dontAsk', `permissionMode ${String(mode)}`);

  const transcriptPath = findTranscript(input.projectsDir, input.sessionId);
  const transcript = transcriptPath ? readTranscript(transcriptPath) : null;
  const facts = transcript ? transcriptFacts(transcript) : null;
  check(
    checks,
    'transcript',
    transcript !== null && facts !== null && transcript.malformed === 0 && facts.sessionIds.every((s) => s === input.sessionId),
    transcript === null ? `no transcript for session ${input.sessionId} under ${input.projectsDir}` : `transcript ${transcript.path}; ${transcript.malformed} malformed`,
  );

  const initCwd = init ? str(init['cwd']) : null;
  const cwds = [initCwd, ...(facts?.cwds ?? [])];
  const badCwd = [...new Set(cwds.filter((c) => c === null || !aliases.includes(c.replace(/\/+$/, ''))))];
  check(checks, 'cwd', initCwd !== null && badCwd.length === 0, badCwd.length === 0 ? 'cwd = root in init and the transcript' : `cwd not the root: ${badCwd.map(String).join(', ')}`);

  const initModel = init ? str(init['model']) : null;
  const requestModels = (facts?.requests ?? []).map((r) => r.model);
  const assistantModels = facts?.assistantModels ?? [];
  const allModels = [initModel, ...requestModels, ...assistantModels];
  const badModels = [...new Set(allModels.filter((m) => m === null || !modelMatches(m, input.model)))];
  check(checks, 'model', initModel !== null && requestModels.length > 0 && badModels.length === 0, badModels.length === 0 ? `model ${input.model} in init, ${requestModels.length} request(s), ${assistantModels.length} turn(s)` : `model not the pin ${input.model}: ${badModels.map(String).join(', ')}`);

  const usage = result && isObject(result['modelUsage']) ? Object.keys(result['modelUsage']) : [];
  const badUsage = usage.filter((m) => !modelMatches(m, input.model));
  check(checks, 'model-usage', result !== null && usage.length > 0 && badUsage.length === 0, usage.length === 0 ? 'no modelUsage in the result' : badUsage.length === 0 ? `modelUsage ${usage.join(', ')}` : `modelUsage beyond the pin: ${badUsage.join(', ')}`);

  const efforts = (facts?.requests ?? []).map((r) => r.effort);
  const badEfforts = [...new Set(efforts.filter((e) => e !== input.effort))];
  check(checks, 'effort', efforts.length > 0 && badEfforts.length === 0, efforts.length === 0 ? 'no api-request effort in the transcript' : badEfforts.length === 0 ? `effort ${input.effort} on ${efforts.length} request(s)` : `effort not the pin ${input.effort}: ${badEfforts.map(String).join(', ')}`);

  const uses = [...stream.toolUses, ...(facts?.toolUses ?? [])];
  const forbidden = [...new Set(uses.map((u) => u.name).filter((n) => !READ_SET.includes(n)))];
  check(checks, 'tools-used', forbidden.length === 0, forbidden.length === 0 ? `${uses.length} tool use(s), all reads` : `tools beyond the read set: ${forbidden.join(', ')}`);
  const outside: string[] = [];
  for (const use of uses) {
    for (const p of toolPaths(use)) {
      const judged = pathInsideRoot(p, input.root, aliases);
      if (!judged.inside) outside.push(`${use.name} ${p} (${judged.why})`);
    }
  }
  check(checks, 'tool-paths', outside.length === 0, outside.length === 0 ? 'every tool path inside the root' : [...new Set(outside)].join('; '));
  check(checks, 'sidechains', (facts?.sidechains ?? 0) === 0, `${facts?.sidechains ?? 0} sidechain entr(ies)`);

  const denials = result && Array.isArray(result['permission_denials']) ? result['permission_denials'] : [];
  check(checks, 'permission-denials', result !== null && denials.length === 0, `${denials.length} permission denial(s)${denials.length > 0 ? `: ${JSON.stringify(denials).slice(0, 300)}` : ''}`);

  const subtype = result ? str(result['subtype']) : null;
  check(checks, 'result', result !== null && result['is_error'] === false && subtype === 'success', result === null ? 'no result line' : `is_error ${String(result['is_error'])}, subtype ${String(subtype)}`);

  const answer = claudeAnswer(stream);
  check(checks, 'answer', answer !== null, answer === null ? 'no answer' : 'answer in the result');
  const nonceSeen = answer !== null && answer.includes(input.nonce);
  check(checks, 'nonce', nonceSeen, nonceSeen ? 'nonce in the answer' : 'nonce missing from the answer');
  const residue = input.rootUnchanged?.();
  check(checks, 'root-unchanged', residue?.unchanged === true, residue === undefined ? 'no residue sweep was given (fails closed)' : residue.unchanged ? 'tree hash unchanged' : `root changed: ${residue.changes.slice(0, 10).join(', ')}`);

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const failureClass = claudeFailureClass(failed, signature, input.timedOut);
  const { ok, status } = verdictOf(checks, failureClass);
  const usageRow = result && isObject(result['usage']) ? result['usage'] : {};
  return {
    status,
    ok,
    failureClass,
    checks,
    enforcement: 'pending',
    recordPath: transcriptPath,
    sessionId: initSession,
    cliVersion: init ? str(init['claude_code_version']) : null,
    modelObserved: initModel,
    effortObserved: efforts.find((e) => e !== null) ?? null,
    cwdObserved: initCwd,
    cwdOk: checks.find((c) => c.name === 'cwd')?.ok ?? false,
    toolsOffered: offered,
    toolsUsed: [...new Set(uses.map((u) => u.name))].sort(),
    tokensIn: num(usageRow['input_tokens']),
    tokensOut: num(usageRow['output_tokens']),
    costUsd: result ? num(result['total_cost_usd']) : null,
    credits: null,
    quotaUsedPct: null,
    quotaNote: null,
    durationMs: result ? num(result['duration_ms']) : null,
    nonceSeen,
    rootMutated: residue === undefined ? null : !residue.unchanged,
    detail: {
      permissionDenials: denials,
      toolUses: uses.map((u) => ({ name: u.name, paths: toolPaths(u), source: u.source })),
      instructionFiles: facts?.instructionFiles ?? [],
      apiErrors: facts?.apiErrors ?? [],
      signature,
    },
  };
}
