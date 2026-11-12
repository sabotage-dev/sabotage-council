import { scanFences, type Fence } from './fences.js';
import { parseLocation } from './location.js';
import { normalizeSeverity, type Severity, type SeverityFlag } from './severity.js';
import { oneOf, stripRuns } from './trim.js';
import { splitLines } from './verdict.js';
import { parseYamlList, YamlListError, type YamlRecord } from './yaml-list.js';

/** One finding as a leg wrote it in its findings block (plan 3.9). Field names follow the run store. */
export interface LegFinding {
  /** The leg's own id: F1, F2, ... */
  id: string;
  severity: Severity;
  severity_raw: string | null;
  severity_flag: SeverityFlag | null;
  path: string | null;
  line: number | null;
  end_line: number | null;
  title: string;
}

export type FindingsFormat = 'lines' | 'json' | 'yaml' | 'empty';

export type FindingsResult =
  | { findings: LegFinding[]; extracted_by: 'leg'; format: FindingsFormat }
  | { findings: []; extracted_by: 'adjudicator-needed'; reason: string };

class BlockError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const ID_WRAP = oneOf('*_`');

/**
 * The longest field a finding may carry (id, severity, location, title). A longer one is not a seat's finding but
 * garbage or hostile input, so the block goes to the adjudicator before any pattern runs on it (council round 1).
 */
export const MAX_FIELD_LENGTH = 2000;

function bounded(value: string, field: string, which: string): string {
  if (value.length > MAX_FIELD_LENGTH) {
    throw new BlockError(`${which}: the ${field} field is ${value.length} characters, over the ${MAX_FIELD_LENGTH} limit`);
  }
  return value;
}
const EMPTY_BLOCK = /^(?:none|\(none\)|n\/a|-|no findings\.?|\[\])$/i;

/** Every fenced block in the reply, with its info string (the scan the verdict parser uses too). */
function fences(text: string): Fence[] {
  return scanFences(splitLines(text)).fences;
}

/**
 * Parses the leg's fenced `findings` block (plan 3.9). Three shapes are accepted, all seen from real seats:
 * the line grammar `F1 | HIGH | path:line | title`, a JSON array of objects, and a YAML list of the same objects
 * (id, severity, path or file, line, title). A missing or broken block never throws: it returns
 * `{findings: [], extracted_by: 'adjudicator-needed'}` with the reason, so the adjudicator extracts the findings.
 * Several `findings` blocks are accepted only when they all parse to the same findings: a block the leg quoted
 * (from the PR, a test, an earlier review) must never stand in for its own, so blocks that differ go to the
 * adjudicator, never "take the last".
 */
export function parseFindings(text: string): FindingsResult {
  const blocks = fences(text).filter((f) => (f.info.split(/\s+/)[0] ?? '').toLowerCase() === 'findings');
  if (blocks.length === 0) return needed('no fenced findings block');
  if (blocks.some((b) => !b.closed)) return needed('the findings block is not closed');
  const results = blocks.map((b) => parseOne(b.body.join('\n')));
  const first = results[0] as FindingsResult;
  const same = (r: FindingsResult): boolean =>
    r.extracted_by === first.extracted_by && JSON.stringify(r.findings) === JSON.stringify(first.findings);
  if (!results.every(same)) {
    return needed(`${blocks.length} findings blocks with different contents; the adjudicator decides which is the leg's own`);
  }
  return first;
}

function parseOne(body: string): FindingsResult {
  try {
    return parseBlock(body);
  } catch (err) {
    if (err instanceof BlockError || err instanceof YamlListError) return needed(err.message);
    throw err;
  }
}

function needed(reason: string): FindingsResult {
  return { findings: [], extracted_by: 'adjudicator-needed', reason };
}

function parseBlock(body: string): FindingsResult {
  const trimmed = body.trim();
  if (trimmed === '' || EMPTY_BLOCK.test(trimmed)) return { findings: [], extracted_by: 'leg', format: 'empty' };
  let format: FindingsFormat;
  let findings: LegFinding[];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    format = 'json';
    findings = fromRecords(jsonRecords(trimmed));
  } else if (/^-\s*[A-Za-z_][A-Za-z0-9_-]*\s*:(?:\s|$)/.test(trimmed)) {
    format = 'yaml';
    findings = fromRecords(parseYamlList(trimmed));
  } else {
    format = 'lines';
    findings = fromLines(trimmed);
  }
  const seen = new Set<string>();
  for (const f of findings) {
    if (seen.has(f.id)) throw new BlockError(`duplicate finding id "${f.id}"`);
    seen.add(f.id);
  }
  return { findings, extracted_by: 'leg', format };
}

function jsonRecords(text: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new BlockError(`invalid JSON: ${(err as Error).message}`);
  }
  if (Array.isArray(value)) return value;
  if (typeof value === 'object' && value !== null && Array.isArray((value as { findings?: unknown }).findings)) {
    return (value as { findings: unknown[] }).findings;
  }
  throw new BlockError('the JSON is neither an array nor an object with a "findings" array');
}

function text(value: unknown, field: string, index: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return bounded(value, field, `finding ${index + 1}`);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new BlockError(`finding ${index + 1}: "${field}" must be a string or a number`);
}

function fromRecords(records: readonly unknown[]): LegFinding[] {
  return records.map((record, index) => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new BlockError(`finding ${index + 1} is not an object`);
    }
    const r = record as YamlRecord | Record<string, unknown>;
    const id = text(r['id'], 'id', index)?.trim() ?? '';
    if (!ID.test(id)) throw new BlockError(`finding ${index + 1}: missing or malformed id`);
    const title = text(r['title'], 'title', index)?.trim() ?? '';
    if (title === '') throw new BlockError(`finding ${id}: missing title`);
    const pathText = text(r['path'] ?? r['file'], 'path', index);
    const location = parseLocation(pathText);
    const lineText = text(r['line'], 'line', index);
    if (lineText !== null && location.path !== null) {
      const explicit = parseLocation(`${location.path}:${lineText.trim()}`);
      location.line = explicit.line;
      location.end_line = explicit.end_line;
    }
    const sev = normalizeSeverity(text(r['severity'], 'severity', index));
    return {
      id,
      severity: sev.severity,
      severity_raw: sev.raw,
      severity_flag: sev.flag,
      path: location.path,
      line: location.line,
      end_line: location.end_line,
      title,
    };
  });
}

function fromLines(body: string): LegFinding[] {
  const out: LegFinding[] = [];
  for (const raw of body.split('\n')) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^[\s|:-]+$/.test(line)) continue; // a markdown table separator row
    line = line.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
    line = line.replace(/^\|/, '').replace(/\|$/, '');
    const parts = line.split('|').map((p) => p.trim());
    const first = (parts[0] ?? '').toLowerCase();
    if (first === 'id' || first === '#') continue; // a header row
    if (parts.length < 4) throw new BlockError(`expected "ID | SEVERITY | path:line | title", got "${raw.trim().slice(0, 200)}"`);
    ['id', 'severity', 'location'].forEach((field, i) => bounded(parts[i] ?? '', field, `line "${(parts[0] ?? '').slice(0, 40)}"`));
    bounded(parts.slice(3).join(' | '), 'title', `line "${(parts[0] ?? '').slice(0, 40)}"`);
    const id = stripRuns(parts[0] ?? '', ID_WRAP, ID_WRAP);
    if (!ID.test(id)) throw new BlockError(`malformed finding id "${parts[0] ?? ''}"`);
    const title = parts.slice(3).join(' | ').trim();
    if (title === '') throw new BlockError(`finding ${id}: missing title`);
    const sev = normalizeSeverity(parts[1]);
    const location = parseLocation(parts[2]);
    out.push({
      id,
      severity: sev.severity,
      severity_raw: sev.raw,
      severity_flag: sev.flag,
      path: location.path,
      line: location.line,
      end_line: location.end_line,
      title,
    });
  }
  return out;
}
