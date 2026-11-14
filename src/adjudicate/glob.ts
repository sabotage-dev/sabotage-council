/*
 * What a Glob `pattern` or a Grep `glob` can search (plan 6.4, P7 round 1 row 1). The hook and the ratifier judge
 * a pattern by the directories it can be reduced to, never by the text before its first wildcard: `{/etc/passwd,**}`
 * has no text before its first meta character, and `.[.]/[.]/etc/passwd` holds no `..`, yet both can name a path
 * outside the working copy.
 *
 * A pattern reduces when every alternative is one literal directory prefix (whole segments, before the first segment
 * with `*`, `?` or `[`) followed by a tail that cannot leave that directory:
 *
 *   - no `~` at the start, no `..` anywhere, no backslash escape, and no `(`, `)` or `|` (extglob and groups);
 *   - braces are closed, not nested, and hold no `/`, so each alternative stays in the same segment; they are
 *     expanded (at most 256 alternatives) and every alternative is judged;
 *   - a character class holds only letters, digits, `_` and ranges between two letters or digits (so it never matches
 *     `.` or `/`), and is not negated;
 *   - no segment of the tail that starts with a literal `.` can match `..` (`.?`, `.*`: the shell rule, under which
 *     only a segment starting with `.` matches `..`).
 *
 * Anything else is a problem: the hook denies the call and the ratifier fails the run. The function is self-contained
 * (no imports, no closures, no inner functions) because the hook script embeds its source text.
 */

/** The directories a pattern searches, relative to the tool's base (or absolute), or why it cannot be judged. */
export interface GlobReduction {
  dirs: string[];
  problem: string | null;
}

export function globReduce(pattern: string): GlobReduction {
  if (pattern.startsWith('~')) return { dirs: [], problem: 'names the home directory' };
  if (/[\\()|]/.test(pattern)) return { dirs: [], problem: 'holds an escape, a group or an extglob (\\ ( ) |), which the hook cannot judge' };
  if (pattern.includes('..')) return { dirs: [], problem: 'climbs (..)' };
  let alts: string[] = [pattern];
  for (let round = 0; round <= 64; round++) {
    const next: string[] = [];
    let expanded = false;
    for (const p of alts) {
      const open = p.indexOf('{');
      const close = p.indexOf('}');
      if (open < 0 && close < 0) {
        next.push(p);
        continue;
      }
      if (open < 0 || close < open) return { dirs: [], problem: 'has an unbalanced brace' };
      const inner = p.slice(open + 1, close);
      if (inner.includes('{')) return { dirs: [], problem: 'nests braces' };
      if (inner.includes('/')) return { dirs: [], problem: 'has a brace alternative holding "/", which could name another directory' };
      for (const alt of inner.split(',')) next.push(p.slice(0, open) + alt + p.slice(close + 1));
      expanded = true;
    }
    if (next.length > 256) return { dirs: [], problem: 'expands to more than 256 alternatives' };
    alts = next;
    if (!expanded) break;
  }
  const dirs: string[] = [];
  for (const alt of alts) {
    if (alt.includes('{') || alt.includes('}')) return { dirs: [], problem: 'has more brace groups than the hook expands' };
    if (alt.startsWith('~')) return { dirs: [], problem: 'names the home directory' };
    if (alt.includes('..')) return { dirs: [], problem: 'climbs (..)' };
    const segs = alt.split('/');
    let literal = 0;
    while (literal < segs.length && !/[*?[]/.test(segs[literal] ?? '')) literal++;
    for (let i = literal; i < segs.length; i++) {
      const seg = segs[i] ?? '';
      let re = '^';
      for (let k = 0; k < seg.length; k++) {
        const ch = seg[k] ?? '';
        if (ch === '*') re += '.*';
        else if (ch === '?') re += '.';
        else if (ch === '[') {
          const end = seg.indexOf(']', k + 1);
          if (end < 0) return { dirs: [], problem: 'has an unclosed character class' };
          const body = seg.slice(k + 1, end);
          if (!/^[A-Za-z0-9_-]+$/.test(body)) return { dirs: [], problem: 'has a character class [' + body + '] the hook cannot judge (letters, digits, "_" and ranges between them only)' };
          for (let j = 1; j < body.length - 1; j++) {
            if (body[j] === '-' && !(/[A-Za-z0-9]/.test(body[j - 1] ?? '') && /[A-Za-z0-9]/.test(body[j + 1] ?? ''))) {
              return { dirs: [], problem: 'has a character class [' + body + '] with a range that is not between two letters or digits' };
            }
          }
          re += '[' + body + ']';
          k = end;
        } else re += ch.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      }
      re += '$';
      let climbs = true;
      try {
        climbs = new RegExp(re).test('..');
      } catch {
        return { dirs: [], problem: 'has a segment the hook cannot judge (' + seg + ')' };
      }
      if (seg.startsWith('.') && climbs) return { dirs: [], problem: 'has a segment that could match ".." (' + seg + ')' };
    }
    let dir = segs.slice(0, literal).join('/');
    if (dir === '' && alt.startsWith('/')) dir = '/';
    if (!dirs.includes(dir)) dirs.push(dir);
  }
  return { dirs, problem: null };
}
