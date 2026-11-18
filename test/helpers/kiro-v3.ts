import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readAcpLog, type AcpLog } from '../../src/adapters/acp/log.js';
import { createKiroAdapter, kiroTokenStore, type KiroAdapterOptions } from '../../src/adapters/kiro/index.js';
import type { LegHandle, Occupant, Preflight, Ratification, RoundCtx } from '../../src/adapters/types.js';
import { sqlite } from '../../src/store/sqlite.js';
import type { CommandResult, CommandRunner } from '../../src/transport/headless.js';
import { scratch } from './fixtures.js';

/*
 * The kiro v3 replay kit (P11): the fake v3 agent (test/fixtures/bin/fake-kiro-v3.mjs) playing the scrubbed P11
 * recordings in test/fixtures/kiro-v3 (kiro-cli 3.5.0), and the helpers that compose a case from them. Placeholders
 * the fake fills in: ${SESSION}, ${CWD} (the root), ${PARENT} (its parent), ${KIRO_HOME} (the leg's), ${NONCE} (from
 * the brief) and ${VERSION}.
 */

type Json = Record<string, unknown>;
export type Step = Json;

export const FAKE_V3 = new URL('../fixtures/bin/fake-kiro-v3.mjs', import.meta.url).pathname;
const DIR = new URL('../fixtures/kiro-v3/', import.meta.url).pathname;
const load = (name: string): Json => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Json;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export const GATE = load('gate.json');
export const HAPPY = load('happy.json');
export const FOLLOWUP = load('followup.json');
export const SIGNED_OUT = load('signed-out.json');
export const AGENT_FILE_BYTES = readFileSync(join(DIR, 'agent-file.json'));
export const LOG_LINE = readFileSync(join(DIR, 'kiro-log-line.txt'), 'utf8');
/** The model the recordings pinned (no effort levels). */
export const V3_MODEL = 'deepseek-3.2';
export const V3_NONCE = 'c0ffee00000b';

export const segments = (): Record<string, Step[]> => clone(FOLLOWUP['segments'] as Record<string, Step[]>);
export const happySteps = (): Step[] => clone(HAPPY['steps'] as Step[]);
/**
 * The P3-file run's loop guard answered `cancelled`, which kiro recorded as keep-iterating, with its prompt call's id
 * moved to the follow-up turn's loop guard (the two recordings are separate runs).
 */
export const keepIterating = (): Step[] =>
  JSON.parse(JSON.stringify(FOLLOWUP['keepIterating']).split('failure-intervention-prompt-1000000000003').join('failure-intervention-prompt-1000000000001')) as Step[];

export const msg = (method: string, params: Json): Step => ({ msg: { jsonrpc: '2.0', method, params } });
export const update = (u: Json): Step => msg('session/update', { sessionId: '${SESSION}', update: u });
export const chunk = (text: string): Step => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
/** The NONCE line first, then a verdict: a ratifiable answer. */
export const NONCE_CHUNK = chunk('NONCE: ${NONCE}\nVERDICT: SHIP\n\n');
export const turnCompletion = (usedTools: string[], usage = 0.2293535290215589, status = 'success'): Step =>
  update({ sessionUpdate: 'session_info_update', _meta: { kiro: { promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage, usedTools }], elapsedTime: 1000, status, kind: 'turn_completion' } } });
export const turnEnd = (stopReason = 'end_turn'): Step => update({ sessionUpdate: 'session_info_update', _meta: { kiro: { turnEnd: { stopReason }, kind: 'turn_end', stopReason } } });

/** The steps of one tool call: reported, run in progress, and completed with output (or failed with an error). */
export function call(id: string, title: string, kind: string, rawInput: Json, opts: { output?: string; failed?: boolean; origin?: string | null; locations?: Json[] } = {}): Step[] {
  const meta = opts.origin === null ? {} : { _meta: { kiro: { toolOrigin: opts.origin ?? 'default' } } };
  const where = opts.locations !== undefined ? { locations: opts.locations } : {};
  const text = opts.output ?? 'ok';
  return [
    update({ sessionUpdate: 'tool_call', toolCallId: id, title, kind, status: 'pending', rawInput, ...where, ...meta }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'in_progress', rawInput, ...where, ...meta }),
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: opts.failed === true ? 'failed' : 'completed',
      title,
      rawInput,
      rawOutput: { message: text },
      content: [{ type: 'content', content: { type: 'text', text } }],
      ...where,
      ...meta,
    }),
  ];
}

const TITLE_NAMES: Record<string, string> = { 'Read File': 'read_file', 'Grep Search': 'grep_search', 'List Directory': 'list_directory', 'File Search': 'file_search', 'Load Resource': 'load_resource' };
const isGuard = (id: string): boolean => id.startsWith('failure-intervention-');

/** The steps as the fake runs them: an ask's branch picked by `answer` (default: the first branch). */
export function flatten(steps: readonly Step[], answer: (ask: Json) => string | undefined = () => undefined): Json[] {
  const out: Json[] = [];
  for (const s of steps) {
    if (s['ask'] !== undefined) {
      const answers = (s['answers'] ?? {}) as Record<string, Step[]>;
      const key = answer(s['ask'] as Json) ?? Object.keys(answers)[0];
      out.push({ asked: s['ask'], answer: key });
      out.push(...flatten((key !== undefined ? answers[key] : undefined) ?? (s['otherwise'] as Step[] | undefined) ?? [], answer));
    } else if (s['msg'] !== undefined) out.push(s['msg'] as Json);
  }
  return out;
}

/** The tool calls a step list reports, in order, as kiro's usedTools names them (loop-guard calls left out). */
export function usedToolsOf(steps: readonly Step[]): string[] {
  const seen: string[] = [];
  for (const m of flatten(steps)) {
    const u = ((m['params'] as Json | undefined)?.['update'] ?? {}) as Json;
    if (u['sessionUpdate'] === 'tool_call' && typeof u['toolCallId'] === 'string' && !isGuard(u['toolCallId'])) seen.push(TITLE_NAMES[String(u['title'])] ?? `title:${String(u['title'])}`);
  }
  return seen;
}

/** A messages.jsonl synthesized from a step list: the model note, every call and its result, the credit split. */
export function messagesFor(steps: readonly Step[], opts: { model?: string; notes?: string[]; delegated?: number; creditSplit?: boolean; drop?: string[]; rename?: Record<string, string> } = {}): Json[] {
  const notes = opts.notes ?? [opts.model ?? V3_MODEL];
  const rows: Json[] = notes.map((m, i) => ({ id: `note-${i}`, timestamp: '2026-11-18T20:10:47.466Z', payload: { type: 'agent_note', content: `<session_context>\nThe current model is ${m}.\n</session_context>` } }));
  const titles = new Map<string, string>();
  const terminal = new Map<string, string>();
  const rejected = new Set<string>();
  for (const m of flatten(steps)) {
    if (m['asked'] !== undefined) {
      const id = String(((m['asked'] as Json)['toolCall'] as Json)['toolCallId']);
      if (m['answer'] === 'reject') rejected.add(id);
      continue;
    }
    const u = ((m['params'] as Json | undefined)?.['update'] ?? {}) as Json;
    const id = typeof u['toolCallId'] === 'string' ? u['toolCallId'] : null;
    if (id === null || isGuard(id)) continue;
    if (u['sessionUpdate'] === 'tool_call') titles.set(id, String(u['title']));
    if (u['status'] === 'completed' || u['status'] === 'failed') terminal.set(id, String(u['status']));
  }
  for (const [id, title] of titles) {
    if (opts.drop?.includes(id)) continue;
    rows.push({ id: `${id}-call`, payload: { type: 'tool_call', toolCallId: id, toolName: opts.rename?.[id] ?? TITLE_NAMES[title] ?? title, status: 'pending', title } });
    const done = terminal.get(id);
    if (done !== undefined) rows.push({ id: `${id}-result`, payload: { type: 'tool_result', toolCallId: id, success: done === 'completed', status: rejected.has(id) ? 'denied' : 'approved', title } });
  }
  if (opts.creditSplit !== false) rows.push({ id: 'split', payload: { type: 'session_metadata', key: 'creditSplit', value: { main: 0.2, delegated: opts.delegated ?? 0, auxiliary: 0.006 } } });
  rows.push({ id: 'end', payload: { type: 'turn_end', stopReason: 'end_turn' } });
  return rows;
}

export const SESSION_DIR = '${KIRO_HOME}/sessions/0000000000000002/${SESSION}';

/** The recorded session.json, with fields replaced. */
export function sessionJson(over: Json = {}): Json {
  return { ...clone(HAPPY['session'] as Json), ...over };
}

export interface V3Case {
  steps: Step[];
  /** messages.jsonl rows (default: synthesized from the steps); null: none written. */
  messages?: Json[] | null;
  /** session.json (default: the recorded one); null: none written. */
  session?: Json | null;
  /** kiro.log lines (default: the recorded user-agent line); null: no log. */
  log?: string | null;
  /** Anything else the fake takes (gate overrides, config, onSet, forceConfig, ...). */
  extra?: Json;
}

/** The fake's case: the recorded gate, then the case's own steps and records. */
export function v3Case(c: V3Case): Json {
  const gate = clone(GATE);
  const records: Json[] = [];
  if (c.session !== null) records.push({ path: `${SESSION_DIR}/session.json`, json: c.session ?? sessionJson() });
  if (c.messages !== null) records.push({ path: `${SESSION_DIR}/messages.jsonl`, jsonl: c.messages ?? messagesFor(c.steps) });
  return {
    initialize: gate['initialize'],
    config: gate['config'],
    sessionNew: gate['sessionNew'],
    onSet: gate['onSet'],
    steps: c.steps,
    records,
    startRecords: c.log === null ? [] : [{ path: '${KIRO_HOME}/logs/20261118T000000000-1/kiro.log', content: c.log ?? LOG_LINE }],
    ...(c.extra ?? {}),
  };
}

/** The happy path's steps with the NONCE line first. */
export function happyCase(): V3Case {
  return { steps: [NONCE_CHUNK, ...happySteps()], messages: clone(HAPPY['messages'] as Json[]) };
}

function out(stdout: string, exitCode = 0, stderr = ''): CommandResult {
  return { exitCode, signal: null, stdout, stderr, timedOut: false, durationMs: 1, error: null };
}

export interface RunnerCall {
  args: string[];
  home: string | undefined;
  kiroHome: string | undefined;
  /** The scratch KIRO_HOME's settings file as it was when the command ran. */
  settings: string | null;
  /** Files under the scratch KIRO_HOME when the command ran. */
  files: string[];
}

/** A preflight runner: `kiro-cli <version>`, and a model list. It records what each command ran with. */
export function v3Runner(version = '3.5.0', models: readonly string[] = ['auto', V3_MODEL, 'claude-sonnet-4.5', 'claude-haiku-4.5']): { run: CommandRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const run: CommandRunner = async (_cmd, args, options) => {
    const kh = options.env['KIRO_HOME'];
    const settingsFile = kh !== undefined ? join(kh, 'settings', 'cli.json') : null;
    const list = (dir: string, prefix = ''): string[] =>
      existsSync(dir)
        ? (readdirSafe(dir) ?? []).flatMap((n) => {
            const p = join(dir, n);
            return isDir(p) ? list(p, `${prefix}${n}/`) : [`${prefix}${n}`];
          })
        : [];
    calls.push({ args: [...args], home: options.env['HOME'], kiroHome: kh, settings: settingsFile !== null && existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : null, files: kh !== undefined ? list(kh) : [] });
    if (args[0] === '--version') return out(`kiro-cli ${version}\n`);
    if (args[0] === 'chat' && args[1] === '--list-models') return out(JSON.stringify({ models: models.map((m) => ({ model_id: m })), default_model: 'auto' }));
    return out('', 2, 'unexpected');
  };
  return { run, calls };
}

function readdirSafe(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

/** A HOME with a kiro token store holding only the fields preflight reads (darwin layout). */
export function tokenHome(): string {
  const home = scratch('sc-kiro3-home-');
  const store = kiroTokenStore(home, 'darwin');
  mkdirSync(join(store, '..'), { recursive: true });
  const db = new (sqlite().DatabaseSync)(store);
  db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run('kirocli:odic:token', JSON.stringify({ access_token: 'never-read', expires_at: FUTURE, refresh_token: 'never-read' }));
  db.close();
  return home;
}

/** A leg dir, a root and an outside file beside it (`${PARENT}/outside.txt`). */
export function v3Ctx(): RoundCtx & { parent: string } {
  const parent = realpathSync(scratch('sc-kiro3-leg-'));
  const root = join(parent, 'root');
  mkdirSync(root);
  writeFileSync(join(root, 'NOTES.md'), '# Notes\n');
  writeFileSync(join(parent, 'outside.txt'), 'secret\n');
  const legDir = join(parent, 'leg');
  mkdirSync(legDir);
  const briefFile = join(parent, 'BRIEF.md');
  writeFileSync(briefFile, `NONCE: ${V3_NONCE}\nreview\n`);
  return { root, legDir, nonce: V3_NONCE, briefFile, timeoutMs: 20_000, env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: '/nonexistent-real-home' }, rootUnchanged: () => ({ unchanged: true, changes: [] }), parent };
}

export interface V3Run {
  r: Ratification;
  pre: Preflight;
  handle: LegHandle;
  ctx: RoundCtx & { parent: string };
  home: string;
  cls: ReturnType<ReturnType<typeof createKiroAdapter>['classify']>;
  log: AcpLog;
  failed: string[];
  argv: { args: string[]; env: string[] };
  /** Every permission answer the fake received: { toolCallId, answer }. */
  answers: Array<{ toolCallId: string | null; answer: string }>;
  calls: RunnerCall[];
}

/** Preflight, launch, poll and ratify one v3 leg on the fake agent. */
export async function launchV3(kase: Json, opts: { o?: Partial<Occupant>; version?: string; adapter?: KiroAdapterOptions; models?: string[] } = {}): Promise<V3Run> {
  const home = tokenHome();
  const o: Occupant = { backend: 'kiro', model: V3_MODEL, authHome: home, ...opts.o };
  const ctx = v3Ctx();
  writeFileSync(join(home, 'fake-kiro-v3.json'), JSON.stringify({ version: opts.version ?? '3.5.0', ...kase }));
  const { run, calls } = v3Runner(opts.version ?? '3.5.0', opts.models);
  const adapter = createKiroAdapter({ bin: FAKE_V3, runner: run, platform: 'darwin', gateWaitMs: 400, ...opts.adapter });
  const pre = await adapter.preflight(o, ctx);
  if (!pre.ok) throw new Error(`preflight failed: ${String(pre.reason)}`);
  const handle = await adapter.launch(o, ctx, pre);
  while ((await adapter.poll(handle)).status !== 'done') await new Promise((res) => setTimeout(res, 40));
  const r = await adapter.ratify(handle, ctx);
  const readJson = <T>(name: string, fallback: T): T => (existsSync(join(home, name)) ? (JSON.parse(readFileSync(join(home, name), 'utf8')) as T) : fallback);
  return {
    r,
    pre,
    handle,
    ctx,
    home,
    cls: adapter.classify(handle),
    log: readAcpLog(handle.files['log'] ?? ''),
    failed: r.checks.filter((c) => !c.ok).map((c) => c.name).sort(),
    argv: readJson('fake-kiro-v3-argv.json', { args: [], env: [] }),
    answers: readJson('fake-kiro-v3-answers.json', []),
    calls,
  };
}
