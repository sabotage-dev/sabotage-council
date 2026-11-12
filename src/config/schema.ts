import { z } from 'zod';
import {
  BACKENDS,
  CI_GATES,
  INTERACTIVE_ADJUDICATION,
  SEAT_COUNT,
  UNTRUSTED_SEAT_POLICIES,
  FALLBACK_TRIGGERS,
  GROK_SANDBOX_MODES,
} from './vocab.js';

/*
 * The schema for ~/.config/sabotage-council/config.toml, exactly the TOML in plan section 5.2.
 * Every table is strict: an unknown key is an error, so a typo never silently falls back to a default.
 * Cross-field rules (unique ids, fallback differs, the fixed quorum) live in rules.ts.
 */

const positiveInt = z.int().min(1);

const backend = z.enum(BACKENDS, {
  error: `unknown backend; expected one of: ${BACKENDS.join(', ')}`,
});

const modelId = z.string().trim().min(1, { error: 'model id must not be empty' });
const effort = z.string().trim().min(1, { error: 'effort must not be empty' });

/** Seat ids name the voting positions (`a`, `b`, `c` in the docs). They appear in CLI flags and directory names. */
const seatId = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,15}$/, { error: 'seat id must be 1-16 characters: a-z, 0-9, "_" or "-", starting with a letter' });

/** `owner/name`, with `*` allowed as a wildcard (repo lists). */
const repoPattern = z
  .string()
  .regex(/^[A-Za-z0-9_.*-]+\/[A-Za-z0-9_.*-]+$/, { error: 'expected "owner/repo", with optional * wildcards' });

/** An exact `owner/name` (the per-repo tests table is opt-in per repository, D12). */
const repoName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { error: 'expected an exact "owner/repo" (no wildcards)' });

const githubLogin = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/, { error: 'not a valid GitHub login' });

export const fallbackSchema = z.strictObject({
  backend,
  model: modelId,
  effort: effort.optional(),
  on: z
    .array(z.enum(FALLBACK_TRIGGERS, { error: 'fallback.on takes only usage_limit or auth (plan 3.1, 4.4)' }))
    .min(1, { error: 'fallback.on needs at least one failure class' }),
});

export const seatSchema = z.strictObject({
  id: seatId,
  backend,
  model: modelId,
  effort: effort.optional(),
  sandbox: z.enum(GROK_SANDBOX_MODES).optional(),
  fallback: fallbackSchema.optional(),
});

export const councilSchema = z.strictObject({
  leg_timeout_minutes: positiveInt.default(25),
  untrusted_seat_policy: z.enum(UNTRUSTED_SEAT_POLICIES).default('fallback'),
  high_only_from_round: positiveInt.default(4),
});

export const adjudicatorSchema = z.strictObject({
  model: modelId.optional(),
  max_turns: positiveInt.default(40),
  timeout_minutes: positiveInt.default(15),
});

export const githubSchema = z.strictObject({
  login: githubLogin,
  council_logins: z.array(githubLogin).default([]),
  markers_also_count: z.array(z.string().min(1)).default([]),
});

export const repoTestsSchema = z.strictObject({
  setup: z.string().min(1).optional(),
  command: z.string().min(1),
  timeout_minutes: positiveInt.default(15),
});

export const autoSchema = z.strictObject({
  interval_minutes: positiveInt.default(5),
  repos_allow: z.array(repoPattern).default([]),
  repos_skip: z.array(repoPattern).default([]),
  repos_hold: z.array(repoPattern).default([]),
  include_assigned: z.boolean().default(false),
  approve: z.boolean().default(true),
  ci_gate: z.enum(CI_GATES).default('required-checks'),
  max_rounds_per_day: positiveInt.default(30),
  identity_approval: z.boolean().default(true),
  tests: z.record(repoName, repoTestsSchema).default({}),
});

export const prSchema = z.strictObject({
  interactive_adjudication: z.enum(INTERACTIVE_ADJUDICATION).default('trusted-only'),
});

export const followupsSchema = z.strictObject({
  hook: z.string().min(1).optional(),
});

export const notifySchema = z.strictObject({
  command: z.string().min(1).optional(),
});

export const configSchema = z.strictObject({
  council: councilSchema.prefault({}),
  seats: z.array(seatSchema).length(SEAT_COUNT, {
    error: (issue) => {
      const found = Array.isArray(issue.input) ? `; found ${issue.input.length}` : '';
      return `exactly ${SEAT_COUNT} seats are required (D10)${found}`;
    },
  }),
  /** Auto mode only; interactive modes adjudicate in the host session. */
  adjudicator: adjudicatorSchema.prefault({}),
  /** Needed by `pr` and `auto` only. */
  github: githubSchema.optional(),
  /** Needed by `auto` only. */
  auto: autoSchema.optional(),
  pr: prSchema.prefault({}),
  followups: followupsSchema.prefault({}),
  notify: notifySchema.prefault({}),
});

export type CouncilConfig = z.output<typeof configSchema>;
export type SeatConfig = z.output<typeof seatSchema>;
export type FallbackConfig = z.output<typeof fallbackSchema>;
