/*
 * Reading an occupant given as `backend:model[:effort]` for a launch (`seats test`, plan 8.4). A model id may hold a
 * `:` itself (`ollama/llama3:8b`), so the text after the backend reads two ways: the whole rest as the model (the CLI's
 * default effort), or the rest up to its last `:` as the model with the last segment as the effort. The adapter's model
 * list decides: the whole rest when it is listed; the split when only it is listed; a refusal naming both readings when
 * both are listed, and one naming what is not offered when neither is.
 */

export interface OccupantReading {
  backend: string;
  model: string;
  effort: string | undefined;
}

/** The backend and the rest of `backend:...`; null when there is no backend or no rest. */
export function splitBackend(spec: string): { backend: string; rest: string } | null {
  const at = spec.indexOf(':');
  if (at <= 0 || at === spec.length - 1) return null;
  return { backend: spec.slice(0, at), rest: spec.slice(at + 1) };
}

/** The two readings of the rest: the whole as the model, and (when it has a non-empty model and effort) the split. */
export function readingsOf(backend: string, rest: string): { whole: OccupantReading; split: OccupantReading | null } {
  const last = rest.lastIndexOf(':');
  const split = last > 0 && last < rest.length - 1 ? { backend, model: rest.slice(0, last), effort: rest.slice(last + 1) } : null;
  return { whole: { backend, model: rest, effort: undefined }, split };
}

export type ResolvedSpec = { ok: true; occupant: OccupantReading } | { ok: false; message: string };

/** Resolves `backend:model[:effort]` against the model ids the backend's adapter lists. */
export function resolveOccupantSpec(spec: string, offered: readonly string[]): ResolvedSpec {
  const parts = splitBackend(spec);
  if (parts === null) return { ok: false, message: `"${spec}" is not backend:model[:effort]` };
  const { whole, split } = readingsOf(parts.backend, parts.rest);
  const wholeListed = offered.includes(whole.model);
  const splitListed = split !== null && offered.includes(split.model);
  if (wholeListed && splitListed && split !== null) {
    return {
      ok: false,
      message: `"${spec}" reads two ways and backend "${parts.backend}" lists both: model "${whole.model}" at the CLI's default effort, or model "${split.model}" at effort "${split.effort ?? ''}"; refusing to guess`,
    };
  }
  if (wholeListed) return { ok: true, occupant: whole };
  if (splitListed && split !== null) return { ok: true, occupant: split };
  if (split === null) return { ok: false, message: `backend "${parts.backend}" does not offer model "${whole.model}"` };
  return { ok: false, message: `backend "${parts.backend}" offers neither model "${whole.model}" nor model "${split.model}" (with effort "${split.effort ?? ''}")` };
}
