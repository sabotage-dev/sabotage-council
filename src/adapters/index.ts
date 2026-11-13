import type { BackendId } from '../config/vocab.js';
import { createAntigravityAdapter } from './antigravity/index.js';
import { createClaudeAdapter } from './claude/index.js';
import { createCodexAdapter } from './codex/index.js';
import { createKiroAdapter } from './kiro/index.js';
import type { SeatAdapter } from './types.js';

export * from './types.js';
export { createClaudeAdapter } from './claude/index.js';
export { createCodexAdapter } from './codex/index.js';
export { createAntigravityAdapter } from './antigravity/index.js';
export { createKiroAdapter } from './kiro/index.js';

/** Looks up a seat adapter by backend. P2 ships codex and claude, P3 antigravity and kiro; P4 adds the rest. */
export type SeatAdapters = (backend: BackendId) => SeatAdapter | undefined;

export function builtinAdapters(): SeatAdapters {
  const adapters: Partial<Record<BackendId, SeatAdapter>> = {
    codex: createCodexAdapter(),
    claude: createClaudeAdapter(),
    antigravity: createAntigravityAdapter(),
    kiro: createKiroAdapter(),
  };
  return (backend) => adapters[backend];
}
