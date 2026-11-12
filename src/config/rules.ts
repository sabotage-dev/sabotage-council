import { statSync } from 'node:fs';
import type { AdapterRegistry, ModelInfo } from './registry.js';
import type { CouncilConfig, SeatConfig } from './schema.js';
import { ADJUDICATOR_FAMILY, QUORUM, type BackendId } from './vocab.js';

/** One config problem. `path` is the TOML key path (e.g. `seats[1].fallback`); empty for document-level issues. */
export interface ConfigIssue {
  path: string;
  message: string;
}

const QUORUM_MESSAGE = `quorum is fixed at ${QUORUM} and is not configurable (D10)`;

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Quorum and seat count are fixed (D10). A `quorum` key, at the top level or in `[council]`, is rejected with
 * that reason. The key is removed from the returned copy, so the strict schema does not report it a second time
 * as an unknown key.
 */
export function rejectQuorumKey(raw: unknown): { issues: ConfigIssue[]; rest: unknown } {
  if (!isTable(raw)) return { issues: [], rest: raw };
  const issues: ConfigIssue[] = [];
  const rest: Record<string, unknown> = { ...raw };
  if ('quorum' in rest) {
    issues.push({ path: 'quorum', message: QUORUM_MESSAGE });
    delete rest['quorum'];
  }
  const council = rest['council'];
  if (isTable(council) && 'quorum' in council) {
    issues.push({ path: 'council.quorum', message: QUORUM_MESSAGE });
    const councilRest: Record<string, unknown> = { ...council };
    delete councilRest['quorum'];
    rest['council'] = councilRest;
  }
  return { issues, rest };
}

/** Seat ids must be unique. */
export function checkUniqueSeatIds(seats: readonly SeatConfig[]): ConfigIssue[] {
  const firstIndex = new Map<string, number>();
  const issues: ConfigIssue[] = [];
  seats.forEach((seat, i) => {
    const previous = firstIndex.get(seat.id);
    if (previous === undefined) {
      firstIndex.set(seat.id, i);
    } else {
      issues.push({ path: `seats[${i}].id`, message: `duplicate seat id "${seat.id}" (also seats[${previous}].id)` });
    }
  });
  return issues;
}

interface OccupantKey {
  backend: BackendId;
  model: string;
  effort?: string | undefined;
}

/**
 * Two configs name the same occupant when backend and model match and their efforts can be the same. Transport is
 * a property of the backend's adapter (plan 4.1), so it follows from the backend. An unset effort means the
 * adapter's default, which may equal the other side's effort, so it matches any effort: a fallback that differs
 * only by leaving effort unset could run the very occupant that just failed.
 */
export function sameOccupant(a: OccupantKey, b: OccupantKey): boolean {
  if (a.backend !== b.backend || a.model !== b.model) return false;
  return a.effort === undefined || b.effort === undefined || a.effort === b.effort;
}

/**
 * Three seats need three distinct occupants (owner ruling 2026-11-12): two seats that would run the same backend,
 * model and effort are one voice counted twice. D10 still allows the same backend with different models.
 */
export function checkDistinctOccupants(seats: readonly SeatConfig[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  seats.forEach((seat, j) => {
    const i = seats.findIndex((other, k) => k < j && sameOccupant(other, seat));
    if (i >= 0) {
      issues.push({
        path: `seats[${j}]`,
        message: `seat "${seat.id}" is the same occupant as seat "${seats[i]!.id}" (${describe(seat)}); the three seats must differ in backend, model or effort`,
      });
    }
  });
  return issues;
}

/** `sandbox` is a grok setting (plan 4.2); on any other backend it is an error, not a silent no-op. */
export function checkSandboxOnlyForGrok(seats: readonly SeatConfig[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  seats.forEach((seat, i) => {
    if (seat.sandbox !== undefined && seat.backend !== 'grok') {
      issues.push({ path: `seats[${i}].sandbox`, message: `sandbox applies only to grok seats (seat "${seat.id}" is ${seat.backend})` });
    }
  });
  return issues;
}

/**
 * `auth_home` is a kiro setting (a separate Kiro login): on any other backend it is an error, and the directory
 * must exist (a typo would otherwise run on the user's own login or fail later at preflight).
 */
export function checkAuthHome(seats: readonly SeatConfig[], exists: (path: string) => boolean = isDirectory): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  seats.forEach((seat, i) => {
    const occupants: Array<{ path: string; backend: string; authHome: string | undefined }> = [{ path: `seats[${i}].auth_home`, backend: seat.backend, authHome: seat.auth_home }];
    if (seat.fallback) occupants.push({ path: `seats[${i}].fallback.auth_home`, backend: seat.fallback.backend, authHome: seat.fallback.auth_home });
    for (const o of occupants) {
      if (o.authHome === undefined) continue;
      if (o.backend !== 'kiro') issues.push({ path: o.path, message: `auth_home applies only to kiro (this occupant is ${o.backend})` });
      else if (!exists(o.authHome)) issues.push({ path: o.path, message: `auth_home ${o.authHome} is not an existing directory` });
    }
  });
  return issues;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A fallback must be a different occupant from its seat's primary. */
export function checkFallbacksDiffer(seats: readonly SeatConfig[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  seats.forEach((seat, i) => {
    if (seat.fallback && sameOccupant(seat, seat.fallback)) {
      issues.push({
        path: `seats[${i}].fallback`,
        message: `the fallback is the same occupant as seat "${seat.id}" (${describe(seat)}); a fallback must differ in backend, model or effort`,
      });
    }
  });
  return issues;
}

function describe(o: OccupantKey): string {
  return [o.backend, o.model, o.effort].filter((part) => part !== undefined).join(' / ');
}

interface ModelCheck {
  backend: BackendId;
  model: string;
  backendPath: string;
  modelPath: string;
}

export interface ModelCheckResult {
  errors: ConfigIssue[];
  /** The family of each seat's primary model, aligned with `config.seats`; undefined when the check failed. */
  primaryFamilies: (string | undefined)[];
  /** The family of each seat's fallback model, aligned with `config.seats`; undefined when absent or unchecked. */
  fallbackFamilies: (string | undefined)[];
}

/**
 * Validates every model id (seat primaries, fallbacks, and the adjudicator model on the claude backend) against
 * the adapter's own `listModels()`. Each backend's list is read once.
 */
export async function checkModels(config: CouncilConfig, registry: AdapterRegistry): Promise<ModelCheckResult> {
  const checks: ModelCheck[] = [];
  config.seats.forEach((seat, i) => {
    checks.push({ backend: seat.backend, model: seat.model, backendPath: `seats[${i}].backend`, modelPath: `seats[${i}].model` });
    if (seat.fallback) {
      checks.push({
        backend: seat.fallback.backend,
        model: seat.fallback.model,
        backendPath: `seats[${i}].fallback.backend`,
        modelPath: `seats[${i}].fallback.model`,
      });
    }
  });
  if (config.adjudicator.model !== undefined) {
    checks.push({ backend: 'claude', model: config.adjudicator.model, backendPath: 'adjudicator', modelPath: 'adjudicator.model' });
  }

  const lists = new Map<BackendId, Promise<readonly ModelInfo[]>>();
  const errors: ConfigIssue[] = [];
  const found = new Map<string, ModelInfo>();

  for (const check of checks) {
    const lister = registry.lister(check.backend);
    if (!lister) {
      errors.push({ path: check.backendPath, message: `no adapter is registered for backend "${check.backend}"` });
      continue;
    }
    let list = lists.get(check.backend);
    if (!list) {
      // A lister that throws synchronously is reported the same way as one that rejects.
      list = Promise.resolve().then(() => lister.listModels());
      lists.set(check.backend, list);
    }
    let models: readonly ModelInfo[];
    try {
      models = await list;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push({ path: check.modelPath, message: `could not list the models of backend "${check.backend}": ${reason}` });
      continue;
    }
    const model = models.find((m) => m.id === check.model);
    if (!model) {
      errors.push({ path: check.modelPath, message: `backend "${check.backend}" does not offer model "${check.model}"` });
      continue;
    }
    found.set(check.modelPath, model);
  }

  const primaryFamilies = config.seats.map((_, i) => found.get(`seats[${i}].model`)?.family);
  const fallbackFamilies = config.seats.map((_, i) => found.get(`seats[${i}].fallback.model`)?.family);
  return { errors, primaryFamilies, fallbackFamilies };
}

/**
 * Family warnings (plan 5.2), returned as warnings, never errors:
 * - two seats whose primary models share a family;
 * - a seat whose primary model shares the adjudicator's family (the adjudicator is Claude Code, D8);
 * - fallbacks count too (owner ruling 2026-11-12): a fallback that shares a family with another seat's primary, or
 *   with the adjudicator, makes the council less independent in every round where that fallback is seated.
 */
export function familyWarnings(
  seats: readonly SeatConfig[],
  primaryFamilies: readonly (string | undefined)[],
  fallbackFamilies: readonly (string | undefined)[] = [],
): ConfigIssue[] {
  const warnings: ConfigIssue[] = [];

  const byFamily = new Map<string, string[]>();
  seats.forEach((seat, i) => {
    const family = primaryFamilies[i];
    if (family === undefined) return;
    byFamily.set(family, [...(byFamily.get(family) ?? []), seat.id]);
  });
  for (const [family, ids] of byFamily) {
    if (ids.length >= 2) {
      warnings.push({
        path: 'seats',
        message: `seats ${ids.map((id) => `"${id}"`).join(' and ')} share the ${family} model family; seats from one family tend to find the same things, so the council is less independent`,
      });
    }
  }

  seats.forEach((seat, i) => {
    if (primaryFamilies[i] === ADJUDICATOR_FAMILY) {
      warnings.push({
        path: `seats[${i}].model`,
        message: `seat "${seat.id}" shares the adjudicator's model family (${ADJUDICATOR_FAMILY}); the adjudicator is Claude Code (D8), and a same-family seat is correlated with the adjudicator's own reading (and often with Claude-written code); the scorecard's agreement matrix shows whether it still adds an independent view`,
      });
    }
  });

  seats.forEach((seat, i) => {
    const family = fallbackFamilies[i];
    if (family === undefined) return;
    const others = seats.filter((_, j) => j !== i && primaryFamilies[j] === family).map((other) => `"${other.id}"`);
    if (others.length > 0) {
      warnings.push({
        path: `seats[${i}].fallback.model`,
        message: `seat "${seat.id}"'s fallback shares the ${family} model family with seat ${others.join(' and ')}; in a round where it is seated, two seats come from one family`,
      });
    }
    if (family === ADJUDICATOR_FAMILY) {
      warnings.push({
        path: `seats[${i}].fallback.model`,
        message: `seat "${seat.id}"'s fallback shares the adjudicator's model family (${ADJUDICATOR_FAMILY}); in a round where it is seated, that seat is correlated with the adjudicator's own reading`,
      });
    }
  });

  return warnings;
}
