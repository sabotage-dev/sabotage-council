import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/cli/program.js';
import { parseConfigText } from '../src/config/index.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';

/*
 * The user-facing docs (P10). Every relative link in the docs resolves inside the repository (and every #anchor to a
 * heading GitHub would generate), and the docs and the workflows hold no em dash and no local path.
 */

const REPO = resolve(new URL('..', import.meta.url).pathname);
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

/** The docs a user reads: the front door, the pages under docs/ (the plan aside), the plugin's README. */
function docFiles(): string[] {
  const out = ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'plugin/README.md'];
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(REPO, dir))) {
      const p = join(dir, name);
      if (statSync(join(REPO, p)).isDirectory()) walk(p);
      else if (p.endsWith('.md') && p !== join('docs', 'PLAN.md')) out.push(p);
    }
  };
  walk('docs');
  return out;
}

/** Markdown with fenced code blocks and inline code removed, so a link-shaped string in an example is not a link. */
function prose(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
}

/** The anchors GitHub generates for a file's headings: lowercased, punctuation dropped, spaces to hyphens. */
function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  const body = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '');
  for (const m of body.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const base = m[1]!
      .replace(/`/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

interface Link {
  file: string;
  target: string;
}

function linksOf(file: string): Link[] {
  const text = prose(read(file));
  const targets = [
    ...[...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]!),
    ...[...text.matchAll(/<(https?:\/\/[^>\s]+)>/g)].map((m) => m[1]!),
  ];
  return targets.map((target) => ({ file, target }));
}

/** Why a link does not resolve inside the repository, or null when it does. */
function brokenWhy(link: Link): string | null {
  if (/^https?:\/\//.test(link.target)) return null;
  if (/^[a-z]+:/i.test(link.target)) return `scheme not allowed: ${link.target}`;
  const [path = '', anchor] = link.target.split('#', 2);
  const abs = path === '' ? join(REPO, link.file) : resolve(dirname(join(REPO, link.file)), decodeURIComponent(path));
  const rel = relative(REPO, abs);
  if (rel.startsWith('..') || resolve(REPO, rel) !== abs) return `leaves the repository: ${link.target}`;
  if (!existsSync(abs)) return `no such file: ${rel}`;
  if (anchor !== undefined && anchor !== '') {
    if (!abs.endsWith('.md')) return `an anchor into a non-Markdown file: ${link.target}`;
    if (!anchorsOf(readFileSync(abs, 'utf8')).has(anchor)) return `no heading for #${anchor} in ${rel}`;
  }
  return null;
}

cleanScratchAfterAll();

describe('docs', () => {
  const files = docFiles();

  it('covers the README, the backend pages, the security, migration and release pages', () => {
    for (const f of ['README.md', 'SECURITY.md', 'CHANGELOG.md', 'docs/security.md', 'docs/migration.md', 'docs/releasing.md', 'docs/backends/README.md']) {
      expect(files, f).toContain(f);
    }
    for (const b of ['codex', 'claude', 'grok', 'antigravity', 'kiro', 'opencode', 'cursor', 'muse']) expect(files).toContain(`docs/backends/${b}.md`);
  });

  it('resolves every relative link inside the repository, anchors included', () => {
    const links = files.flatMap(linksOf);
    expect(links.length).toBeGreaterThan(40);
    const broken = links.map((l) => [l, brokenWhy(l)] as const).filter(([, why]) => why !== null).map(([l, why]) => `${l.file}: ${why}`);
    expect(broken).toEqual([]);
  });

  it('flags a link that does not resolve (the checker itself)', () => {
    expect(brokenWhy({ file: 'README.md', target: 'docs/nope.md' })).toMatch(/no such file/);
    expect(brokenWhy({ file: 'README.md', target: '../outside.md' })).toMatch(/leaves the repository/);
    expect(brokenWhy({ file: 'README.md', target: 'docs/security.md#no-such-heading' })).toMatch(/no heading/);
    expect(brokenWhy({ file: 'README.md', target: 'docs/security.md#the-headless-adjudicator' })).toBeNull();
    expect(brokenWhy({ file: 'docs/backends/codex.md', target: 'README.md' })).toBeNull();
    expect(brokenWhy({ file: 'README.md', target: 'javascript:alert(1)' })).toMatch(/scheme/);
  });

  it('holds no em dash and no local path', () => {
    for (const f of [...files, '.github/workflows/release.yml', '.github/workflows/ci.yml']) {
      const text = read(f);
      expect(text, f).not.toContain('\u2014');
      expect(text, f).not.toMatch(/\/Users\/|\/home\/[a-z]|\/private\/tmp\//);
    }
  });

  it('shows configs the loader accepts: the quickstart as written, and the reference with two more seats', async () => {
    const readme = read('README.md');
    const quick = /```sh\nmkdir -p ~\/\.config\/sabotage-council\n[^\n]*cat > [^\n]*<<'EOF'\n([\s\S]*?)EOF\n/.exec(readme)?.[1];
    expect(quick).toBeDefined();
    const q = await parseConfigText(quick!);
    expect(q.ok ? [] : q.errors).toEqual([]);
    // Three families, the grok seat kept; step 1's route for a grok config that starts an MCP server is the seat's own
    // grok home on the commented auth_home line, which loads once it names an existing directory.
    expect(q.ok ? q.config.seats.map((s) => s.backend) : []).toEqual(['codex', 'claude', 'grok']);
    const commented = /^# auth_home = "\/abs\/path\/grok-home"/m;
    expect(quick).toMatch(commented);
    const grokHome = scratch('sc-docs-grok-home-');
    const withHome = await parseConfigText(quick!.replace(commented, `auth_home = ${JSON.stringify(grokHome)}`));
    expect(withHome.ok ? withHome.config.seats[2]?.auth_home : withHome.errors).toBe(grokHome);
    const reference = /```toml\n([\s\S]*?)```/.exec(readme.slice(readme.indexOf('## Configuration')))?.[1];
    expect(reference).toBeDefined();
    const two = '\n[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n[[seats]]\nid = "c"\nbackend = "grok"\nmodel = "grok-4.7"\neffort = "high"\nsandbox = "off"\n';
    const r = await parseConfigText(reference! + two);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it('writes the quickstart config, and never over a config that is already there', () => {
    const block = /```sh\n(mkdir -p ~\/\.config\/sabotage-council\n[\s\S]*?\nEOF\n)```/.exec(read('README.md'))?.[1];
    expect(block).toBeDefined();
    const shells = ['/bin/sh', '/bin/bash', '/bin/zsh'].filter((sh) => existsSync(sh));
    expect(shells.length).toBeGreaterThan(0);
    for (const sh of shells) {
      const home = scratch('sc-docs-quickstart-');
      const file = join(home, '.config', 'sabotage-council', 'config.toml');
      const run = (): number | null => spawnSync(sh, ['-c', block!], { env: { PATH: '/usr/bin:/bin', HOME: home }, encoding: 'utf8' }).status;
      expect(run(), sh).toBe(0);
      expect(readFileSync(file, 'utf8'), sh).toContain('backend = "codex"');
      writeFileSync(file, '# my own config\n');
      expect(run(), sh).not.toBe(0);
      expect(readFileSync(file, 'utf8'), sh).toBe('# my own config\n');
    }
  });

  it('says which commands take --config, --db and --roots as the CLI declares them', () => {
    const program = buildProgram({ write: () => undefined, env: {}, setExitCode: () => undefined });
    const leaves: Array<{ name: string; options: string[] }> = [];
    const walk = (cmd: Command, path: string[]): void => {
      if (cmd.commands.length === 0) leaves.push({ name: path.join(' '), options: cmd.options.map((o) => o.long ?? o.flags) });
      for (const sub of cmd.commands) walk(sub, [...path, sub.name()]);
    };
    for (const cmd of program.commands) walk(cmd, [cmd.name()]);
    expect(leaves.length).toBeGreaterThan(20);
    for (const l of leaves) expect(l.options, l.name).toEqual(expect.arrayContaining(['--config', '--db']));
    const withoutRoots = leaves.filter((l) => !l.options.includes('--roots'));
    expect(withoutRoots.map((l) => l.name).sort()).toEqual(['doctor', 'stats']);
    const list = (xs: string[]): string => (xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}`);
    const code = (xs: string[]): string[] => xs.map((x) => `\`${x}\``);
    const optionsOf = (name: string): string => list(code(withoutRoots.find((l) => l.name === name)!.options));
    const others = [...new Set(leaves.filter((l) => l.options.includes('--roots')).map((l) => l.name.split(' ')[0]!))];
    const readme = read('README.md').replace(/\s+/g, ' ');
    expect(readme).toContain(`\`doctor\` takes ${optionsOf('doctor')}, and \`stats\` takes ${optionsOf('stats')}.`);
    expect(readme).toContain(`Every other command (${list(code(others))}) takes \`--config\`, \`--db\` and \`--roots\``);
  });
});
