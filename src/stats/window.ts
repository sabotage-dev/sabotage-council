/*
 * The scorecard's window (plan 8.2): `--since <dur|date>`. The default window is all history.
 *
 *   30d, 12h, 2w, 90m      a duration back from now (m minutes, h hours, d days, w weeks)
 *   2026-11-01             a UTC date: from that day's midnight UTC
 *   2026-11-01T08:00:00Z   an ISO-8601 timestamp with a zone (Z or +hh:mm)
 *
 * The result is an ISO-8601 UTC timestamp. Rounds count when their `started_at` is at or after it.
 */

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowError';
  }
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

export function parseSince(value: string, nowMs: number = Date.now()): string {
  const text = value.trim();
  const dur = /^([1-9][0-9]{0,5})([mhdw])$/.exec(text);
  if (dur) return new Date(nowMs - Number(dur[1]) * (UNIT_MS[dur[2] ?? 'd'] ?? 0)).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const ms = Date.parse(`${text}T00:00:00.000Z`);
    if (Number.isFinite(ms) && new Date(ms).toISOString().startsWith(text)) return new Date(ms).toISOString();
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const ms = Date.parse(text);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  throw new WindowError(`--since takes a duration (30d, 12h, 2w, 90m), a date (2026-11-01) or an ISO timestamp with a zone; got "${value}"`);
}
