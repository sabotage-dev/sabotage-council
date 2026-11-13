/*
 * The council hook (plan 4.2): one Node script the leg's `hooks.json` runs for every event. It appends the event's
 * JSON input to the leg's hook log (the model proof: `model_id`, `model_params`, `workspace_roots`), and answers
 * the gate events: `preToolUse` allows only read tools, `beforeReadFile` allows only paths whose realpath is
 * inside the root, and shell and MCP execution are always denied. A deny is `{"permission":"deny"}` on stdout and
 * exit code 2, so either reading of the hook contract stops the tool before it runs.
 */

export const CURSOR_GATE_EVENTS = ['preToolUse', 'beforeReadFile', 'beforeShellExecution', 'beforeMCPExecution'] as const;
export const CURSOR_LOG_EVENTS = ['postToolUse', 'afterFileEdit', 'stop', 'sessionEnd', 'beforeSubmitPrompt'] as const;

export function councilHookScript(readTools: readonly string[]): string {
  return `#!/usr/bin/env node
// sabotage-council hook: log every event, deny all but in-root reads. Generated per leg; do not edit.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
const [event, root, log] = process.argv.slice(2);
let input = '';
try { input = readFileSync(0, 'utf8'); } catch {}
let payload;
try { payload = JSON.parse(input); } catch { payload = { unparsed: input.slice(0, 2000) }; }
const READS = new Set(${JSON.stringify(readTools)});
const roots = new Set([root]);
try { roots.add(realpathSync(root)); } catch {}
const real = (p) => { try { return realpathSync(p); } catch { try { return join(realpathSync(dirname(p)), p.split('/').pop()); } catch { return p; } } };
const inside = (p) => {
  if (typeof p !== 'string' || p === '' || p.startsWith('~')) return false;
  const abs = real(isAbsolute(p) ? p : resolve(root, p));
  return [...roots].some((r) => abs === r || abs.startsWith(r + '/'));
};
let decision = null;
if (event === 'preToolUse') {
  const name = String(payload.tool_name ?? payload.toolName ?? '').toLowerCase();
  decision = READS.has(name) ? 'allow' : 'deny';
} else if (event === 'beforeReadFile') {
  decision = inside(payload.file_path ?? payload.filePath ?? payload.path) ? 'allow' : 'deny';
} else if (event === 'beforeShellExecution' || event === 'beforeMCPExecution') {
  decision = 'deny';
}
appendFileSync(log, JSON.stringify({ event, at: Date.now(), decision, payload }) + '\\n');
if (decision !== null) process.stdout.write(JSON.stringify({ permission: decision }));
process.exit(decision === 'deny' ? 2 : 0);
`;
}
