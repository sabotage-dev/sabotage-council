import type { ModelInfo } from '../../config/registry.js';
import type { EnforcementLabel } from '../types.js';

/*
 * What the antigravity adapter declares per tested `agy` version (plan 4.2, 5.2). Every fact here was measured
 * on the version it names; an untested version gets the fail-closed path (`pending`).
 */

export interface AgyVersionDecl {
  /** Plan 5.2: `pending` until the promotion canary passes on this version. */
  enforcement: EnforcementLabel;
}

/**
 * agy 1.5.7, measured 2026-11-12 over ACP (no model turn for these facts):
 *   - `agy acp` takes `--gemini-dir <absolute dir>`; with it, the app data directory, the user settings file
 *     (`<dir>/antigravity-cli/settings.json`), the shared config (`<dir>/config/config.json`) and the conversation
 *     records all move there, while the keyring sign-in still authenticates. Each leg gets its own gemini dir.
 *   - What that isolation is measured to cover (round 1, no model call, a planted `$HOME/.gemini` in a scratch
 *     HOME): when `<dir>/config/config.json` is absent agy creates its own `config.json` and `mcp_config.json` in
 *     `<dir>/config` and does not fall back to `$HOME/.gemini`. An MCP server planted in
 *     `$HOME/.gemini/config/mcp_config.json` did not start, while the same file started its server when it was the
 *     gemini dir (the positive control). The CLI settings come from `<dir>/antigravity-cli/settings.json` only
 *     ("using defaults" when it is absent). Not measured: whether the global `GEMINI.md`, skills, plugins and hooks
 *     under `$HOME/.gemini` stay out (only a model turn would show instructions loading). agy keeps the real HOME:
 *     with HOME changed, its keyring sign-in did not load ("Authentication required" at `session/new`).
 *   - `session/new` reports config options `model`, `thought_level` and `mode` (`default`, `accept-edits`, `auto`,
 *     `plan`), plus the older `models` and `modes` fields. `session/set_config_option` sets each one.
 */
export const AGY_DECLARED: Readonly<Record<string, AgyVersionDecl>> = {
  '1.5.7': { enforcement: 'pending' },
};

export const AGY_TESTED_VERSIONS = Object.keys(AGY_DECLARED);
/** Below this, preflight refuses: the ACP config options (model, thought level, mode) were first measured on 1.5.6. */
export const AGY_FLOOR = '1.5.6';

export function agyDecl(version: string | null): AgyVersionDecl | null {
  if (version === null) return null;
  return AGY_DECLARED[version] ?? null;
}

/**
 * The mode every leg runs in (plan 4.1, N7): `default` asks before edits and commands. `plan` only adds a planning
 * step, and `accept-edits` and `auto` approve without asking, so the adapter never uses them. It is set with
 * `session/set_config_option` (config id `mode`), the route the agent advertises in `configOptions`.
 */
export const AGY_MODE = 'default';

/** ACP config ids on 1.5.7. */
export const AGY_CONFIG = { model: 'model', effort: 'thought_level', mode: 'mode' } as const;

/** Thinking levels the `thought_level` option offers on 1.5.7. */
export const AGY_EFFORTS = ['low', 'medium', 'high'] as const;

/**
 * Model ids a seat names: the values of the ACP `model` option. Gemini models are named without the effort
 * suffix the `agy models` slug carries (`gemini-3.8-flash`, effort `low` = slug `gemini-3.8-flash-low`). The
 * account's own list (preflight) is the binding check; this table only gives families for config validation.
 */
export const AGY_MODELS: readonly ModelInfo[] = [
  { id: 'gemini-3.8-flash', family: 'google' },
  { id: 'gemini-4-argon', family: 'google' },
  { id: 'gemini-4-carbon', family: 'google' },
  { id: 'claude-sonnet-4-6', family: 'anthropic' },
  { id: 'claude-opus-4-6-thinking', family: 'anthropic' },
  { id: 'claude-sonnet-5-5', family: 'anthropic' },
  { id: 'claude-opus-5-5', family: 'anthropic' },
  { id: 'gpt-oss-120b-medium', family: 'openai' },
];

/** `agy models` prints `slug<TAB>label` lines. */
export function parseAgyModels(text: string): Array<{ slug: string; label: string }> {
  return text
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((parts) => parts.length >= 2 && /^[a-z0-9][a-z0-9.-]*$/.test(parts[0] ?? ''))
    .map((parts) => ({ slug: (parts[0] as string).trim(), label: parts.slice(1).join('\t').trim() }));
}

/** The `agy models` slug for a seat's model and effort (`gemini-3.8-flash` + `low` = `gemini-3.8-flash-low`). */
export function agySlug(model: string, effort: string | undefined, slugs: readonly string[]): string | null {
  if (effort !== undefined && slugs.includes(`${model}-${effort}`)) return `${model}-${effort}`;
  if (slugs.includes(model)) return model;
  return null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n));
  const pb = b.split('.').map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}
