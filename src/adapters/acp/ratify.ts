import type { FailureClass } from '../../config/vocab.js';
import { rootAliases } from '../paths.js';
import { nonceOnFirstLine, type RatificationCheck } from '../types.js';
import { acpAnswer, executed, readAcpLog, stopReason, type AcpLog, type AcpToolCall } from './log.js';
import { isObject, judgeRead, mergeToolCall, str } from './policy.js';

/*
 * The checks every ACP leg must pass (plan 4.1, 4.5), read from the update log. Adapters add the checks from their
 * own records (model label, session record, credits) and build the Ratification.
 *
 * The four execution checks do not overlap, so each one is mutation-checked on its own:
 *   - `permissions`: every grant the client gave is, judged again from the record, an in-root read;
 *   - `tools-used`: no tool that is not a read ran unless the client was asked and allowed it (so a tool that ran
 *     with no permission request at all is caught here, and recorded in `unasked`);
 *   - `denials-held`: no tool the client rejected ran anyway;
 *   - `read-paths`: every read that ran (asked or not: a user rule can auto-allow reads) names a path, and every
 *     path is inside the root by realpath.
 */

export interface AcpPinExpect {
  id: string;
  value: string;
  /** Which check a mismatch fails: `mode`, `model` or `effort`. */
  check: 'mode' | 'model' | 'effort';
  /** Pinned by launch flags: the agent may not report it, and the adapter's record is the proof. */
  launchOnly?: boolean;
}

export interface AcpCommonInput {
  logFile: string;
  root: string;
  nonce: string;
  pins: readonly AcpPinExpect[];
  readKinds: readonly string[];
  timedOut: boolean;
  rootUnchanged: (() => { unchanged: boolean; changes: string[] }) | undefined;
}

export interface AcpCommonResult {
  log: AcpLog;
  checks: RatificationCheck[];
  answer: string | null;
  nonceSeen: boolean;
  rootMutated: boolean | null;
  toolsUsed: string[];
  /** Non-read tool calls that ran with no permission request (plan 4.1). */
  unasked: Array<{ id: string; title: string; kinds: string[] }>;
}

/** The class each common check fails as. */
export const ACP_CLASS_OF_CHECK: Readonly<Record<string, FailureClass>> = {
  log: 'transport',
  handshake: 'setup',
  session: 'setup',
  cwd: 'contaminated',
  mode: 'setup',
  refusal: 'setup',
  'mode-held': 'contaminated',
  model: 'model',
  effort: 'model',
  permissions: 'contaminated',
  'tools-used': 'contaminated',
  'denials-held': 'contaminated',
  'read-paths': 'contaminated',
  prompt: 'transport',
  answer: 'empty',
  nonce: 'empty',
  'root-unchanged': 'contaminated',
};

const PRECEDENCE: readonly FailureClass[] = ['contaminated', 'model', 'setup', 'transport', 'timeout', 'empty'];

/**
 * The leg's class from its failed checks: contamination always wins; then a signature from stderr or an error
 * response (usage limit, auth, ...); then a timeout; then the most serious check class.
 */
export function acpFailureClass(failed: readonly string[], classOf: Readonly<Record<string, FailureClass>>, signature: FailureClass | null, timedOut: boolean): FailureClass | null {
  if (failed.length === 0) return null;
  const classes = new Set<FailureClass>(failed.map((name) => classOf[name] ?? 'setup'));
  if (classes.has('contaminated')) return 'contaminated';
  if (signature !== null) return signature;
  if (timedOut) return 'timeout';
  for (const cls of PRECEDENCE) if (classes.has(cls)) return cls;
  return 'setup';
}

function judged(call: AcpToolCall, root: string, readKinds: readonly string[], aliases: string[]) {
  return judgeRead(call.fields, call.kinds, root, readKinds, aliases);
}

export function ratifyAcpCommon(input: AcpCommonInput): AcpCommonResult {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const aliases = rootAliases(input.root);
  const log = readAcpLog(input.logFile);

  check(
    'log',
    log.exists && log.malformed === 0 && log.rawLines.length === 0 && log.tornLine === null,
    !log.exists
      ? `no update log at ${input.logFile}`
      : `${log.malformed} malformed log line(s), ${log.rawLines.length} non-JSON stdout line(s)${log.tornLine !== null ? ', a torn last line' : ''}`,
  );

  const init = log.initialize;
  const initResult = init && isObject(init.result) ? init.result : null;
  check('handshake', initResult !== null && init?.error === null, initResult ? `initialize: protocol ${String(initResult['protocolVersion'])}` : `initialize failed: ${init?.error ?? 'no response'}`);

  const sn = log.sessionNew;
  const mcp = sn ? sn.params['mcpServers'] : undefined;
  check(
    'session',
    sn !== null && sn.error === null && log.sessionId !== null && Array.isArray(mcp) && mcp.length === 0,
    sn === null
      ? 'no session/new'
      : sn.error !== null
        ? `session/new failed: ${sn.error}`
        : !Array.isArray(mcp) || mcp.length > 0
          ? 'session/new was not sent with mcpServers: []'
          : `session ${String(log.sessionId)}`,
  );
  const cwd = sn ? str(sn.params['cwd']) : null;
  // No session/new at all fails `session` (setup); this check judges the cwd a sent session/new names.
  check('cwd', sn === null || (cwd !== null && aliases.includes(cwd.replace(/\/+$/, ''))), sn === null ? 'no session/new (session fails)' : `session/new cwd ${String(cwd)}`);

  // Pins: as the agent reported them before the prompt, and unchanged after it.
  // With no session the pins were never reached; the `session` check already fails the leg.
  for (const name of log.sessionId !== null ? (['mode', 'model', 'effort'] as const) : []) {
    const pins = input.pins.filter((p) => p.check === name);
    if (pins.length === 0) continue;
    const bad = pins.filter((p) => {
      const reported = log.configBefore[p.id];
      if (reported === undefined) return !p.launchOnly;
      return reported !== p.value;
    });
    check(
      name,
      bad.length === 0 && (log.prompt === null || log.pinsHeld),
      bad.length > 0
        ? bad.map((p) => `${p.id} reported ${String(log.configBefore[p.id])}, pinned ${p.value}`).join('; ')
        : log.refused !== null
          ? `the client refused the session: ${log.refused}`
          : pins.map((p) => `${p.id} = ${log.configBefore[p.id] ?? `${p.value} (launch flag)`}`).join(', '),
    );
  }
  // A session the client refused (a pin was not accepted or did not hold) never reached the prompt.
  check('refusal', log.refused === null, log.refused === null ? 'the client did not refuse the session' : `the client refused the session: ${log.refused}`);
  const switched = log.configAfter.filter((c) => input.pins.some((p) => p.id === c.id));
  check('mode-held', switched.length === 0, switched.length === 0 ? 'no pinned option changed after the prompt' : `changed after the prompt: ${switched.map((c) => `${c.id} = ${c.value}`).join(', ')}`);

  // Execution checks.
  const badGrants = log.permissions
    .filter((p) => p.decision === 'allow')
    .map((p) => {
      const call = p.toolCallId !== null ? log.toolCalls.get(p.toolCallId) : undefined;
      const fields = mergeToolCall(call?.fields, p.toolCall);
      const kinds = [...new Set([...(call?.kinds ?? []), ...(str(p.toolCall['kind']) !== null ? [String(p.toolCall['kind'])] : [])])];
      return { p, j: judgeRead(fields, kinds, input.root, input.readKinds, aliases) };
    })
    .filter(({ j }) => !(j.read && j.inside));
  check(
    'permissions',
    badGrants.length === 0,
    badGrants.length === 0
      ? `${log.permissions.length} permission request(s); ${log.permissions.filter((p) => p.decision === 'allow').length} in-root read(s) allowed, the rest rejected`
      : `granted beyond an in-root read: ${badGrants.map(({ p, j }) => `${String(p.toolCallId)} (${j.why})`).join('; ')}`,
  );

  const calls = [...log.toolCalls.values()];
  const ran = calls.filter(executed);
  const unasked = ran.filter((c) => c.asked === null && !judged(c, input.root, input.readKinds, aliases).read);
  const nonReadRan = ran.filter((c) => c.decision !== 'reject' && !judged(c, input.root, input.readKinds, aliases).read);
  check(
    'tools-used',
    nonReadRan.length === 0,
    nonReadRan.length === 0
      ? `${ran.length} tool call(s) ran, all reads`
      : `ran beyond the read set: ${nonReadRan.map((c) => `${c.titles[0] ?? c.id} [${c.kinds.join(',') || 'no kind'}]${c.asked === null ? ' with no permission request' : ' after an allow'}`).join('; ')}`,
  );
  const deniedRan = ran.filter((c) => c.decision === 'reject');
  check('denials-held', deniedRan.length === 0, deniedRan.length === 0 ? `${calls.filter((c) => c.decision === 'reject').length} rejected call(s), none ran` : `ran after the client rejected it: ${deniedRan.map((c) => c.titles[0] ?? c.id).join('; ')}`);
  const outside = ran
    .filter((c) => c.decision !== 'reject')
    .map((c) => ({ c, j: judged(c, input.root, input.readKinds, aliases) }))
    .filter(({ j }) => j.read && !j.inside);
  check('read-paths', outside.length === 0, outside.length === 0 ? 'every read that ran named paths inside the root' : outside.map(({ c, j }) => `${c.titles[0] ?? c.id}: ${j.why}`).join('; '));

  const reason = stopReason(log);
  check(
    'prompt',
    log.prompt !== null && log.prompt.error === null && reason === 'end_turn',
    log.prompt === null ? 'no prompt was sent' : log.prompt.error !== null ? `session/prompt failed: ${log.prompt.error}` : `stopReason ${String(reason)}`,
  );

  const answer = acpAnswer(log);
  check('answer', answer !== null, answer === null ? 'no agent message in the turn' : `${answer.length} characters in ${log.messageSegments.length} segment(s)`);
  const nonce = nonceOnFirstLine(answer, input.nonce);
  check('nonce', nonce.ok, nonce.detail);
  const residue = input.rootUnchanged?.();
  check('root-unchanged', residue?.unchanged === true, residue === undefined ? 'no residue sweep was given (fails closed)' : residue.unchanged ? 'tree hash unchanged' : `root changed: ${residue.changes.slice(0, 10).join(', ')}`);

  return {
    log,
    checks,
    answer,
    nonceSeen: nonce.ok,
    rootMutated: residue === undefined ? null : !residue.unchanged,
    // The tool's own name when the agent sends one (agy: `name`), else its kinds.
    toolsUsed: [...new Set(ran.flatMap((c) => (typeof c.fields['name'] === 'string' ? [c.fields['name']] : c.kinds)))].sort(),
    unasked: unasked.map((c) => ({ id: c.id, title: c.titles[0] ?? '', kinds: c.kinds })),
  };
}

/** Whether a path in an adapter record is the root (any spelling, `file://` or not). */
export function isRoot(path: string | null, root: string): boolean {
  if (path === null) return false;
  const p = decodeURIComponent(path.replace(/^file:\/\//, '')).replace(/\/+$/, '');
  return rootAliases(root).includes(p);
}
