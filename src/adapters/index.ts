import type { BackendId } from '../config/vocab.js';
import { createClaudeAdapter } from './claude/index.js';
import { createCodexAdapter } from './codex/index.js';
import type { SeatAdapter } from './types.js';

export * from './types.js';
export { createClaudeAdapter } from './claude/index.js';
export { createCodexAdapter } from './codex/index.js';

/** Looks up a seat adapter by backend. P2 ships codex and claude; P3 and P4 add the rest. */
export type SeatAdapters = (backend: BackendId) => SeatAdapter | undefined;

export function builtinAdapters(): SeatAdapters {
  const codex = createCodexAdapter();
  const claude = createClaudeAdapter();
  return (backend) => (backend === 'codex' ? codex : backend === 'claude' ? claude : undefined);
}
