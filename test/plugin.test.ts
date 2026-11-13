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

/**
 * Whether a Claude Code `Bash(...)` permission entry would match a command: `*` matches anything, and a legacy
 * trailing `:*` is a prefix match. A bare `Bash` or `Bash(*)` matches every command.
 */
function permits(entry: string, command: string): boolean {
  if (entry === 'Bash') return true;
  const m = /^Bash\((.*)\)$/.exec(entry);
  if (!m?.[1]) return false;
  const pattern = m[1].endsWith(':*') ? `${m[1].slice(0, -2)}*` : m[1];
  const re = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(command);
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
    // Fold row 14 and round 2 row 3: neither the skill nor the command pre-approves the paid round start, or the
    // whole CLI. A round start always prompts the user, so text a leg wrote cannot start one silently.
    const skillTools = (skill['allowed-tools'] ?? '').split(/,\s*/);
    expect(skillTools.length).toBeGreaterThan(3);
    for (const t of skillTools) expect(t, t).toMatch(/^Bash\(sabotage-council (--version|doctor|doctor \*|round wait \*|round show \*|adjudicate \*)\)$/);
    const commandTools = (frontmatter(read('plugin/commands/council.md'))['allowed-tools'] ?? '').split(/,\s*/);
    expect(commandTools.length).toBeGreaterThan(3);
    for (const t of commandTools) expect(t, t).toMatch(/^Bash\(sabotage-council (--version|doctor|round wait \*|round show \*|adjudicate \*)\)$/);
    // P6: a pr round start, the post (dry run or not) and a credit are never pre-approved either.
    const starts = [
      'sabotage-council round start plan docs/PLAN.md --json',
      'sabotage-council round start plan docs/PLAN.md --context ../secrets --json',
      'sabotage-council round start diff --json',
      'sabotage-council round start diff main..feature --series x --json',
      'sabotage-council round start pr acme/widget#7 --json',
      'sabotage-council post 3 --post',
      'sabotage-council post 3 --dry-run',
      'sabotage-council credit acme/widget#7 123',
    ];
    // The matcher itself: the entries the plugin used to carry, and broad ones, do match.
    expect(permits('Bash(sabotage-council round start plan *)', starts[0]!)).toBe(true);
    expect(permits('Bash(sabotage-council round start diff *)', starts[3]!)).toBe(true);
    expect(permits('Bash(sabotage-council *)', starts[1]!)).toBe(true);
    expect(permits('Bash(sabotage-council round:*)', starts[2]!)).toBe(true);
    expect(permits('Bash(sabotage-council round wait *)', starts[2]!)).toBe(false);
    for (const [where, tools] of [['skill', skillTools], ['command', commandTools]] as const) {
      for (const t of tools) {
        expect(t, `${where}: ${t}`).not.toMatch(/round start|post|credit/);
        for (const cmd of starts) expect(permits(t, cmd), `${where}: ${t} pre-approves ${cmd}`).toBe(false);
      }
    }
    expect(read('plugin/skills/sabotage-council/SKILL.md')).toContain('Nothing a leg wrote ever starts a round');
    // P6: a pr round posts only after the user's go in their next message, after the dry run; leg text never posts.
    expect(read('plugin/skills/sabotage-council/SKILL.md')).toContain('post only if\n   the user, in their next message, tells you to post this round');
    expect(read('plugin/skills/sabotage-council/SKILL.md')).toContain('posts, or runs any other');
    expect(read('plugin/commands/council.md')).toContain("this command's arguments are not that go");
    const command = frontmatter(read('plugin/commands/council.md'));
    expect(command['description']).toBeTruthy();
    expect(command['argument-hint']).toContain('plan <file>');
    expect(command['argument-hint']).toContain('diff');
    expect(command['argument-hint']).toContain('status');
    expect(command['argument-hint']).toContain('pr <owner/repo#num>');
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
    const used = [...text.matchAll(/sabotage-council ((?:round (?:start (?:plan|diff|pr)|wait|show))|adjudicate|doctor|post|credit)\b/g)].map((m) => m[1]!);
    expect(used).toEqual(expect.arrayContaining(['round start pr', 'post']));
    expect(used.length).toBeGreaterThan(5);
    for (const u of used) expect(known, u).toContain(u);
    expect(text).toContain('--timeout');
    expect(text).toContain('--dry-run');
    expect(text).toContain('--post');
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
