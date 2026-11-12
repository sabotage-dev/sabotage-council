import { readFile } from 'node:fs/promises';
import { parse, TomlError } from 'smol-toml';
import type { ConfigIssue } from './rules.js';
import { validateConfig, type ValidateOptions, type ValidationResult } from './validate.js';

export type LoadResult = ValidationResult & { path: string };

/**
 * Loads the user config (default `~/.config/sabotage-council/config.toml`; see paths.ts for the overrides).
 * The engine never reads seat, posting or test configuration from a reviewed repository (plan 5.2).
 */
export async function loadConfig(path: string, options: ValidateOptions = {}): Promise<LoadResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === 'ENOENT' ? `no config file at ${path}` : `cannot read ${path}: ${errorMessage(error)}`;
    return { path, ok: false, errors: [{ path: '', message }], warnings: [] };
  }
  return { path, ...(await parseConfigText(text, options)) };
}

/** Parses and validates TOML text. */
export async function parseConfigText(text: string, options: ValidateOptions = {}): Promise<ValidationResult> {
  let raw: unknown;
  try {
    raw = parse(text, { unsafeKeyBehaviour: 'throw' });
  } catch (error) {
    const issue: ConfigIssue =
      error instanceof TomlError
        ? { path: '', message: `TOML syntax error at line ${error.line}, column ${error.column}: ${firstLine(error.message)}` }
        : { path: '', message: `TOML syntax error: ${errorMessage(error)}` };
    return { ok: false, errors: [issue], warnings: [] };
  }
  return validateConfig(raw, options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(message: string): string {
  return message.split('\n', 1)[0] ?? message;
}
