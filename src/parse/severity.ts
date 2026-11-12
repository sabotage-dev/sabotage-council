/** The four canonical severity labels (plan 3.3). */
export const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW', 'NIT'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * What seats actually emit, mapped to the canonical labels (plan 3.3). Exported as data so the adjudication spec
 * and the docs can quote the same table.
 */
export const SEVERITY_ALIASES: Readonly<Record<string, Severity>> = {
  CRITICAL: 'HIGH',
  BLOCKER: 'HIGH',
  MED: 'MEDIUM',
  MAJOR: 'MEDIUM',
  MINOR: 'LOW',
  INFO: 'NIT',
  STYLE: 'NIT',
};

/**
 * `unlabelled`: the seat gave no severity. `unrecognized`: it gave a label that is neither canonical nor an alias.
 * Both normalize to LOW and are flagged in the record (plan 3.3), so the adjudicator sets the final severity.
 */
export type SeverityFlag = 'unlabelled' | 'unrecognized';

export interface NormalizedSeverity {
  severity: Severity;
  /** The label as the seat wrote it, trimmed; null when there was none. */
  raw: string | null;
  flag: SeverityFlag | null;
}

const WRAPPERS = /^[\s*_`[\](){}"'#:]+|[\s*_`[\](){}"'#:.]+$/g;

export function normalizeSeverity(input: string | null | undefined): NormalizedSeverity {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return { severity: 'LOW', raw: null, flag: 'unlabelled' };
  const word = raw.replace(WRAPPERS, '').toUpperCase();
  if (word === '') return { severity: 'LOW', raw, flag: 'unlabelled' };
  if ((SEVERITIES as readonly string[]).includes(word)) return { severity: word as Severity, raw, flag: null };
  const alias = SEVERITY_ALIASES[word];
  if (alias !== undefined) return { severity: alias, raw, flag: null };
  return { severity: 'LOW', raw, flag: 'unrecognized' };
}
