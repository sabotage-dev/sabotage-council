import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_CLASSES } from '../src/adjudicate/index.js';
import { buildProgram } from '../src/cli/program.js';

/*
 * The Claude Code plugin (plan 5.1, 7.1) holds no engine logic, so these checks keep it in step with the engine:
 * the manifests parse, the skill and the command carry the frontmatter Claude Code reads, every engine command the
 * plugin tells the main loop to run exists, and ADJUDICATE.md names every rejection class the validator has.
 * `claude plugin validate` (run by hand, see the build report) checks the rest.
 */

const REPO = new URL('..', import.meta.url).pathname;
const PLUGIN = join(REPO, 'plugin');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m?.[1]) return {};
  return Object.fromEntries(
    m[1].split('\n').map((l) => {
      const i = l.indexOf(':');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
  );
}

describe('plugin', () => {
  it('has a plugin manifest and a marketplace entry that points at it', () => {
    const plugin = JSON.parse(read('plugin/.claude-plugin/plugin.json')) as Record<string, unknown>;
    expect(plugin).toMatchObject({ name: 'sabotage-council', license: 'MIT', author: { name: 'Sabotage Development LLC' } });
    const market = JSON.parse(read('.claude-plugin/marketplace.json')) as { name: string; owner: { name: string }; plugins: Array<{ name: string; source: string }> };
    expect(market.plugins).toEqual([expect.objectContaining({ name: 'sabotage-council', source: './plugin' })]);
    expect(market.owner.name).toBe('Sabotage Development LLC');
  });

  it('ships the skill, the command and ADJUDICATE.md with their frontmatter', () => {
    const skill = frontmatter(read('plugin/skills/sabotage-council/SKILL.md'));
    expect(skill['name']).toBe('sabotage-council');
    expect(skill['description']?.length).toBeGreaterThan(50);
    expect(skill['allowed-tools']).toBe('Bash(sabotage-council *)');
    const command = frontmatter(read('plugin/commands/council.md'));
    expect(command['description']).toBeTruthy();
    expect(command['argument-hint']).toContain('plan <file>');
    expect(command['argument-hint']).toContain('diff');
    expect(command['argument-hint']).toContain('status');
    expect(read('plugin/commands/council.md')).toContain('$ARGUMENTS');
    for (const p of ['plugin/skills/sabotage-council/SKILL.md', 'plugin/commands/council.md']) {
      expect(read(p)).toContain('${CLAUDE_PLUGIN_ROOT}/ADJUDICATE.md');
    }
  });

  it('names only engine commands and flags that exist', () => {
    const program = buildProgram({ write: () => undefined, env: {}, setExitCode: () => undefined });
    const known = new Set<string>();
    const walk = (cmd: typeof program, prefix: string[]): void => {
      for (const sub of cmd.commands) {
        const path = [...prefix, sub.name()];
        known.add(path.join(' '));
        walk(sub, path);
      }
    };
    walk(program, []);
    const text = files(PLUGIN).filter((f) => f.endsWith('.md')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const used = [...text.matchAll(/sabotage-council ((?:round (?:start (?:plan|diff)|wait|show))|adjudicate|doctor)\b/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(5);
    for (const u of used) expect(known, u).toContain(u);
    expect(text).toContain('--timeout');
    expect(text).toContain('--json');
  });

  it('ADJUDICATE.md names every rejection class the validator has', () => {
    const text = read('plugin/ADJUDICATE.md');
    for (const cls of CHECK_CLASSES) expect(text, cls).toContain(`[${cls}]`);
  });

  it('holds no em dash and no local path', () => {
    for (const f of [...files(PLUGIN), join(REPO, '.claude-plugin', 'marketplace.json')]) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain('\u2014');
      expect(text, f).not.toMatch(/\/Users\/|\/home\/[a-z]/);
    }
  });
});
