import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runDoctor } from '../src/cli/doctor.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { commitAll, git, initRepo, writeTree } from './helpers/git-fixture.js';

/*
 * The release metadata (P10): the package, the lockfile, the plugin and the skill's install pin agree on one version,
 * the package ships only what runs, and the release workflow publishes from a v* tag on main only, through OIDC,
 * after every check, the very tarball it installed and ran, and a prerelease never as latest. The steps that decide
 * (main ancestry, the dist-tag and the token) are run here as GitHub runs them; docs/releasing.md has the owner's
 * steps.
 */

cleanScratchAfterAll();

const REPO = resolve(new URL('..', import.meta.url).pathname);
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');
const WORKFLOW = read('.github/workflows/release.yml');

const MAIN_CHECK = 'Check the tagged commit is on main';
const PACK = 'Pack the package, install the tarball in an empty HOME, and run it';
const PUBLISH = 'Publish the tarball that ran, with provenance';

/** A step's `run: |` script, by the step's name (the workflow is plain block YAML, so no parser is needed). */
function stepScript(name: string): string {
  const lines = WORKFLOW.split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (at < 0) throw new Error(`no step named "${name}"`);
  const stepIndent = lines[at]!.indexOf('-');
  let i = at + 1;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== '' && l.search(/\S/) <= stepIndent) throw new Error(`step "${name}" has no run block`);
    if (/^\s+run: \|$/.test(l)) break;
  }
  const runIndent = lines[i]!.search(/\S/);
  const body: string[] = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() !== '' && l.search(/\S/) <= runIndent) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  return `${body.map((l) => l.slice(indent)).join('\n')}\n`;
}

/** Runs a step's script the way GitHub runs a `run:` step on ubuntu: `bash --noprofile --norc -eo pipefail`. */
function runStep(name: string, cwd: string, env: Record<string, string>): { code: number; out: string } {
  const file = join(scratch('sc-release-step-'), 'step.sh');
  writeFileSync(file, stepScript(name));
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], { cwd, env, encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

/** Where a step (by name) or a `run: <command>` step starts in the workflow. */
const at = (marker: string): number => {
  const i = WORKFLOW.indexOf(marker.startsWith('run: ') ? marker : `- name: ${marker}\n`);
  expect(i, marker).toBeGreaterThan(0);
  return i;
};

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
});

describe('the release workflow', () => {
  it('publishes from a v* tag only, in the release environment, through OIDC, after the checks', () => {
    expect(WORKFLOW).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- 'v\*'\n\n/m);
    expect(WORKFLOW).toContain('id-token: write');
    expect(WORKFLOW).toMatch(/^ {4}environment: release$/m);
    expect(WORKFLOW).not.toMatch(/pull_request|workflow_dispatch|branches:/);
    const order = [MAIN_CHECK, 'run: npm ci', 'run: npm run lint', 'run: npm run typecheck', 'run: npm test', 'run: npm run build', PACK, PUBLISH].map(at);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(WORKFLOW.indexOf('TAG: ${{ github.ref_name }}')).toBeLessThan(at('run: npm ci'));
    // The only secret is the one-time bootstrap token (docs/releasing.md), and only the publish step sees it.
    expect([...WORKFLOW.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])).toEqual(['NPM_BOOTSTRAP_TOKEN']);
    expect(WORKFLOW.indexOf('secrets.NPM_BOOTSTRAP_TOKEN')).toBeGreaterThan(at(PUBLISH));
  });

  it('releases only a commit on main: a tag elsewhere is refused before anything runs', () => {
    expect(WORKFLOW).toMatch(/persist-credentials: false\n(?: +#.*\n)* +fetch-depth: 0\n/);
    const repo = initRepo(join(scratch('sc-release-git-'), 'repo'));
    writeTree(repo, { 'a.txt': 'a\n' });
    const first = commitAll(repo, 'first');
    writeTree(repo, { 'b.txt': 'b\n' });
    const tip = commitAll(repo, 'second');
    git(repo, ['checkout', '--quiet', '-b', 'side', first]);
    writeTree(repo, { 'c.txt': 'c\n' });
    const side = commitAll(repo, 'side');
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GITHUB_REF_NAME: 'v9.9.9' };
    const check = (head: string): { code: number; out: string } => {
      git(repo, ['checkout', '--quiet', '--detach', head]);
      return runStep(MAIN_CHECK, repo, env);
    };
    // No origin/main fetched: refused.
    expect(check(tip)).toMatchObject({ code: 1, out: expect.stringContaining('origin/main was not fetched') });
    git(repo, ['update-ref', 'refs/remotes/origin/main', tip]);
    expect(check(tip)).toMatchObject({ code: 0, out: expect.stringContaining('on main') });
    expect(check(first).code).toBe(0);
    expect(check(side)).toMatchObject({ code: 1, out: expect.stringContaining(`tag v9.9.9 points at ${side}, which is not on main`) });
  });

  it('installs the packed tarball into an empty prefix and HOME, runs --version and doctor from it, and publishes that tarball', () => {
    const pack = stepScript(PACK);
    expect(pack).toContain('npm pack --pack-destination "$work/pack"');
    for (const v of ['HOME="$work/home"', 'XDG_CONFIG_HOME="$work/xdg/config"', 'XDG_DATA_HOME="$work/xdg/data"', 'XDG_CACHE_HOME="$work/xdg/cache"', 'XDG_STATE_HOME="$work/xdg/state"', 'npm_config_prefix="$work/prefix"']) {
      expect(pack).toContain(v);
    }
    expect(pack).toContain('env -i PATH="$work/prefix/bin:$nodebin:/usr/bin:/bin"');
    expect(pack).toContain('clean npm install --global --no-audit --no-fund "$tarball"');
    expect(pack).toContain('got="$(clean sabotage-council --version)"');
    expect(pack).toContain('out="$(clean sabotage-council doctor 2>&1)" || code=$?');
    expect(pack).toContain('if [ "$code" -ne 1 ]; then');
    expect(pack).toMatch(/echo "TARBALL=\$tarball" >> "\$GITHUB_ENV"\n$/);
    const publish = stepScript(PUBLISH);
    expect([...publish.matchAll(/npm publish (\S+)/g)].map((m) => m[1])).toEqual(['"$TARBALL"', '"$TARBALL"']);
  });

  it('expects of doctor with no config what doctor prints: exit 1, the config refused, the store created', async () => {
    // The pack step's greps, run against this build's doctor with a missing config and a fresh store.
    const patterns = [...stepScript(PACK).matchAll(/grep -q '([^']+)'/g)].map((m) => m[1]!);
    expect(patterns).toHaveLength(2);
    const dir = scratch('sc-release-doctor-');
    const lines: string[] = [];
    const code = await runDoctor({
      configPath: join(dir, 'home', '.config', 'sabotage-council', 'config.toml'),
      dbPath: join(dir, 'home', '.local', 'share', 'sabotage-council', 'council.db'),
      write: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    for (const p of patterns) expect(lines.some((l) => new RegExp(p).test(l)), `${p}\n${lines.join('\n')}`).toBe(true);
  });

  it('publishes a prerelease to next and a release to latest, with a token only while the bootstrap secret exists', () => {
    const dir = scratch('sc-release-publish-');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'npm.log');
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "\${NODE_AUTH_TOKEN-unset}" "\${NPM_BOOTSTRAP_TOKEN-unset}" >> '${log}'\n`);
    chmodSync(join(bin, 'npm'), 0o755);
    const publish = (version: string, token: string): string => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'sabotage-council', version }));
      writeFileSync(log, '');
      const r = runStep(PUBLISH, dir, { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TARBALL: '/w/pack/sabotage-council.tgz', NPM_BOOTSTRAP_TOKEN: token });
      expect(r.code, r.out).toBe(0);
      return readFileSync(log, 'utf8');
    };
    expect(publish('0.2.0-rc.1', '')).toBe('publish /w/pack/sabotage-council.tgz --tag next|unset|unset\n');
    expect(publish('1.0.0-beta', '')).toBe('publish /w/pack/sabotage-council.tgz --tag next|unset|unset\n');
    expect(publish('0.2.0', '')).toBe('publish /w/pack/sabotage-council.tgz|unset|unset\n');
    // The bootstrap release: the token reaches npm as NODE_AUTH_TOKEN, and npm never sees the secret's own name.
    expect(publish('0.1.0', 'npm_bootstrap')).toBe('publish /w/pack/sabotage-council.tgz|npm_bootstrap|unset\n');
  });
});
