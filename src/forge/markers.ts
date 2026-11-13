import type { PrRef } from './pr.js';

/*
 * The first line of a council review (plan 3.6, 3.7, 3.10). Our round marker is
 *   sabotage-council round <N> on <owner>/<repo>#<num> at <sha7>
 * and an identity approval starts with
 *   sabotage-council identity approval on <owner>/<repo>#<num> at <sha7>
 * The engine writes them; it reads them back, with the user's `github.markers_also_count` patterns, to count rounds.
 */

export const ROUND_MARKER = /^sabotage-council round ([1-9][0-9]{0,5}) on ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9}) at ([0-9a-f]{7,40})$/;
export const IDENTITY_MARKER = /^sabotage-council identity approval on ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]{0,9}) at ([0-9a-f]{7,40})$/;

export function roundMarker(ref: PrRef, round: number, head: string): string {
  return `sabotage-council round ${round} on ${ref.owner}/${ref.repo}#${ref.number} at ${head.slice(0, 7)}`;
}

export function identityMarker(ref: PrRef, head: string): string {
  return `sabotage-council identity approval on ${ref.owner}/${ref.repo}#${ref.number} at ${head.slice(0, 7)}`;
}

/** The first non-empty line of a body, trimmed. */
export function firstLine(body: string): string {
  for (const line of body.split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if (t !== '') return t;
  }
  return '';
}

/**
 * Strips one heading or emphasis wrapper (plan 3.6 step 2): `# x` (to `######`, with optional closing hashes),
 * `**x**`, `__x__`, `*x*` or `_x_`. Only one: `**# x**` keeps its `#`.
 */
export function stripWrapper(line: string): string {
  const t = line.trim();
  const heading = /^#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(t);
  if (heading?.[1] !== undefined) return heading[1].trim();
  const emphasis = /^(\*\*|__|\*|_)(.+)\1$/.exec(t);
  if (emphasis?.[2] !== undefined) return emphasis[2].trim();
  return t;
}

export type Marker =
  | { kind: 'round'; round: number; target: string; sha: string }
  | { kind: 'identity'; target: string; sha: string }
  | { kind: 'also'; pattern: string; round: number | null; sha: string | null };

/**
 * The marker a review body starts with, or null. A `markers_also_count` pattern matches when the stripped first
 * line starts with it (case-insensitive); from such a line `round <N>` gives its number and `at <hex>` (7 to 40 hex)
 * its stated head, when present.
 */
export function parseMarker(body: string, alsoCount: readonly string[] = []): Marker | null {
  const line = stripWrapper(firstLine(body));
  let m = ROUND_MARKER.exec(line);
  if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined && m[4] !== undefined) {
    return { kind: 'round', round: Number(m[1]), target: `${m[2]}#${m[3]}`, sha: m[4] };
  }
  m = IDENTITY_MARKER.exec(line);
  if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) return { kind: 'identity', target: `${m[1]}#${m[2]}`, sha: m[3] };
  const lower = line.toLowerCase();
  for (const pattern of alsoCount) {
    if (pattern.trim() === '' || !lower.startsWith(pattern.trim().toLowerCase())) continue;
    const n = /\bround\s+([1-9][0-9]{0,5})\b/i.exec(line);
    const at = /\bat\s+([0-9a-f]{7,40})\b/i.exec(line);
    return { kind: 'also', pattern, round: n?.[1] === undefined ? null : Number(n[1]), sha: at?.[1]?.toLowerCase() ?? null };
  }
  return null;
}

/** Whether a marker's target names this pull request (owner and repo case-insensitively, as GitHub resolves them). */
export function namesPr(target: string, ref: PrRef): boolean {
  return target.toLowerCase() === `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();
}
