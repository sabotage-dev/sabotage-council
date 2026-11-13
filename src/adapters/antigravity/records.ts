import { existsSync, readFileSync } from 'node:fs';
import { sqlite } from '../../store/sqlite.js';
import { pbAt, pbFields, utf8 } from './proto.js';

/*
 * The antigravity leg's own records (plan 4.2), both inside the leg's own gemini dir:
 *   - the CLI log the leg writes with `--log-file` (glog lines): version, app data dir, conversation id. It also
 *     holds account details and the prompt text, so only the facts below are read, it is never copied into a
 *     ratification, and the failure classifier never reads it;
 *   - the conversation DB `<gemini dir>/antigravity-cli/conversations/<session id>.db`, table `gen_metadata`, one
 *     row per model call: the model label of every call (the per-call proof of the pin), the slug, and the
 *     offered tools.
 */

export interface AgyLogFacts {
  exists: boolean;
  /** `Language server version: X`. */
  versions: string[];
  /** `ACP app data directory: <dir>`. */
  appDataDirs: string[];
  /** `Created conversation <id>`. */
  conversations: string[];
  /** Every model label the log names as selected, in order (default override, propagated override). */
  modelLabels: string[];
  /** `workspaceDirs=[...]` values that name a directory. */
  workspaceDirs: string[];
}

const VERSION = /Language server version: (\S+)/;
const APP_DIR = /ACP app data directory: (\S+)/;
const CONVERSATION = /Created conversation ([0-9a-f-]{36})/;
const MODEL_LABELS = [/Setting default model override: (.+?)\s*$/, /model override[^:]*: label="([^"]+)"/, /Propagating selected model override.*?label="([^"]+)"/];
const WORKSPACE = /workspaceDirs=\[([^\]]*)\]/;

export function readAgyLog(path: string): AgyLogFacts {
  const facts: AgyLogFacts = { exists: existsSync(path), versions: [], appDataDirs: [], conversations: [], modelLabels: [], workspaceDirs: [] };
  if (!facts.exists) return facts;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const v = VERSION.exec(line);
    if (v?.[1]) facts.versions.push(v[1]);
    const a = APP_DIR.exec(line);
    if (a?.[1]) facts.appDataDirs.push(a[1]);
    const c = CONVERSATION.exec(line);
    if (c?.[1]) facts.conversations.push(c[1]);
    for (const re of MODEL_LABELS) {
      const m = re.exec(line);
      if (m?.[1]) {
        facts.modelLabels.push(m[1]);
        break;
      }
    }
    const w = WORKSPACE.exec(line);
    if (w?.[1]) for (const d of w[1].split(/[ ,]+/).filter((s) => s !== '')) facts.workspaceDirs.push(d);
  }
  return facts;
}

/** Where each fact sits in a `gen_metadata.data` row (1.5.7): the model label, the model slug, the offered tools. */
export const AGY_GEN_FIELDS = {
  label: [1, 21],
  slug: [3, 28],
  tools: [3, 46, 3],
} as const;

export interface AgyGenFacts {
  dbPath: string;
  exists: boolean;
  /** Rows in `gen_metadata` (one per model call). */
  rows: number;
  /** The label of each row (null when the row has none). */
  labels: Array<string | null>;
  slugs: string[];
  /** Offered tool names, from the rows that carry the tool list. */
  toolsOffered: string[];
  problem: string | null;
}

/** Reads the model call rows of the leg's conversation DB (read-only). */
export function readAgyGenerations(dbPath: string): AgyGenFacts {
  const facts: AgyGenFacts = { dbPath, exists: existsSync(dbPath), rows: 0, labels: [], slugs: [], toolsOffered: [], problem: null };
  if (!facts.exists) return facts;
  let db: InstanceType<ReturnType<typeof sqlite>['DatabaseSync']> | null = null;
  try {
    db = new (sqlite().DatabaseSync)(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{ data: Uint8Array }>;
    const tools = new Set<string>();
    for (const row of rows) {
      const data = new Uint8Array(row.data);
      facts.rows++;
      const labels = pbAt(data, AGY_GEN_FIELDS.label).map(utf8);
      facts.labels.push(labels.length === 1 ? (labels[0] as string) : null);
      for (const s of pbAt(data, AGY_GEN_FIELDS.slug).map(utf8)) facts.slugs.push(s);
      for (const entry of pbAt(data, AGY_GEN_FIELDS.tools)) {
        const name = pbFields(entry)
          .filter((f) => f.wire === 2 && f.bytes !== null)
          .map((f) => utf8(f.bytes as Uint8Array))
          .find((s) => /^[a-z][a-z0-9_]{1,63}$/.test(s));
        if (name !== undefined) tools.add(name);
      }
    }
    facts.toolsOffered = [...tools];
  } catch (error) {
    facts.problem = error instanceof Error ? error.message.split('\n')[0] ?? 'error' : String(error);
  } finally {
    db?.close();
  }
  return facts;
}
