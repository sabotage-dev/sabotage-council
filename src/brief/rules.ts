/**
 * The round rules of plan 3.5. Which rule applies depends only on the round number and
 * `council.high_only_from_round` (D5); a 3.6 fallback to a full review keeps the round's own rule (D17).
 */
export type RoundRule = 'round-1' | 'serious' | 'high-only';

export function ruleFor(round: number, highOnlyFromRound: number): RoundRule {
  if (!Number.isSafeInteger(round) || round < 1) throw new RangeError(`round must be a positive integer, got ${round}`);
  if (!Number.isSafeInteger(highOnlyFromRound) || highOnlyFromRound < 1) {
    throw new RangeError(`high_only_from_round must be a positive integer, got ${highOnlyFromRound}`);
  }
  if (round >= highOnlyFromRound) return 'high-only';
  return round === 1 ? 'round-1' : 'serious';
}

/** What the rule text calls the thing under review. */
export interface RuleSubject {
  /** e.g. "the delta", "the change", "the plan". */
  noun: string;
}

/** The "This round's rule" section body, in plain words (plan 3.5). */
export function ruleText(rule: RoundRule, round: number, highOnlyFromRound: number, subject: RuleSubject): string[] {
  const s = subject.noun;
  const outOfScope = `A pre-existing issue in code ${s} neither touched nor broke is out of scope.`;
  switch (rule) {
    case 'round-1':
      return [
        `Round ${round}. Owed: any verified HIGH, MEDIUM or LOW defect ${s} introduces.`,
        `Nits never block. ${outOfScope}`,
      ];
    case 'serious':
      return [
        `Round ${round}. Owed, and nothing else:`,
        `(a) a defect ${s} introduced or left that ships wrong behaviour on real input, breaks the build or tests, or is a security or data-loss defect;`,
        '(b) an earlier owed row that was not closed;',
        "(c) an earlier reviewer's HIGH, MEDIUM or LOW item that was not closed;",
        "(d) every ask in your reviewer's open change request, if there is one.",
        `Nits never block. ${outOfScope}`,
      ];
    case 'high-only':
      return [
        `Round ${round}. From round ${highOnlyFromRound} only HIGH blocks. Owed, and nothing else:`,
        `(a) a new HIGH defect caused by ${s};`,
        '(b) an earlier HIGH item that was not closed;',
        "(c) every ask in your reviewer's open change request, if there is one.",
        'Do not report new MEDIUM, LOW or NIT findings. Earlier MEDIUM and LOW items still get a row; they become follow-ups.',
        outOfScope,
      ];
  }
}
