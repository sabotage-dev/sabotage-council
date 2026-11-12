import { parseFindings, type FindingsResult } from './findings.js';
import { checkNonce, parseVerdict, type NonceCheck, type VerdictResult } from './verdict.js';

export { parseFindings, type FindingsFormat, type FindingsResult, type LegFinding } from './findings.js';
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
  type Verdict,
  type VerdictMatch,
  type VerdictResult,
} from './verdict.js';
export { parseYamlList, YamlListError, type YamlRecord, type YamlScalar } from './yaml-list.js';

export interface LegReply {
  nonce: NonceCheck;
  verdict: VerdictResult;
  findings: FindingsResult;
}

/** Everything P1 parses from one leg's reply text. Ratification (4.5) decides what counts. */
export function parseLegReply(text: string, nonce: string): LegReply {
  return { nonce: checkNonce(text, nonce), verdict: parseVerdict(text), findings: parseFindings(text) };
}
