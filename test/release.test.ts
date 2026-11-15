import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The release metadata (P10): the package, the lockfile, the plugin and the skill's install pin agree on one version,
 * the package ships only what runs, and the release workflow publishes from a v* tag only, through OIDC, after every
 * check. docs/releasing.md has the owner's steps.
 */

const REPO = resolve(new URL('..', import.meta.url).pathname);
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

describe('release metadata', () => {
  const pkg = JSON.parse(read('package.json')) as Record<string, unknown> & { version: string };

  it('is a public package of one version across the package, the lockfile and the plugin', () => {
    expect(pkg['private']).toBeUndefined();
    expect(pkg['publishConfig']).toEqual({ access: 'public', provenance: true });
    expect(pkg['repository']).toEqual({ type: 'git', url: 'git+https://github.com/sabotage-dev/sabotage-council.git' });
    const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']!.version).toBe(pkg.version);
    expect((JSON.parse(read('plugin/.claude-plugin/plugin.json')) as { version: string }).version).toBe(pkg.version);
    expect(read('plugin/skills/sabotage-council/SKILL.md')).toContain(`npm install -g sabotage-council@${pkg.version}`);
    expect(read('plugin/README.md')).toContain(`npm install -g sabotage-council@${pkg.version}`);
    expect(read('CHANGELOG.md')).toMatch(new RegExp(`^## ${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
  });

  it('ships only what runs: the build, the migrations, the planted fixture, ADJUDICATE.md and the top-level docs', () => {
    expect(pkg['files']).toEqual(['dist', 'migrations', 'fixtures/planted', 'plugin/ADJUDICATE.md', 'README.md', 'LICENSE', 'CHANGELOG.md']);
    for (const f of pkg['files'] as string[]) if (f !== 'dist') expect(existsSync(join(REPO, f)), f).toBe(true);
  });

  it('publishes from a v* tag only, through OIDC, after the checks', () => {
    const wf = read('.github/workflows/release.yml');
    expect(wf).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n\n/m);
    expect(wf).toContain('id-token: write');
    expect(wf).not.toMatch(/pull_request|workflow_dispatch|branches:/);
    const steps = ['npm ci', 'npm run lint', 'npm run typecheck', 'npm test', 'npm run build', 'npm publish'].map((s) => wf.indexOf(`run: ${s}`));
    for (const i of steps) expect(i).toBeGreaterThan(0);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(wf.indexOf('TAG: ${{ github.ref_name }}')).toBeLessThan(steps[0]!);
    // The only secret is the one-time bootstrap token (docs/releasing.md).
    expect([...wf.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])).toEqual(['NPM_BOOTSTRAP_TOKEN']);
  });
});
