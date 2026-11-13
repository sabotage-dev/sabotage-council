import type { z } from 'zod';
import type { AdapterRegistry } from './registry.js';
import {
  checkDistinctOccupants,
  checkFallbacksAcrossSeats,
  checkFallbacksDiffer,
  checkAuthHome,
  checkGrokLogins,
  checkKiroLogins,
  checkSandboxOnlyForGrok,
  checkModels,
  checkUniqueSeatIds,
  familyWarnings,
  rejectQuorumKey,
  type ConfigIssue,
} from './rules.js';
import { configSchema, type CouncilConfig } from './schema.js';

export interface ValidateOptions {
  /**
   * Validates model ids through each backend adapter's `listModels()` and computes family warnings. When it is
   * absent (P0 ships no adapters), model ids and families are not checked and `modelsChecked` is false.
   */
  registry?: AdapterRegistry | undefined;
}

export type ValidationResult =
  | { ok: true; config: CouncilConfig; warnings: ConfigIssue[]; modelsChecked: boolean }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

/** Validates a parsed TOML document. Errors carry key paths; family warnings never make it fail. */
export async function validateConfig(raw: unknown, options: ValidateOptions = {}): Promise<ValidationResult> {
  const quorum = rejectQuorumKey(raw);
  const errors: ConfigIssue[] = [...quorum.issues];

  const parsed = configSchema.safeParse(quorum.rest);
  if (!parsed.success) {
    errors.push(...schemaIssues(parsed.error));
    return { ok: false, errors, warnings: [] };
  }
  const config = parsed.data;

  errors.push(...checkUniqueSeatIds(config.seats));
  errors.push(...checkDistinctOccupants(config.seats));
  errors.push(...checkFallbacksDiffer(config.seats));
  errors.push(...checkFallbacksAcrossSeats(config.seats));
  errors.push(...checkSandboxOnlyForGrok(config.seats));
  errors.push(...checkAuthHome(config.seats));
  if (errors.length === 0) errors.push(...checkKiroLogins(config.seats), ...checkGrokLogins(config.seats));

  const warnings: ConfigIssue[] = [];
  let modelsChecked = false;
  if (options.registry) {
    const models = await checkModels(config, options.registry);
    errors.push(...models.errors);
    warnings.push(...familyWarnings(config.seats, models.primaryFamilies, models.fallbackFamilies));
    modelsChecked = true;
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, config, warnings, modelsChecked };
}

function schemaIssues(error: z.ZodError): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) issues.push({ path: formatPath([...issue.path, key]), message: 'unknown key' });
    } else if (issue.code === 'invalid_key') {
      issues.push({ path: formatPath(issue.path), message: issue.issues[0]?.message ?? issue.message });
    } else {
      issues.push({ path: formatPath(issue.path), message: issue.message });
    }
  }
  return issues;
}

/** `seats[1].fallback.model`, `auto.tests."org/api".command`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else {
      const key = String(part);
      const segment = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
      out += out === '' ? segment : `.${segment}`;
    }
  }
  return out;
}
