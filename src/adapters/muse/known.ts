import type { ModelInfo } from '../../config/registry.js';
import type { EnforcementLabel } from '../types.js';

/*
 * What the muse adapter declares per tested CLI version (plan 4.2, 5.2). Facts from Muse Code 1.4.15
 * (`1.4.15-R8339.1`), its `exec --help`, and the recorded offline runs (`--provider echo`, which makes no model
 * call), 2026-11-12. Nothing here comes from a logged-in model run (owner ruling: none in P4), so the label is
 * `weak` and stays below `strong` in v1:
 *   - every researched read-only flag exists on `exec`; `--permission-profile` cannot be combined with
 *     `--sandbox-network` or `--approval-judge` (exit 2), so the adapter passes neither;
 *   - an untrusted workspace still runs headless, so `--trust-workspace` (project rules, skills and hooks, hooks
 *     running outside the sandbox) is never passed;
 *   - `--session-id <fresh uuid>` creates the session; the `--json` stdout is the session-log envelope stream; the
 *     session log lands under `$XDG_DATA_HOME/muse/sessions/YYYY/MM/DD/<id>/session.jsonl`; `muse export
 *     --session <id>` works offline;
 *   - the answer is `run.terminal.completed.payload.text`; usage is `run.usage` on the `exec.usage` stream, with a
 *     model id per entry (null on the echo provider).
 */

export interface MuseVersionDecl {
  enforcement: EnforcementLabel;
}

export const MUSE_DECLARED: Readonly<Record<string, MuseVersionDecl>> = {
  '1.4.15': { enforcement: 'weak' },
};

export const MUSE_TESTED_VERSIONS = Object.keys(MUSE_DECLARED);
export const MUSE_FLOOR = '1.4.15';

export function museDecl(version: string | null): MuseVersionDecl | null {
  if (version === null) return null;
  return MUSE_DECLARED[version] ?? null;
}

/** `--reasoning-effort` values the Meta provider takes (`none` is refused by it). */
export const MUSE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/**
 * Model ids a seat names. Contributor variants are refused: a council seat always runs with contributor mode off
 * (Meta may otherwise train on the reviewed code), and those variants exist for contributor mode.
 */
export const MUSE_MODELS: readonly ModelInfo[] = [
  { id: 'muse-spark-1.3', family: 'meta' },
  { id: 'muse-spark-1.2', family: 'meta' },
  { id: 'muse-spark-1.1', family: 'meta' },
  { id: 'muse-wonder-1.0', family: 'meta' },
  { id: 'muse-ember-1.0', family: 'meta' },
];

/** The flags every leg passes (a read-only profile, tools removed, no foreign personal context, contributor off). */
export const MUSE_SAFETY_FLAGS = [
  '--permission-profile',
  ':read-only',
  '--disable-write',
  '--disable-shell',
  '--disable-web-tools',
  '--disable-request-user-input',
  '--disable-reminders',
  '--no-foreign-personal-context',
  '--contributor-mode',
  'off',
] as const;

/** Flags a leg never passes: trust loads project rules and hooks; the rest lift approval or the sandbox. */
export const MUSE_FORBIDDEN_FLAGS = ['--trust-workspace', '--yolo', '--disable-sandbox', '--disable-approval', '--no-session-log', '--allow-workspace-switch'] as const;

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n));
  const pb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
