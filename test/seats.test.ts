import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildProgram, type ProgramIo } from '../src/cli/program.js';
import { applySeatEdit, SeatApplyError } from '../src/seats/apply.js';
import { unifiedDiff } from '../src/seats/diff.js';
import { preservingEditor, SeatEditError, tomlString, verifySeatEdit, type SeatEdit, type SeatEditor } from '../src/seats/edit.js';
import { fakeRegistry } from './fake-registry.js';
import { cleanScratchAfterAll, scratch } from './helpers/fixtures.js';
import { fakeAdapters, fakeHome } from './helpers/round.js';
import { statsStore, three } from './helpers/stats-store.js';

cleanScratchAfterAll();

/*
 * `seats add | remove | swap` (plan 8.4) on temp config files with comments: only the target seat's block changes,
 * a backup is written first, --dry-run writes nothing, and every config-loader rule refuses the edit. Plus `seats
 * list` with the fake CLIs' preflight and a store.
 */

const REGISTRY = fakeRegistry();
const NOW = '2026-11-14T08:09:10.000Z';

const CONFIG = `# my council config
[council]
leg_timeout_minutes = 20   # shorter than the default

# seat a: the codex seat
[[seats]]
id = "a"
backend = "codex"   # cheap and good
model = "gpt-6.1-sol"
effort = "high"
fallback = { backend = "kiro", model = "gpt-5.6-sol", effort = "high", on = ["usage_limit", "auth"] }
# end of seat a

[[seats]]
id = "b"
backend = "claude"
model = "claude-sonnet-5-5"
effort = "high"

[[seats]]
  id = "c"
  backend = 'grok'
  model = "grok-4.7"   # the xai seat
  effort = "high"

# auto settings
[auto]
repos_allow = ["org/*"]
`;

const FOURTH = `
[[seats]]
id = "d"
backend = "antigravity"
model = "gemini-3.8-pro"
`;

function configFile(text: string = CONFIG): { dir: string; path: string } {
  const dir = scratch('sc-seats-');
  const path = join(dir, 'config.toml');
  writeFileSync(path, text, { mode: 0o640 });
  return { dir, path };
}

function filesIn(dir: string): string[] {
  return readdirSync(dir).sort();
}

const swap = (seat: string, backend: string, model: string, effort?: string): SeatEdit => ({ kind: 'swap', seat, occupant: { backend, model, effort } });

describe('seats: the block-preserving editor', () => {
  it('swap changes only the seat\'s occupant lines (a key\'s trailing comment stays) and keeps every other byte', () => {
    const out = preservingEditor.edit(CONFIG, swap('c', 'antigravity', 'gemini-3.8-pro'));
    expect(out).toBe(
      CONFIG.replace(`  backend = 'grok'\n  model = "grok-4.7"   # the xai seat\n  effort = "high"\n`, `  backend = "antigravity"\n  model = "gemini-3.8-pro"   # the xai seat\n`),
    );
    const effort = preservingEditor.edit(CONFIG, swap('a', 'codex', 'gpt-6.1-sol', 'low'));
    expect(effort).toBe(CONFIG.replace('model = "gpt-6.1-sol"\neffort = "high"\nfallback', 'model = "gpt-6.1-sol"\neffort = "low"\nfallback'));
    expect(effort).toContain('backend = "codex"   # cheap and good');
  });

  it('swap inserts an effort (and a grok sandbox or auth_home) the old occupant did not set, after its model line', () => {
    const noEffort = CONFIG.replace('model = "claude-sonnet-5-5"\neffort = "high"\n', 'model = "claude-sonnet-5-5"\n');
    const out = preservingEditor.edit(noEffort, { kind: 'swap', seat: 'b', occupant: { backend: 'grok', model: 'grok-4.7', effort: 'low', sandbox: 'off', auth_home: '/grok/home' } });
    expect(out).toBe(noEffort.replace('backend = "claude"\nmodel = "claude-sonnet-5-5"\n', 'backend = "grok"\nmodel = "grok-4.7"\neffort = "low"\nsandbox = "off"\nauth_home = "/grok/home"\n'));
    // The indentation of a block's keys is kept for inserted keys.
    const c = preservingEditor.edit(CONFIG, { kind: 'swap', seat: 'c', occupant: { backend: 'grok', model: 'grok-4.7', effort: 'high', sandbox: 'read-only' } });
    expect(c).toContain('  effort = "high"\n  sandbox = "read-only"\n\n# auto settings');
  });

  it('add appends a block after the last seat and before what follows it; remove deletes the block and one blank line', () => {
    const two = CONFIG.replace('[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n', '');
    const added = preservingEditor.edit(two, { kind: 'add', seat: 'b', occupant: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } });
    expect(added).toBe(two.replace('  effort = "high"\n\n# auto settings', '  effort = "high"\n\n[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n# auto settings'));
    const four = CONFIG.replace('\n# auto settings', `${FOURTH}\n# auto settings`);
    expect(preservingEditor.edit(four, { kind: 'remove', seat: 'd' })).toBe(CONFIG);
    expect(preservingEditor.edit(four, { kind: 'remove', seat: 'b' })).toBe(four.replace('[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n', ''));
  });

  it('add places the first block at the end of a file with none, and remove keeps comments after a block', () => {
    expect(preservingEditor.edit('[council]\nleg_timeout_minutes = 5', { kind: 'add', seat: 'a', occupant: { backend: 'codex', model: 'gpt-6.1-sol' } })).toBe(
      '[council]\nleg_timeout_minutes = 5\n\n[[seats]]\nid = "a"\nbackend = "codex"\nmodel = "gpt-6.1-sol"\n',
    );
    const out = preservingEditor.edit(CONFIG.replace('\n# auto settings', `${FOURTH}\n# auto settings`), { kind: 'remove', seat: 'a' });
    expect(out).toContain('# seat a: the codex seat\n# end of seat a\n\n[[seats]]\nid = "b"');
  });

  it('keeps CRLF line endings, and a last line with no newline', () => {
    const crlf = CONFIG.replace(/\n/g, '\r\n');
    const out = preservingEditor.edit(crlf, swap('b', 'claude', 'claude-opus-5-5', 'low'));
    expect(out).toBe(crlf.replace('model = "claude-sonnet-5-5"\r\neffort = "high"\r\n\r\n[[seats]]\r\n  id = "c"', 'model = "claude-opus-5-5"\r\neffort = "low"\r\n\r\n[[seats]]\r\n  id = "c"'));
    // Inserted lines and an added block take the file's CRLF too.
    const noEffort = crlf.replace('model = "claude-sonnet-5-5"\r\neffort = "high"\r\n', 'model = "claude-sonnet-5-5"\r\n');
    expect(preservingEditor.edit(noEffort, swap('b', 'claude', 'claude-sonnet-5-5', 'low'))).toBe(crlf.replace('model = "claude-sonnet-5-5"\r\neffort = "high"\r\n', 'model = "claude-sonnet-5-5"\r\neffort = "low"\r\n'));
    const added = preservingEditor.edit(crlf, { kind: 'add', seat: 'd', occupant: { backend: 'antigravity', model: 'gemini-3.8-pro' } });
    expect(added).not.toMatch(/[^\r]\n/);
    const tail = 'x = 1\n[[seats]]\nid = "a"\nbackend = "codex"\nmodel = "gpt-6.1-sol"';
    expect(preservingEditor.edit(tail, swap('a', 'codex', 'gpt-6.1-sol', 'low'))).toBe(`${tail}\neffort = "low"`);
  });

  it('refuses a file it cannot place a block in safely, never rewriting it', () => {
    const inline = 'seats = [\n  { id = "a", backend = "codex", model = "gpt-6.1-sol" },\n]\n';
    expect(() => preservingEditor.edit(inline, swap('a', 'claude', 'claude-sonnet-5-5'))).toThrow(/inline array/);
    const sub = CONFIG.replace('fallback = { backend = "kiro", model = "gpt-5.6-sol", effort = "high", on = ["usage_limit", "auth"] }\n', '\n[seats.fallback]\nbackend = "kiro"\nmodel = "gpt-5.6-sol"\non = ["auth"]\n');
    expect(() => preservingEditor.edit(sub, swap('b', 'claude', 'claude-opus-5-5'))).toThrow(/\[seats\.fallback\] sub-table/);
    const multi = CONFIG.replace('model = "claude-sonnet-5-5"', 'model = """\nclaude-sonnet-5-5"""');
    expect(() => preservingEditor.edit(multi, swap('b', 'claude', 'claude-opus-5-5'))).toThrow(/spans several lines/);
    expect(() => preservingEditor.edit(CONFIG, swap('z', 'claude', 'claude-opus-5-5'))).toThrow(/no seat "z" in the file \(seats: a, b, c\)/);
    expect(() => preservingEditor.edit('seats = 3\n', swap('a', 'claude', 'claude-opus-5-5'))).toThrow(SeatEditError);
    expect(() => preservingEditor.edit('[[seats]\n', swap('a', 'claude', 'claude-opus-5-5'))).toThrow(/does not parse as TOML/);
  });

  it('is not fooled by a header or a key inside a multi-line string', () => {
    const tricky = CONFIG.replace('[auto]\nrepos_allow = ["org/*"]\n', '[notify]\ncommand = """\n[[seats]]\nid = "x"\nbackend = "codex"\n"""\n');
    const out = preservingEditor.edit(tricky, swap('c', 'grok', 'grok-4.7', 'low'));
    expect(out).toBe(tricky.replace('  effort = "high"\n\n# auto settings', '  effort = "low"\n\n# auto settings'));
  });

  it('checks every edit by parsing both texts: only the target seat may change, and only as the op says', () => {
    const op = swap('c', 'antigravity', 'gemini-3.8-pro');
    const good = preservingEditor.edit(CONFIG, op);
    expect(() => verifySeatEdit(CONFIG, good, op)).not.toThrow();
    expect(() => verifySeatEdit(CONFIG, `${good}\n[pr]\ninteractive_adjudication = "untrusted-too"\n`, op)).toThrow(/the rest of the file parses differently/);
    expect(() => verifySeatEdit(CONFIG, good.replace('model = "claude-sonnet-5-5"', 'model = "claude-opus-5-5"'), op)).toThrow(/do not parse as intended/);
    expect(() => verifySeatEdit(CONFIG, good.replace('model = "gemini-3.8-pro"', 'model = "gemini-3.8-pro"\neffort = "high"'), op)).toThrow(/do not parse as intended/);
    expect(() => verifySeatEdit(CONFIG, CONFIG, { kind: 'remove', seat: 'c' })).toThrow(/do not parse as intended/);
  });

  it('writes TOML basic strings that round-trip', () => {
    expect(tomlString('a"b\\c\nd\u2028')).toBe('"a\\"b\\\\c\\nd\\u2028"');
  });
});

describe('seats: applying an edit to the config file', () => {
  const now = new Date(NOW);

  it('writes a 0600 backup first, then replaces the file atomically, keeping its mode', async () => {
    const { dir, path } = configFile();
    const r = await applySeatEdit(path, swap('c', 'antigravity', 'gemini-3.8-pro'), { registry: REGISTRY, dryRun: false, now });
    expect(r).toMatchObject({ written: true, unchanged: false, backup: join(dir, 'config.toml.bak-20261114T080910Z') });
    expect(readFileSync(r.backup ?? '', 'utf8')).toBe(CONFIG);
    expect(lstatSync(r.backup ?? '').mode & 0o777).toBe(0o600);
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
    expect(readFileSync(path, 'utf8')).toBe(preservingEditor.edit(CONFIG, swap('c', 'antigravity', 'gemini-3.8-pro')));
    expect(filesIn(dir)).toEqual(['config.toml', 'config.toml.bak-20261114T080910Z']);
    // A second edit in the same second gets its own backup.
    const again = await applySeatEdit(path, swap('c', 'grok', 'grok-4.7'), { registry: REGISTRY, dryRun: false, now });
    expect(again.backup).toBe(join(dir, 'config.toml.bak-20261114T080910Z-2'));
  });

  it('keeps the exact mode whatever the umask (a umask that would clear bits)', async () => {
    const { path } = configFile();
    chmodSync(path, 0o664);
    const previous = process.umask(0o077);
    try {
      const r = await applySeatEdit(path, swap('c', 'antigravity', 'gemini-3.8-pro'), { registry: REGISTRY, dryRun: false, now });
      expect(r.written).toBe(true);
      expect(lstatSync(path).mode & 0o777).toBe(0o664);
      expect(lstatSync(r.backup ?? '').mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  it('--dry-run prints the diff and writes nothing', async () => {
    const { dir, path } = configFile();
    const r = await applySeatEdit(path, swap('c', 'antigravity', 'gemini-3.8-pro'), { registry: REGISTRY, dryRun: true, now });
    expect(r).toMatchObject({ written: false, backup: null });
    expect(r.diff).toBe(
      [
        '--- a/config.toml',
        '+++ b/config.toml',
        '@@ -19,9 +19,8 @@',
        ' ',
        ' [[seats]]',
        '   id = "c"',
        "-  backend = 'grok'",
        '-  model = "grok-4.7"   # the xai seat',
        '-  effort = "high"',
        '+  backend = "antigravity"',
        '+  model = "gemini-3.8-pro"   # the xai seat',
        ' ',
        ' # auto settings',
        ' [auto]',
        '',
      ].join('\n'),
    );
    expect(readFileSync(path, 'utf8')).toBe(CONFIG);
    expect(filesIn(dir)).toEqual(['config.toml']);
  });

  it('refuses whatever the config loader would reject, writing nothing', async () => {
    const cases: Array<{ name: string; text?: string; op: SeatEdit; expect: RegExp[] }> = [
      { name: 'four seats', op: { kind: 'add', seat: 'd', occupant: { backend: 'antigravity', model: 'gemini-3.8-pro' } }, expect: [/`seats add` works only below 3 seats; to change a seat's occupant, use `seats swap/, /exactly 3 seats are required \(D10\); found 4/] },
      { name: 'two seats', op: { kind: 'remove', seat: 'c' }, expect: [/removing seat "c" would leave 2; to replace its occupant, use `seats swap c --backend/, /found 2/] },
      {
        name: 'a duplicate id',
        text: CONFIG.replace('[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n', ''),
        op: { kind: 'add', seat: 'a', occupant: { backend: 'claude', model: 'claude-sonnet-5-5' } },
        expect: [/seats\[2\]\.id: duplicate seat id "a"/],
      },
      { name: 'an unknown backend', op: swap('c', 'gemini', 'gemini-3.8-pro'), expect: [/seats\[2\]\.backend: unknown backend/] },
      { name: 'a model the adapter does not list', op: swap('c', 'grok', 'grok-9'), expect: [/seats\[2\]\.model: backend "grok" does not offer model "grok-9"/] },
      { name: "a fallback equal to its seat's occupant", op: swap('a', 'kiro', 'gpt-5.6-sol', 'high'), expect: [/seats\[0\]\.fallback: the fallback is the same occupant as seat "a"/] },
      { name: "another seat's occupant", op: swap('c', 'claude', 'claude-sonnet-5-5', 'high'), expect: [/is the same occupant as seat "b"/] },
    ];
    // A dry run refuses the same edits: its diff never shows a change the real run would refuse.
    for (const dryRun of [false, true]) {
      for (const c of cases) {
        const label = `${c.name}${dryRun ? ' (--dry-run)' : ''}`;
        const { dir, path } = configFile(c.text ?? CONFIG);
        const before = readFileSync(path, 'utf8');
        const error = await applySeatEdit(path, c.op, { registry: REGISTRY, dryRun, now }).then(
          () => null,
          (e: unknown) => e,
        );
        expect(error, label).toBeInstanceOf(SeatApplyError);
        const all = [(error as SeatApplyError).message, ...(error as SeatApplyError).details].join('\n');
        expect(all, label).toMatch(/^refused: the config loader would reject the edited file/);
        for (const re of c.expect) expect(all, label).toMatch(re);
        expect(readFileSync(path, 'utf8'), label).toBe(before);
        expect(filesIn(dir), label).toEqual(['config.toml']);
      }
    }
  });

  it('remove fixes a file with four seats, and add one with two', async () => {
    const four = configFile(CONFIG.replace('\n# auto settings', `${FOURTH}\n# auto settings`));
    expect(await applySeatEdit(four.path, { kind: 'remove', seat: 'd' }, { registry: REGISTRY, dryRun: false, now })).toMatchObject({ written: true });
    expect(readFileSync(four.path, 'utf8')).toBe(CONFIG);
    const two = configFile(CONFIG.replace('[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n', ''));
    expect(await applySeatEdit(two.path, { kind: 'add', seat: 'b', occupant: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' } }, { registry: REGISTRY, dryRun: false, now })).toMatchObject({ written: true });
  });

  it('refuses an inline-array file with a clear message and leaves it as it was', async () => {
    const text = '# seats inline\nseats = [\n  { id = "a", backend = "codex", model = "gpt-6.1-sol" },\n  { id = "b", backend = "claude", model = "claude-sonnet-5-5" },\n  { id = "c", backend = "grok", model = "grok-4.7" },\n]\n';
    const { dir, path } = configFile(text);
    await expect(applySeatEdit(path, swap('c', 'antigravity', 'gemini-3.8-pro'), { registry: REGISTRY, dryRun: false, now })).rejects.toThrow(
      /^cannot edit .*config\.toml safely: line 2: seats are written as an inline array \(or a dotted key\); the editor places only \[\[seats\]\] blocks/,
    );
    expect(readFileSync(path, 'utf8')).toBe(text);
    expect(filesIn(dir)).toEqual(['config.toml']);
  });

  it('edits the file a symlinked config points at, keeping the link', async () => {
    const { dir, path } = configFile();
    const link = join(dir, 'link.toml');
    symlinkSync(path, link);
    const r = await applySeatEdit(link, swap('c', 'antigravity', 'gemini-3.8-pro'), { registry: REGISTRY, dryRun: false, now });
    expect(r.path).toBe(path);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, 'utf8')).toContain('model = "gemini-3.8-pro"');
  });

  it('refuses when the file changes under the edit (through the editor seam), and leaves no backup or temp file', async () => {
    const { dir, path } = configFile();
    const racing: SeatEditor = {
      edit(text, op) {
        writeFileSync(path, `${text}# someone else\n`);
        return preservingEditor.edit(text, op);
      },
    };
    await expect(applySeatEdit(path, swap('c', 'antigravity', 'gemini-3.8-pro'), { registry: REGISTRY, dryRun: false, now, editor: racing })).rejects.toThrow(/changed while it was being edited; nothing was written/);
    expect(readFileSync(path, 'utf8')).toBe(`${CONFIG}# someone else\n`);
    expect(filesIn(dir)).toEqual(['config.toml']);
  });

  it('says so when the edit changes nothing, and writes nothing', async () => {
    const { dir, path } = configFile();
    const r = await applySeatEdit(path, swap('a', 'codex', 'gpt-6.1-sol', 'high'), { registry: REGISTRY, dryRun: false, now });
    expect(r).toMatchObject({ unchanged: true, written: false, diff: '' });
    expect(filesIn(dir)).toEqual(['config.toml']);
  });

  it('refuses a config that is not a regular file', async () => {
    const dir = scratch('sc-seats-dir-');
    await expect(applySeatEdit(dir, swap('a', 'codex', 'gpt-6.1-sol'), { registry: REGISTRY, dryRun: false, now })).rejects.toThrow(/is not a regular file/);
    await expect(applySeatEdit(join(dir, 'missing.toml'), swap('a', 'codex', 'gpt-6.1-sol'), { registry: REGISTRY, dryRun: false, now })).rejects.toThrow(/no config file at/);
  });

  it('diffs by lines', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x')).toBe('');
    expect(unifiedDiff('', 'a\n', 'x')).toBe('--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+a\n');
    expect(unifiedDiff('1\n2\n3\n4\n5\n6\n7\n8\n9\n', '1\n2\n3\n4\nfive\n6\n7\n8\n9\n', 'x', 1)).toBe('--- a/x\n+++ b/x\n@@ -4,3 +4,3 @@\n 4\n-5\n+five\n 6\n');
  });
});

describe('seats CLI', () => {
  async function run(args: string[], env: NodeJS.ProcessEnv = {}, adapters: ProgramIo['adapters'] = undefined): Promise<{ code: number; lines: string[]; text: string }> {
    const lines: string[] = [];
    let code = -1;
    const io: ProgramIo = { write: (l) => lines.push(l), env, setExitCode: (c) => (code = c), registry: REGISTRY, adapters, now: () => NOW };
    const program = buildProgram(io);
    for (const c of [program, ...program.commands, ...program.commands.flatMap((c) => c.commands)]) c.exitOverride().configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
    await program.parseAsync(['node', 'sabotage-council', ...args]);
    return { code, lines, text: lines.join('\n') };
  }

  it('swap --dry-run prints the diff, then swap writes it with a backup', async () => {
    const { dir, path } = configFile();
    const dry = await run(['seats', 'swap', 'c', '--backend', 'antigravity', '--model', 'gemini-3.8-pro', '--dry-run', '--config', path]);
    expect(dry.code).toBe(0);
    expect(dry.lines[0]).toBe('--- a/config.toml');
    expect(dry.lines.at(-1)).toBe(`dry run: the edit passes the config loader; nothing was written to ${path}`);
    expect(filesIn(dir)).toEqual(['config.toml']);
    const wet = await run(['seats', 'swap', 'c', '--backend', 'antigravity', '--model', 'gemini-3.8-pro', '--config', path]);
    expect(wet.code).toBe(0);
    expect(wet.lines).toContain(`backup: ${join(dir, 'config.toml.bak-20261114T080910Z')}`);
    expect(wet.lines).toContain(`wrote ${path}`);
    expect(wet.text).toContain('seat c keeps its id: its history stays under seat c, and antigravity / gemini-3.8-pro opens its own occupant row at its first leg');
    expect(wet.text).toContain('`sabotage-council seats test antigravity:gemini-3.8-pro`');
  });

  it('remove on three seats refuses and names swap; add on three refuses', async () => {
    const { path } = configFile();
    const rm = await run(['seats', 'remove', 'b', '--config', path]);
    expect(rm.code).toBe(1);
    expect(rm.lines[0]).toBe('refused: the config loader would reject the edited file (1 error(s)); nothing was written');
    expect(rm.lines[1]).toBe('  seats are fixed at 3 (D10): removing seat "b" would leave 2; to replace its occupant, use `seats swap b --backend <backend> --model <model>`');
    const add = await run(['seats', 'add', 'd', '--backend', 'antigravity', '--model', 'gemini-3.8-pro', '--config', path]);
    expect(add.code).toBe(1);
    expect(add.lines[1]).toContain('`seats add` works only below 3 seats');
    expect(readFileSync(path, 'utf8')).toBe(CONFIG);
    await expect(run(['seats', 'swap', 'c', '--model', 'x', '--config', path])).rejects.toThrow(/required option '--backend <backend>' not specified/);
    await expect(run(['seats', 'swap', 'C', '--backend', 'codex', '--model', 'x', '--config', path])).rejects.toThrow(/a seat id is/);
  });

  it('list shows each seat, its fallback, the enforcement label from the preflight, and a scorecard line from the store', async () => {
    const dir = scratch('sc-seats-list-');
    const path = join(dir, 'config.toml');
    writeFileSync(
      path,
      `[[seats]]\nid = "a"\nbackend = "codex"\nmodel = "gpt-6.1-sol"\neffort = "low"\nfallback = { backend = "claude", model = "claude-sonnet-5-5", effort = "low", on = ["usage_limit", "auth"] }\n\n[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-haiku-5-5"\neffort = "low"\n\n[[seats]]\nid = "c"\nbackend = "claude"\nmodel = "claude-opus-5-5"\neffort = "low"\n\n[stats]\nswap_min_ratified_rounds = 2\n`,
    );
    const w = statsStore();
    for (let i = 0; i < 2; i++) {
      // a and b share an adopted follow-up in each round, so neither is a silent seat (owner ruling, 2026-11-14).
      w.round({
        legs: three({ c: 'NEEDS-WORK' }, { a: { occ: 'codex:gpt-6.1-sol:low' }, b: { occ: 'claude:claude-haiku-5-5:low' }, c: { occ: 'claude:claude-opus-5-5:low' } }),
        findings: [{ outcome: 'refuted', by: ['c'] }, { outcome: 'follow-up', by: ['a', 'b'] }],
      });
    }
    w.close();
    const { env } = fakeHome({});
    const r = await run(['seats', 'list', '--config', path, '--db', w.dbPath], env, fakeAdapters);
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`seats in ${path}:`);
    expect(r.lines[1]).toMatch(/^a {2}codex \/ gpt-6\.1-sol \/ low {2}enforcement sandboxed-exec \(codex [0-9.]+\)$/);
    expect(r.lines[2]).toMatch(/^ {3}fallback {2}claude \/ claude-sonnet-5-5 \/ low on usage_limit, auth {2}enforcement strong \(claude [0-9.]+\)$/);
    expect(r.lines[3]).toBe('   scorecard  seated 2, ratified 100%, raised 2, precision 100%, unique owed 0, blocking lost without it 0: keep codex:gpt-6.1-sol:low');
    expect(r.lines[5]).toBe('   scorecard  seated 2, ratified 100%, raised 2, precision 100%, unique owed 0, blocking lost without it 0: keep claude:claude-haiku-5-5:low');
    expect(r.lines[7]).toBe('   scorecard  seated 2, ratified 100%, raised 2, precision 0%, unique owed 0, blocking lost without it 0: SWAP CANDIDATE: claude:claude-opus-5-5:low since round #1 (see `sabotage-council stats`)');
    // After a swap (the config names a new occupant for c), the flag judges the new occupant: no round under it yet.
    writeFileSync(path, readFileSync(path, 'utf8').replace('model = "claude-opus-5-5"\neffort = "low"', 'model = "claude-opus-5-5"\neffort = "high"'));
    const swapped = await run(['seats', 'list', '--config', path, '--db', w.dbPath, '--no-preflight'], env, fakeAdapters);
    expect(swapped.lines[7]).toBe('   scorecard  seated 2, ratified 100%, raised 2, precision 0%, unique owed 0, blocking lost without it 0: not enough rounds under claude:claude-opus-5-5:high for the swap flag yet');
    const json = JSON.parse((await run(['seats', 'list', '--config', path, '--db', join(dir, 'none.db'), '--no-preflight', '--json'], env, fakeAdapters)).text) as {
      seats: Array<{ id: string; label: unknown; fallback: { label: unknown } | null; scorecard: unknown }>;
    };
    expect(json.seats.map((s) => [s.id, s.label, s.fallback?.label ?? null, s.scorecard])).toEqual([
      ['a', null, null, null],
      ['b', null, null, null],
      ['c', null, null, null],
    ]);
    expect(existsSync(join(dir, 'none.db'))).toBe(false);
    const plain = await run(['seats', 'list', '--config', path, '--db', join(dir, 'none.db'), '--no-preflight']);
    expect(plain.lines[1]).toBe('a  codex / gpt-6.1-sol / low  enforcement not checked (--no-preflight)');
    expect(plain.lines[3]).toBe('   scorecard  no rounds recorded for this seat yet');
  });

  it('list refuses an invalid config', async () => {
    const { path } = configFile(CONFIG.replace('[[seats]]\nid = "b"\nbackend = "claude"\nmodel = "claude-sonnet-5-5"\neffort = "high"\n\n', ''));
    chmodSync(path, 0o600);
    const r = await run(['seats', 'list', '--config', path, '--no-preflight']);
    expect(r.code).toBe(1);
    expect(r.lines).toEqual([`config ${path} has 1 error(s):`, '  seats: exactly 3 seats are required (D10); found 2']);
  });
});
