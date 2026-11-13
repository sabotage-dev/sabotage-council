/*
 * What posted text may not hold (plan 3.7 "Validation by code before posting", 6.5): the round's nonce, an
 * `@mention` of anyone outside the PR's participants, an auto-close phrase, a credential-shaped string. The renderer
 * neutralizes each in every string it takes from the adjudication (the text can quote leg answers, which quote the
 * reviewed tree); the validator then checks the whole body with the same patterns, as a second line.
 */

/** Credential shapes (plan 6.5): tokens and keys of the common services, private key blocks, and JWTs. */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** A GitHub mention: `@login` or `@org/team`, not inside a word or an email address. */
export const MENTION = /(^|[^A-Za-z0-9_`./@-])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?(?:\/[A-Za-z0-9_.-]+)?)/g;

const CLOSE_WORDS = '(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)';
/** A closing keyword before an issue reference: `fixes #12`, `closes o/r#12`, `resolves https://github.com/o/r/issues/12`. */
export const AUTO_CLOSE = new RegExp(
  `\\b${CLOSE_WORDS}\\b\\s*:?\\s+(?:(?:[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+)?#\\d+|https?:\\/\\/github\\.com\\/[^\\s/]+\\/[^\\s/]+\\/(?:issues|pull)\\/\\d+)`,
  'gi',
);

export const FULLWIDTH_AT = '＠';
export const FULLWIDTH_HASH = '＃';
export const REDACTED = '[redacted credential]';
export const NONCE_REDACTED = '[nonce]';

export interface TextRules {
  /** The round's nonce; never posted. */
  nonce: string | null;
  /** Lower-case logins that may be mentioned: the PR's participants. */
  participants: ReadonlySet<string>;
}

/** Neutralizes one string for a posted body. Mentions of participants stay; everything else is defused. */
export function neutralize(text: string, rules: TextRules): string {
  let out = text;
  if (rules.nonce !== null && rules.nonce !== '') out = out.split(rules.nonce).join(NONCE_REDACTED);
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, REDACTED);
  out = out.replace(AUTO_CLOSE, (m) => m.replace(/#(?=\d)/g, FULLWIDTH_HASH).replace(/https?:\/\/(?=github\.com)/i, ''));
  out = out.replace(MENTION, (m, pre: string, who: string) => (rules.participants.has(who.toLowerCase()) ? m : `${pre}${FULLWIDTH_AT}${who}`));
  return out;
}

/** Every rule a finished body breaks; empty when it may be posted. */
export function textProblems(body: string, rules: TextRules): string[] {
  const problems: string[] = [];
  if (rules.nonce !== null && rules.nonce !== '' && body.includes(rules.nonce)) problems.push("the body holds the round's nonce");
  for (const m of body.matchAll(MENTION)) {
    const who = m[2] ?? '';
    if (!rules.participants.has(who.toLowerCase())) problems.push(`the body mentions @${who}, who is not a participant of the PR`);
  }
  for (const m of body.matchAll(AUTO_CLOSE)) problems.push(`the body holds an auto-close phrase: "${m[0]}"`);
  for (const re of CREDENTIAL_PATTERNS) {
    if (new RegExp(re.source, re.flags).test(body)) problems.push(`the body holds a credential-shaped string (${re.source.slice(0, 24)}...)`);
  }
  return problems;
}
