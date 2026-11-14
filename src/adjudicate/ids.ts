import { findingIdOf } from './schema.js';

/*
 * Stable finding ids for the headless adjudicator (plan 7.3). A finding id is the first 12 hex of sha256 over the
 * target, the path and the normalized title. The interactive adjudicator can compute that with a shell; the headless
 * one has no tool that runs code, so it writes placeholder ids (`f_000000000001`, ...) and the engine replaces each
 * with the stable id of its own path and title before validating. References to this document's findings
 * (`earlier_items[].fix_row`, `human_asks[].fix_row`, `followups[]`) follow the same map. `same_as` (an earlier
 * round's finding) and `closes_item` (an earlier item) are never remapped.
 *
 * Anything ambiguous is left for the validator to reject: a placeholder used by two findings is not remapped (the
 * validator reports the duplicate), and two findings that hash to one stable id are both rewritten to it (the
 * validator reports that duplicate too). A document that is not JSON, or not shaped as expected, is returned as is.
 */

export interface IdAssignment {
  text: string;
  /** placeholder (or earlier id) -> stable id, for every finding whose id changed. */
  changed: Record<string, string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function assignStableIds(text: string, targetKey: string): IdAssignment {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { text, changed: {} };
  }
  if (!isRecord(doc) || !Array.isArray(doc['findings'])) return { text, changed: {} };
  const findings = doc['findings'].filter(isRecord);
  const uses = new Map<string, number>();
  for (const f of findings) if (typeof f['id'] === 'string') uses.set(f['id'], (uses.get(f['id']) ?? 0) + 1);
  const map = new Map<string, string>();
  for (const f of findings) {
    const id = f['id'];
    const title = f['title'];
    const path = f['path'];
    if (typeof id !== 'string' || typeof title !== 'string' || (path !== null && typeof path !== 'string')) continue;
    if ((uses.get(id) ?? 0) > 1) continue;
    const stable = findingIdOf(targetKey, path, title);
    f['id'] = stable;
    if (stable !== id) map.set(id, stable);
  }
  const remap = (v: unknown): unknown => (typeof v === 'string' && map.has(v) ? map.get(v) : v);
  for (const key of ['earlier_items', 'human_asks'] as const) {
    const rows = doc[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) if (isRecord(row) && 'fix_row' in row) row['fix_row'] = remap(row['fix_row']);
  }
  if (Array.isArray(doc['followups'])) doc['followups'] = doc['followups'].map(remap);
  return { text: `${JSON.stringify(doc, null, 2)}\n`, changed: Object.fromEntries(map) };
}
