import type { FailureClass } from '../../config/vocab.js';

/*
 * Codex failure signatures (plan 4.4), from the CLI-codex research and the recorded probes. They are applied to
 * stderr and to error events only (`turn.failed`, top-level `error`, `item.completed` error items), never to the
 * answer text. First match wins, in table order.
 */

export const CODEX_FAILURE_PATTERNS: ReadonlyArray<{ class: FailureClass; pattern: RegExp }> = [
  // The observed text uses a curly apostrophe (U+2019): "You’ve hit your usage limit".
  {
    class: 'usage_limit',
    pattern:
      /You[’']ve hit your usage limit|You hit your spend cap|Quota exceeded\.|out of credits|upgrade to Plus|send a request to your admin|\b402\b/i,
  },
  {
    class: 'auth',
    pattern:
      /refresh token (?:has expired|was already used|was revoked)|could not be refreshed|Please log out and sign in again|unexpected status 401|\b401 Unauthorized\b|Not logged in|not signed in/i,
  },
  { class: 'model', pattern: /^model rerouted:|model rerouted: |\bmodel\b.*\b(?:not found|does not exist|not supported)\b|unexpected status 400/im },
  {
    class: 'capacity',
    pattern: /Selected model is at capacity|experiencing high demand|rate limit exceeded|\b429\b|Too Many Requests|overloaded/i,
  },
  { class: 'transport', pattern: /Reconnecting\.\.\. 5\/5|stream disconnected|error sending request|connection (?:reset|refused|closed)/i },
  {
    class: 'setup',
    pattern:
      /Not inside a trusted directory|No prompt provided|Failed to read prompt|Output schema file|Reading additional input from stdin|unexpected argument|invalid transport|error loading config|failed to load config/i,
  },
];

/** Classifies error text. Returns null when no signature matches. */
export function classifyCodexText(texts: readonly string[]): FailureClass | null {
  for (const { class: cls, pattern } of CODEX_FAILURE_PATTERNS) {
    if (texts.some((t) => pattern.test(t))) return cls;
  }
  return null;
}
