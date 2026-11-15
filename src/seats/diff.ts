/*
 * A small unified diff of two texts by lines (for `seats ... --dry-run`). Config files are small, so the longest
 * common subsequence is computed directly.
 */

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

type Op = { kind: ' ' | '-' | '+'; line: string; a: number; b: number };

function ops(a: readonly string[], b: readonly string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the LCS length of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i] as Uint32Array;
    const next = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: ' ', line: a[i] as string, a: i++, b: j++ });
    } else if (i < n && (j >= m || (lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0))) {
      // A deletion before an addition, as diff prints them.
      out.push({ kind: '-', line: a[i] as string, a: i++, b: j });
    } else {
      out.push({ kind: '+', line: b[j] as string, a: i, b: j++ });
    }
  }
  return out;
}

/** `--- a/<label>` / `+++ b/<label>` and hunks with `context` lines around each change. Empty when equal. */
export function unifiedDiff(before: string, after: string, label: string, context = 3): string {
  const a = splitLines(before);
  const b = splitLines(after);
  const all = ops(a, b);
  const changed = all.map((o, k) => (o.kind === ' ' ? -1 : k)).filter((k) => k >= 0);
  if (changed.length === 0) return '';
  const hunks: Array<[number, number]> = [];
  for (const k of changed) {
    const from = Math.max(0, k - context);
    const to = Math.min(all.length - 1, k + context);
    const last = hunks.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const out = [`--- a/${label}`, `+++ b/${label}`];
  for (const [from, to] of hunks) {
    const slice = all.slice(from, to + 1);
    const first = slice[0] as Op;
    const aCount = slice.filter((o) => o.kind !== '+').length;
    const bCount = slice.filter((o) => o.kind !== '-').length;
    const aStart = aCount === 0 ? first.a : first.a + 1;
    const bStart = bCount === 0 ? first.b : first.b + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (const o of slice) out.push(`${o.kind}${o.line}`);
  }
  return `${out.join('\n')}\n`;
}
