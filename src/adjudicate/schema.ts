import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SEVERITIES } from '../parse/severity.js';
import { VERDICTS } from '../parse/verdict.js';

/*
 * `ADJUDICATION.json` (plan 7.3), checked by schema here and by the cross-checks in validate.ts. Every object is
 * strict: an unknown key is an error, so a misspelt field never silently drops a judgment.
 */

export const OUTCOMES = ['owed', 'follow-up', 'nit', 'refuted', 'ruling', 'noted'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const ITEM_STATUSES = ['closed', 'half-closed', 'open'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const LEG_VERDICTS = [...VERDICTS, 'none'] as const;

const text = z.string().trim().min(1);
const seat = z.string().regex(/^[a-z][a-z0-9_-]{0,15}$/, { error: 'not a seat id' });
const legFinding = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/, { error: 'not a leg finding id' });
export const FINDING_ID = /^f_[0-9a-f]{12}$/;
const findingId = z.string().regex(FINDING_ID, { error: 'a finding id is f_ and 12 lowercase hex' });

export const raisedBySchema = z.strictObject({
  seat,
  leg_finding: legFinding,
  severity: z.enum(SEVERITIES),
});

export const findingSchema = z.strictObject({
  id: findingId,
  title: text,
  path: z.string().trim().min(1).nullable(),
  line: z.int().min(1).nullable(),
  severity: z.enum(SEVERITIES),
  outcome: z.enum(OUTCOMES),
  /** `this` for this change; another value names the repository owner a fix belongs to (plan 3.4 rule 8). */
  owner: text,
  proof: z.string(),
  kind: z.enum(['finding', 'human_ask']),
  raised_by: z.array(raisedBySchema),
  same_as: findingId.nullable(),
  closes_item: z.string().min(1).nullable(),
});

export const adjudicationSchema = z.strictObject({
  nonce: z.string().regex(/^[0-9a-f]{12}$/, { error: 'the nonce is 12 lowercase hex' }),
  head_sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, { error: 'head_sha is a full sha' }),
  round: z.int().min(1),
  verdict: z.enum(VERDICTS),
  approve: z.boolean(),
  needs_ruling: z.boolean(),
  reason: z.string(),
  findings: z.array(findingSchema),
  unmapped: z.array(z.strictObject({ seat, leg_finding: legFinding, reason: z.string() })),
  earlier_items: z.array(
    z.strictObject({ source: z.string().min(1), status: z.enum(ITEM_STATUSES), evidence: z.string(), fix_row: findingId.nullable() }),
  ),
  human_asks: z.array(
    z.strictObject({ id: z.string().regex(/^H[1-9][0-9]*$/, { error: 'a human ask id is H1, H2, ...' }), status: z.enum(ITEM_STATUSES), evidence: z.string(), fix_row: findingId.nullable() }),
  ),
  leg_verdicts: z.array(z.strictObject({ seat, raw: z.enum(LEG_VERDICTS), effective: z.enum(LEG_VERDICTS) })),
  not_verified: z.array(z.string()),
  followups: z.array(findingId),
  summary: text,
  blocker_call: text,
});

export type Adjudication = z.output<typeof adjudicationSchema>;
export type AdjudicatedFinding = z.output<typeof findingSchema>;
export type LegVerdict = (typeof LEG_VERDICTS)[number];

/**
 * The normalized title in a finding id (plan 7.3): Unicode NFKC, lower case, runs of whitespace as one space,
 * trimmed, trailing periods dropped.
 */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\.+$/, '');
}

/**
 * The stable finding id (plan 7.3): `f_` + the first 12 hex of sha256(target + path + normalized title), with the
 * three parts joined by newlines so no two splits of one string collide. The same issue raised again in a later
 * round, on the same path with the same title, keeps its id.
 */
export function findingIdOf(targetKey: string, path: string | null, title: string): string {
  return `f_${createHash('sha256').update(`${targetKey}\n${path ?? ''}\n${normalizeTitle(title)}`).digest('hex').slice(0, 12)}`;
}
