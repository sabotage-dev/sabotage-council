import { parseFindings, type FindingsResult } from './findings.js';
import { checkNonce, parseVerdict, type NonceCheck, type VerdictResult } from './verdict.js';

export { MAX_FIELD_LENGTH, parseFindings, type FindingsFormat, type FindingsResult, type LegFinding } from './findings.js';
export { parseLocation, type Location } from './location.js';
export {
  normalizeSeverity,
  SEVERITIES,
  SEVERITY_ALIASES,
  type NormalizedSeverity,
  type Severity,
  type SeverityFlag,
} from './severity.js';
export {
  checkNonce,
  NONCE_PATTERN,
  parseVerdict,
  VERDICTS,
  type NonceCheck,
  type SkippedLine,
  type SkipReason,
  type Verdict,
  type VerdictMatch,
  type VerdictReason,
  type VerdictResult,
} from './verdict.js';
export { parseYamlList, YamlListError, type YamlRecord, type YamlScalar } from './yaml-list.js';

export interface LegReply {
  /**
   * What ratification gates on for the nonce (plan 3.9, 4.5): the first non-empty line is the verbatim NONCE line.
   * A nonce found anywhere else, even elsewhere on the first line, leaves this false.
   */
  nonceOk: boolean;
  /** The nonce check's detail, for the record. */
  nonce: NonceCheck;
  verdict: VerdictResult;
  findings: FindingsResult;
}

/** Everything P1 parses from one leg's reply text. Ratification (4.5) decides what counts, on `nonceOk`. */
export function parseLegReply(text: string, nonce: string): LegReply {
  const check = checkNonce(text, nonce);
  return { nonceOk: check.verbatim, nonce: check, verdict: parseVerdict(text), findings: parseFindings(text) };
}
