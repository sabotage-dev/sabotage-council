import type { ModelInfo } from '../config/registry.js';
import { checkNonce, type NonceCheck } from '../parse/index.js';
import type { BackendId, FailureClass } from '../config/vocab.js';
import type { HeadlessExit, HeadlessProcess } from '../transport/headless.js';

export type { FailureClass } from '../config/vocab.js';

/*
 * The seat adapter contract (plan 4.1) and the types every adapter shares. P2 implements it for codex and claude
 * on the headless transport; P3 and P4 add the rest.
 */

/** Plan 5.2. Declared by each adapter per tested version range and printed by `doctor`. */
export const ENFORCEMENT_LABELS = ['strong', 'sandboxed-exec', 'pending', 'weak'] as const;
export type EnforcementLabel = (typeof ENFORCEMENT_LABELS)[number];

export type Transport = 'headless' | 'acp';

/** The CLI versions an adapter was tested on. `doctor` warns outside `tested` and refuses below `floor`. */
export interface SemverRange {
  floor: string;
  tested: readonly string[];
}

/** backend + model + effort + transport (plan 2). */
export interface Occupant {
  backend: BackendId;
  model: string;
  effort?: string | undefined;
  /**
   * kiro seats only: the HOME kiro-cli runs with, so a separate Kiro login (for example a personal one beside a
   * work one) is read from its own token store. Absent: the user's HOME.
   */
  authHome?: string | undefined;
  /** grok seats only: the OS sandbox profile (plan 4.2). Absent: `read-only`. */
  sandbox?: 'read-only' | 'off' | undefined;
}

/** What a seat needs to know about the round. */
export interface RoundCtx {
  /** The sealed root, as a realpath. */
  root: string;
  /** This leg's own directory: streams, records and the process record go here. */
  legDir: string;
  nonce: string;
  /** The brief file the leg reads on stdin. */
  briefFile: string;
  /** Wall-clock cap for the leg (plan 3.1 step 5, default 25 min). */
  timeoutMs: number;
  /** The engine's environment, which adapters scrub. Default: `process.env`. */
  env?: NodeJS.ProcessEnv | undefined;
  /**
   * The residue sweep (plan 3.1 step 7): whether the root's tree hash still equals the sealed one. Ratification
   * fails closed when it is absent.
   */
  rootUnchanged?: (() => { unchanged: boolean; changes: string[] }) | undefined;
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'note';

export interface PreflightCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Preflight (plan 4.3): auth, version, model id and the isolation proof, with no model call. */
export interface Preflight {
  ok: boolean;
  backend: BackendId;
  cliVersion: string | null;
  enforcement: EnforcementLabel;
  checks: PreflightCheck[];
  /** User-owned context that loads into the leg (allowed, listed by `doctor`). */
  userOwned: string[];
  /** Set when `ok` is false. */
  failureClass: FailureClass | null;
  reason: string | null;
  /** What the adapter's launch needs from preflight (adapter-specific). */
  data: Record<string, unknown>;
}

/** A running or finished leg. `data` is adapter-specific. */
export interface LegHandle {
  backend: BackendId;
  occupant: Occupant;
  legDir: string;
  root: string;
  nonce: string;
  startedAt: Date;
  process: HeadlessProcess | null;
  /** The supervisor's exit record, once known. */
  exit: HeadlessExit | null;
  files: Record<string, string>;
  data: Record<string, unknown>;
}

export type LegState =
  | { status: 'running' }
  | { status: 'done'; doneBy: HeadlessExit['doneBy'] | 'record'; exit: HeadlessExit | null };

export interface LegText {
  /** The answer text from the NONCE line on, or the whole answer when the nonce is absent. Null: no answer. */
  text: string | null;
  /** Whether the nonce line was found and the text starts there. */
  fromNonce: boolean;
  /** Which record the text came from. */
  source: string;
}

export interface RatificationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export type RatificationStatus = 'PASS' | 'FAIL' | 'CONTAMINATED';

/**
 * Ratification (plan 4.5): every check and every field read from the CLI's own records, so stats and audits get
 * the evidence and not only a PASS bit. Fields that a backend does not record are null.
 */
export interface Ratification {
  status: RatificationStatus;
  ok: boolean;
  failureClass: FailureClass | null;
  checks: RatificationCheck[];
  enforcement: EnforcementLabel;
  recordPath: string | null;
  sessionId: string | null;
  cliVersion: string | null;
  modelObserved: string | null;
  effortObserved: string | null;
  cwdObserved: string | null;
  cwdOk: boolean;
  toolsOffered: string[];
  toolsUsed: string[];
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  credits: number | null;
  quotaUsedPct: number | null;
  quotaNote: string | null;
  durationMs: number | null;
  nonceSeen: boolean;
  rootMutated: boolean | null;
  /** Adapter-specific evidence (commands, children, permission denials). */
  detail: Record<string, unknown>;
}

export interface SeatAdapter {
  id: BackendId;
  transport: Transport;
  testedVersions: SemverRange;
  /** The label for a CLI version; `pending` or weaker for anything not declared. */
  enforcement(version: string | null): EnforcementLabel;
  /** No model call; used to validate config at load. */
  listModels(): Promise<ModelInfo[]>;
  preflight(o: Occupant, ctx: RoundCtx): Promise<Preflight>;
  launch(o: Occupant, ctx: RoundCtx, preflight?: Preflight): Promise<LegHandle>;
  /** Record-based done signal, with process exit as the secondary check. */
  poll(h: LegHandle): Promise<LegState>;
  collect(h: LegHandle): Promise<LegText>;
  ratify(h: LegHandle, ctx: RoundCtx): Promise<Ratification>;
  /** From stderr and error events, never from the answer text (plan 4.4). */
  classify(h: LegHandle): FailureClass | null;
  cancel(h: LegHandle): Promise<void>;
}

/**
 * The nonce contract (plan 3.9, 4.5 item 8), on the original answer before any trimming: its first non-empty line is
 * exactly `NONCE: <nonce>`. A nonce anywhere else (mid-sentence, on a later line, quoted from the brief) does not
 * count. A nonce that is not 12 hex characters never matches.
 */
export function nonceOnFirstLine(text: string | null, nonce: string): { ok: boolean; detail: string } {
  if (text === null) return { ok: false, detail: 'no answer to check' };
  let check: NonceCheck;
  try {
    check = checkNonce(text, nonce);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (check.verbatim) return { ok: true, detail: 'the first non-empty line is the NONCE line' };
  if (!check.present) return { ok: false, detail: 'nonce missing from the answer' };
  return { ok: false, detail: `the nonce is on line ${String(check.line)} but the first non-empty line is not the NONCE line` };
}

/**
 * Takes the answer from its NONCE line on (plan 4.1 `collect`). Only a verbatim first NONCE line counts, so the text
 * is returned whole (with `fromNonce` false) when the nonce sits anywhere else; nothing before it is dropped.
 */
export function fromNonceLine(text: string | null, nonce: string, source: string): LegText {
  if (text === null || text.trim() === '') return { text: null, fromNonce: false, source };
  if (!nonceOnFirstLine(text, nonce).ok) return { text, fromNonce: false, source };
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() !== '');
  return { text: lines.slice(at).join('\n'), fromNonce: true, source };
}

/** Builds the ratification status from the checks and a failure class. */
export function verdictOf(checks: readonly RatificationCheck[], failureClass: FailureClass | null): {
  ok: boolean;
  status: RatificationStatus;
} {
  const ok = checks.length > 0 && checks.every((c) => c.ok);
  if (ok) return { ok, status: 'PASS' };
  return { ok, status: failureClass === 'contaminated' ? 'CONTAMINATED' : 'FAIL' };
}
