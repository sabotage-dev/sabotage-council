import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FailureClass } from '../../config/vocab.js';
import { isObject, num, readJsonl, str, type Json } from '../codex/records.js';
import { rootAliases } from '../paths.js';
import { nonceOnFirstLine, verdictOf, type Ratification, type RatificationCheck } from '../types.js';
import { collectPaths, judgePath } from '../acp/policy.js';
import { MUSE_READ_TOOLS, modelOfOperation, museDecl } from './known.js';

/*
 * Muse failure signatures (plan 4.4) and ratification (plan 4.5), from the `--json` envelope stream, the session
 * log in the leg's XDG data dir and the offline `muse export` (export ratification), fail closed.
 */

export const MUSE_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  { class: 'usage_limit', pattern: /tierLimit|usage limit|limit refreshes|billing_not_configured|billing_error|status 402/i },
  { class: 'auth', pattern: /not logged in|authRequired|invalid_api_key|authentication_error|download was rejected \(HTTP 401\)/i },
  { class: 'setup', pattern: /cannot be used with|malformed settings file|unsupported settings schema|--trust-workspace|^usage: muse|^exit-code 2$|muse is available to Meta employees/im },
  { class: 'model', pattern: /model_not_found|unknown model|rejects? .*model/i },
  { class: 'capacity', pattern: /rate_limit_exceeded|rate_limit_error|\b429\b|service_overloaded|backend_unavailable|gateway_timeout/i },
  { class: 'transport', pattern: /could not reach|ECONNRESET|ECONNREFUSED|socket hang up/i },
];

export function classifyMuseText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of MUSE_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}

export interface MuseRatifyInput {
  root: string;
  nonce: string;
  model: string;
  effort: string;
  sessionId: string;
  cliVersion: string | null;
  streamFile: string;
  stderrFile: string;
  processFile: string;
  /** The leg's XDG data dir; the session log is under `muse/sessions/YYYY/MM/DD/<id>/`. */
  dataDir: string;
  exportFile: string;
  timedOut: boolean;
  exitCode: number | null;
  rootUnchanged: (() => { unchanged: boolean; changes: string[] }) | undefined;
}

export const MUSE_CLASS_OF_CHECK: Readonly<Record<string, FailureClass>> = {
  stream: 'setup',
  session: 'setup',
  'session-log': 'setup',
  export: 'setup',
  build: 'setup',
  terminated: 'transport',
  workspace: 'contaminated',
  contributor: 'contaminated',
  flags: 'contaminated',
  mcp: 'contaminated',
  'tools-used': 'contaminated',
  'read-paths': 'contaminated',
  activity: 'setup',
  model: 'model',
  effort: 'model',
  'model-steps': 'model',
  subagents: 'contaminated',
  terminal: 'transport',
  answer: 'empty',
  nonce: 'empty',
  'root-unchanged': 'contaminated',
};

const PRECEDENCE: readonly FailureClass[] = ['contaminated', 'model', 'setup', 'transport', 'timeout', 'empty'];

export function museFailureClass(failed: readonly string[], signature: FailureClass | null, timedOut: boolean): FailureClass | null {
  if (failed.length === 0) return null;
  const classes = new Set<FailureClass>(failed.map((name) => MUSE_CLASS_OF_CHECK[name] ?? 'setup'));
  if (classes.has('contaminated')) return 'contaminated';
  if (signature !== null) return signature;
  if (timedOut) return 'timeout';
  for (const cls of PRECEDENCE) if (classes.has(cls)) return cls;
  return 'setup';
}

/** Every value under `v` whose key matches, at any depth. */
function valuesOf(v: unknown, key: RegExp, out: unknown[] = []): unknown[] {
  if (Array.isArray(v)) for (const x of v) valuesOf(x, key, out);
  else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (key.test(k)) out.push(x);
      else valuesOf(x, key, out);
    }
  }
  return out;
}

export function findMuseSessionLog(dataDir: string, sessionId: string): string | null {
  const base = join(dataDir, 'muse', 'sessions');
  if (!existsSync(base)) return null;
  for (const y of readdirSync(base)) for (const m of existsSync(join(base, y)) ? readdirSync(join(base, y)) : []) {
    for (const d of readdirSync(join(base, y, m))) {
      const p = join(base, y, m, d, sessionId, 'session.jsonl');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

const payloadOf = (row: Json): Json => (isObject(row['payload']) ? row['payload'] : {});

/** The muse answer: the completed terminal record's text. */
export function museAnswer(rows: readonly Json[]): string | null {
  const t = rows.find((r) => str(r['payload_type']) === 'run.terminal.completed');
  const text = t ? str(payloadOf(t)['text']) : null;
  return text !== null && text.trim() !== '' ? text : null;
}

export function readMuseStream(path: string): { rows: Json[]; malformed: number } {
  if (!existsSync(path)) return { rows: [], malformed: 0 };
  const r = readJsonl(path);
  return { rows: r.rows, malformed: r.malformed + (r.tornTail ? 1 : 0) };
}

export function ratifyMuseLeg(input: MuseRatifyInput): Ratification {
  const checks: RatificationCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const aliases = rootAliases(input.root);
  const stream = readMuseStream(input.streamFile);
  const rows = stream.rows;
  const stderr = existsSync(input.stderrFile) ? readFileSync(input.stderrFile, 'utf8') : '';
  const errorPayloads = rows.filter((r) => /error|failed|terminal\.(?!completed)/.test(str(r['payload_type']) ?? '')).map((r) => JSON.stringify(payloadOf(r)));
  const signature = classifyMuseText([stderr, ...errorPayloads, ...(input.exitCode === 2 ? ['exit-code 2'] : [])]);
  const terminal = rows.find((r) => /^run\.terminal\./.test(str(r['payload_type']) ?? ''));

  check('stream', rows.length > 0 && stream.malformed === 0 && terminal !== undefined, rows.length === 0 ? 'no envelope stream' : `${rows.length} envelope(s), ${stream.malformed} malformed${terminal === undefined ? ', no run terminal record' : ''}`);
  const sessionStreams = rows.filter((r) => isObject(r['stream']) && str(r['stream']['kind']) === 'session');
  const otherIds = [...new Set(rows.filter((r) => isObject(r['stream'])).map((r) => str((r['stream'] as Json)['id'])).filter((id) => id !== input.sessionId).map(String))];
  check('session', sessionStreams.length > 0 && otherIds.length === 0, otherIds.length === 0 ? `${sessionStreams.length} session record(s) for ${input.sessionId}` : `records for other streams: ${otherIds.join(', ')}`);
  const log = findMuseSessionLog(input.dataDir, input.sessionId);
  const logRows = log !== null ? readMuseStream(log) : null;
  check('session-log', logRows !== null && logRows.rows.length > 0 && logRows.malformed === 0, log === null ? `no session log for ${input.sessionId} under the leg's XDG data dir` : `${log}: ${logRows?.rows.length ?? 0} record(s)`);

  let exp: Json | null = null;
  try {
    const v: unknown = existsSync(input.exportFile) ? JSON.parse(readFileSync(input.exportFile, 'utf8')) : null;
    exp = isObject(v) ? v : null;
  } catch {
    exp = null;
  }
  const sessions = exp && Array.isArray(exp['sessions']) ? exp['sessions'].filter(isObject) : [];
  const diag = exp && isObject(exp['diagnostics']) ? exp['diagnostics'] : {};
  const badDiag = ['unparseable_lines', 'unknown_payload_kinds', 'gaps', 'duplicate_records'].filter((k) => (num(diag[k]) ?? 0) !== 0);
  // The recorded 1.4.15 export is a summary (sessions, diagnostics, `first_events` without envelopes): the stdout
  // stream and the session log are the record. An export that does carry `events[]` (round 2: optional
  // corroboration) must give every event its envelope, and those envelopes are audited with the rest.
  const exportEvents = exp && Array.isArray(exp['events']) ? exp['events'].filter(isObject) : null;
  const exported = (exportEvents ?? []).map((e) => (isObject(e['envelope']) ? e['envelope'] : null)).filter((e): e is Json => e !== null);
  check(
    'export',
    exp !== null &&
      exp['export_schema_version'] === 1 &&
      sessions.length === 1 &&
      str(sessions[0]?.['session_id']) === input.sessionId &&
      badDiag.length === 0 &&
      (exportEvents === null || exported.length === exportEvents.length),
    exp === null
      ? `no export at ${input.exportFile}`
      : `${sessions.length} session(s) (${sessions.map((s) => String(s['session_id'])).join(', ')}); diagnostics ${badDiag.length === 0 ? 'clean' : badDiag.join(', ')}; ${exportEvents === null ? 'no events[] (a summary export: the stream and the session log are the record)' : `${exported.length} of ${exportEvents.length} event(s) carry an envelope`}`,
  );
  const none = exp === null;
  const noExport = 'no export (export fails)';
  const build = exp && isObject(exp['session_build']) ? str(exp['session_build']['semver']) : null;
  check('build', none || build === input.cliVersion, none ? noExport : `session_build ${String(build)}, preflight ${String(input.cliVersion)}`);
  const end = sessions[0] && isObject(sessions[0]['session_end']) ? sessions[0]['session_end'] : {};
  check('terminated', none || (exp?.['session_terminated_abnormally'] === false && str(end['exit_reason']) === 'clean'), none ? noExport : `terminated abnormally ${String(exp?.['session_terminated_abnormally'])}, exit reason ${String(end['exit_reason'])}`);
  const spawns = sessions[0] && Array.isArray(sessions[0]['accepted_spawns']) ? sessions[0]['accepted_spawns'] : [];
  check('subagents', none || spawns.length === 0, none ? noExport : spawns.length === 0 ? 'no subagent spawned' : `${spawns.length} subagent spawn(s) accepted`);

  // Every record the leg left, audited together: the stdout stream, the session log and the export's events.
  const everything = [...rows, ...(logRows?.rows ?? []), ...exported];
  const decl = museDecl(input.cliVersion);
  const roots = valuesOf(everything, /^(?:canonical_)?workspace_root$/).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  const badRoots = [...new Set(roots.filter((r) => !aliases.includes(r.replace(/\/+$/, ''))))];
  check('workspace', roots.length > 0 && badRoots.length === 0, roots.length === 0 ? 'no workspace_root recorded' : badRoots.length === 0 ? `workspace_root = root (${roots.length})` : `workspace_root not the root: ${badRoots.join(', ')}`);
  // Any value that is not a clear "off" counts as on (claude F3): `true`, `"enabled"`, `{enabled: true}`, ...
  const contributor = valuesOf(everything, /contributor/i);
  const off = (v: unknown): boolean => v === false || v === 0 || v === null || (typeof v === 'string' && /^(?:off|false|disabled|no|0)$/i.test(v));
  const on = contributor.filter((v) => !off(v));
  const contributorRecorded = decl?.records.contributor ?? true;
  check(
    'contributor',
    on.length === 0 && (contributor.length > 0 || !contributorRecorded),
    on.length > 0
      ? `contributor mode on in the records: ${JSON.stringify(on).slice(0, 200)}`
      : contributor.length > 0
        ? `contributor mode off in ${contributor.length} record field(s)`
        : contributorRecorded
          ? `no contributor-mode field in the records, which ${input.cliVersion === null ? 'an unknown version' : `muse ${input.cliVersion}`} is not declared to omit`
          : `not recorded by muse ${String(input.cliVersion)} (declared from its records); the leg ran with --contributor-mode off and MUSE_CONTRIBUTOR_MODE=0`,
  );
  let args: string[] = [];
  try {
    const p: unknown = JSON.parse(readFileSync(input.processFile, 'utf8'));
    args = isObject(p) && Array.isArray(p['args']) ? p['args'].map(String) : [];
  } catch {
    args = [];
  }
  const flagProblems: string[] = [
    ...(args[args.indexOf('--contributor-mode') + 1] === 'off' && args.includes('--contributor-mode') ? [] : ['--contributor-mode off missing']),
    ...(args.includes('--permission-profile') && args[args.indexOf('--permission-profile') + 1] === ':read-only' ? [] : ['--permission-profile :read-only missing']),
    ...['--disable-write', '--disable-shell', '--disable-web-tools'].filter((f) => !args.includes(f)).map((f) => `${f} missing`),
    ...['--trust-workspace', '--yolo', '--disable-sandbox', '--disable-approval', '--no-session-log'].filter((f) => args.includes(f)).map((f) => `${f} passed`),
  ];
  const profiles = valuesOf(everything, /^permission_?[Pp]rofile$/);
  const profileRecorded = decl?.records.profile ?? true;
  if (profiles.some((p) => p !== ':read-only')) flagProblems.push(`the records name a permission profile other than :read-only: ${JSON.stringify(profiles)}`);
  if (profileRecorded && profiles.length === 0) flagProblems.push('no permission profile in the records, which this version is not declared to omit');
  check(
    'flags',
    flagProblems.length === 0,
    flagProblems.length === 0
      ? `the engine's launch record has contributor mode off, the read-only profile and write, shell and web tools disabled${profiles.length > 0 ? '; the records name :read-only' : '; the profile is not recorded by this version (declared)'}`
      : flagProblems.join('; '),
  );

  const usage = rows.filter((r) => str(r['payload_type']) === 'run.usage').flatMap((r) => (Array.isArray(payloadOf(r)['models']) ? (payloadOf(r)['models'] as unknown[]) : [])).filter(isObject);
  const models = usage.map((u) => str(u['model']));
  const badModels = [...new Set(models.filter((m) => m !== input.model).map(String))];
  check('model', models.length > 0 && badModels.length === 0, models.length === 0 ? 'no run.usage model entry' : badModels.length === 0 ? `model ${input.model} on ${models.length} usage entr(ies)` : `model not the pin ${input.model}: ${badModels.join(', ')}`);
  const efforts = valuesOf(everything, /^reasoning_?[Ee]ffort$/).filter((v) => v !== null);
  const badEfforts = efforts.filter((e) => e !== input.effort);
  const effortRecorded = decl?.records.effort ?? true;
  check(
    'effort',
    badEfforts.length === 0 && (efforts.length > 0 || !effortRecorded),
    badEfforts.length > 0
      ? `effort not the pin ${input.effort}: ${JSON.stringify(badEfforts)}`
      : efforts.length > 0
        ? `effort ${input.effort} (${efforts.length})`
        : effortRecorded
          ? 'no effort in the records, which this version is not declared to omit'
          : `not recorded by muse ${String(input.cliVersion)} (declared from its records)`,
  );

  // Every task the records show (round 1 row 4): its kind from `task.lifecycle.proposed` and every side-effect
  // operation. A model step must name the pinned model; a tool must be a declared read with every path inside the
  // root; MCP fails; any other shape fails; and a run with model calls but no task records is not evidence.
  const tasks = new Map<string, { kinds: Set<string>; payloads: Json[] }>();
  for (const r of everything) {
    if (!/^task\.lifecycle\./.test(str(r['payload_type']) ?? '')) continue;
    const p = payloadOf(r);
    const event = isObject(p['event']) ? p['event'] : {};
    const id = str(p['task_id']) ?? str(event['task_id']) ?? '?';
    const t = tasks.get(id) ?? { kinds: new Set<string>(), payloads: [] };
    for (const k of [str(event['task_kind']), str(event['operation'])]) if (k !== null) t.kinds.add(k);
    t.payloads.push(event);
    tasks.set(id, t);
  }
  const shapeless = [...tasks].filter(([, t]) => t.kinds.size === 0).map(([id]) => id);
  const mcp = [...new Set([...tasks.values()].flatMap((t) => [...t.kinds]).filter((k) => /mcp/i.test(k)))];
  const otherModels: string[] = [];
  const nonReads: string[] = [];
  const reads: Array<{ id: string; name: string; payloads: Json[] }> = [];
  for (const [id, t] of tasks) {
    for (const k of t.kinds) {
      if (/mcp/i.test(k)) continue;
      const model = modelOfOperation(k);
      if (k.startsWith('model.')) {
        if (model !== input.model) otherModels.push(k);
        continue;
      }
      const tool = /^tool[.:]([A-Za-z0-9_-]+)$/.exec(k)?.[1];
      if (tool !== undefined && (MUSE_READ_TOOLS as readonly string[]).includes(tool)) reads.push({ id, name: tool, payloads: t.payloads });
      else nonReads.push(k);
    }
  }
  check('mcp', mcp.length === 0, mcp.length === 0 ? 'no MCP task' : `MCP use: ${mcp.join(', ')}`);
  check('model-steps', otherModels.length === 0, otherModels.length > 0 ? `model steps not on the pin ${input.model}: ${[...new Set(otherModels)].join(', ')}` : `${tasks.size} task(s), every model step on ${input.model}`);
  check('tools-used', nonReads.length === 0, nonReads.length === 0 ? `${reads.length} read task(s), no other tool` : `tasks beyond the read set: ${[...new Set(nonReads)].join(', ')}`);
  const outside: string[] = [];
  const unjudged: string[] = [];
  for (const r of reads) {
    const found = collectPaths(r.payloads.map((p) => ({ rawInput: p })));
    if (found.paths.length === 0 || found.problems.length > 0) unjudged.push(`${r.name} ${r.id}`);
    for (const path of found.paths) {
      const j = judgePath(path, input.root, aliases);
      if (!j.inside) outside.push(`${r.name} ${path} (${j.why})`);
    }
  }
  check('read-paths', outside.length === 0, outside.length === 0 ? 'every read task named paths inside the root' : outside.join('; '));
  const calls = rows.filter((r) => str(r['payload_type']) === 'run.usage').reduce((n, r) => n + (num(payloadOf(r)['calls']) ?? 0), 0);
  const gaps = [
    ...(unjudged.length > 0 ? [`read tasks with no path the ratifier can judge: ${unjudged.join(', ')}`] : []),
    ...(shapeless.length > 0 ? [`tasks with no kind or operation: ${shapeless.join(', ')}`] : []),
    ...(calls > 0 && tasks.size === 0 ? [`${calls} model call(s) but no task record: no evidence of what the run did`] : []),
  ];
  check('activity', gaps.length === 0, gaps.length === 0 ? `${tasks.size} task(s) recorded for ${calls} model call(s), every one classified` : gaps.join('; '));
  const term = terminal ? payloadOf(terminal) : null;
  check('terminal', term !== null && str(term['terminal']) === 'completed' && str(terminal?.['payload_type']) === 'run.terminal.completed', term === null ? 'no terminal record' : `${String(terminal?.['payload_type'])} ${String(term['terminal'])}${term['reason'] ? ` (${JSON.stringify(term['reason'])})` : ''}`);
  const answer = museAnswer(rows);
  check('answer', answer !== null, answer === null ? 'no completed terminal text' : 'answer in run.terminal.completed');
  const nonce = nonceOnFirstLine(answer, input.nonce);
  check('nonce', nonce.ok, nonce.detail);
  const residue = input.rootUnchanged?.();
  check('root-unchanged', residue?.unchanged === true, residue === undefined ? 'no residue sweep was given (fails closed)' : residue.unchanged ? 'tree hash unchanged' : `root changed: ${residue.changes.slice(0, 10).join(', ')}`);

  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  const failureClass = museFailureClass(failed, signature, input.timedOut);
  const { ok, status } = verdictOf(checks, failureClass);
  const sum = (k: string): number | null => (usage.length === 0 ? null : usage.reduce((a, u) => a + (num(u[k]) ?? 0), 0));
  return {
    status,
    ok,
    failureClass,
    checks,
    enforcement: 'weak',
    recordPath: log,
    sessionId: input.sessionId,
    cliVersion: build ?? input.cliVersion,
    modelObserved: models.find((m) => m !== null) ?? null,
    effortObserved: typeof efforts[0] === 'string' ? efforts[0] : null,
    cwdObserved: roots[0] ?? null,
    cwdOk: checks.find((c) => c.name === 'workspace')?.ok ?? false,
    toolsOffered: [],
    toolsUsed: [...new Set(reads.map((r) => r.name))].sort(),
    tokensIn: sum('input_tokens'),
    tokensOut: sum('output_tokens'),
    costUsd: null,
    credits: null,
    quotaUsedPct: null,
    quotaNote: null,
    durationMs: null,
    nonceSeen: nonce.ok,
    rootMutated: residue === undefined ? null : !residue.unchanged,
    detail: { tasks: [...tasks].map(([id, t]) => ({ id, kinds: [...t.kinds] })), signature, exportFile: input.exportFile },
  };
}
