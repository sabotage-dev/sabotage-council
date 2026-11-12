import { readFileSync } from 'node:fs';

export interface PackageInfo {
  name: string;
  version: string;
  /** The `engines.node` range from package.json, e.g. `>=22.13`. */
  nodeRange: string;
}

let cached: PackageInfo | undefined;

/**
 * Reads the package's own package.json. The relative path is the same from `src/` (tests) and from `dist/`
 * (the installed binary), because both sit one level below the package root.
 */
export function packageInfo(): PackageInfo {
  if (cached) return cached;
  const raw: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const pkg = raw as { name?: unknown; version?: unknown; engines?: { node?: unknown } };
  if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string' || typeof pkg.engines?.node !== 'string') {
    throw new Error('package.json is missing name, version or engines.node');
  }
  cached = { name: pkg.name, version: pkg.version, nodeRange: pkg.engines.node };
  return cached;
}
