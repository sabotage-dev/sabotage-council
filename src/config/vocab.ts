/** The eight seat backends (plan 1.1, 4.2). */
export const BACKENDS = [
  'codex',
  'claude',
  'grok',
  'antigravity',
  'kiro',
  'opencode',
  'cursor',
  'muse',
] as const;
export type BackendId = (typeof BACKENDS)[number];

/** The shared failure classes every adapter maps its signatures to (plan 4.4). */
export const FAILURE_CLASSES = [
  'usage_limit',
  'auth',
  'capacity',
  'transport',
  'model',
  'timeout',
  'empty',
  'contaminated',
  'setup',
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** The only failure classes that move a seat to its fallback (plan 3.1 step 6, 4.4); the rest relaunch or end the leg. */
export const FALLBACK_TRIGGERS = ['usage_limit', 'auth'] as const satisfies readonly FailureClass[];

/** `sandbox` on a grok seat (plan 4.2): read-only where it starts, off where it refuses (the allowlist enforces). */
export const GROK_SANDBOX_MODES = ['read-only', 'off'] as const;

/** `council.untrusted_seat_policy` (plan 5.2). */
export const UNTRUSTED_SEAT_POLICIES = ['fallback', 'skip', 'allow'] as const;

/** `auto.ci_gate` (plan 5.2). */
export const CI_GATES = ['required-checks', 'all', 'off'] as const;

/** `pr.interactive_adjudication` (plan 5.2, 6.3). */
export const INTERACTIVE_ADJUDICATION = ['trusted-only', 'untrusted-too'] as const;

/** Fixed by D10. Not configurable. */
export const SEAT_COUNT = 3;
/** Fixed by D10. Not configurable. */
export const QUORUM = 2;

/**
 * The adjudicator is always Claude Code (D8), interactively or headless, so its model family is fixed.
 * Family names are the strings adapters report in `ModelInfo.family`.
 */
export const ADJUDICATOR_FAMILY = 'anthropic';
