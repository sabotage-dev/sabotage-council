import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_CONFIG_DIRS,
  AGENT_CONFIG_FILES,
  agentConfigDir,
  agentConfigFile,
  sanitizedPathMap,
  sanitizeTrees,
  workspaceConfigIn,
} from '../src/root/index.js';
import { CURSOR_WORKSPACE_CONFIG } from '../src/adapters/cursor/preflight.js';
import { MUSE_WORKSPACE_CONFIG } from '../src/adapters/muse/preflight.js';
import { plantCanaryRoot } from '../src/cli/deep.js';
import { removeDir, tempDir } from './helpers/git-fixture.js';

let root: string;

beforeEach(() => {
  root = tempDir('sc-sanitize-');
});
afterEach(() => removeDir(root));

function put(rel: string, content = `${rel}\n`): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe('sanitizer list (plan 6.2)', () => {
  it('is exported as data, exactly the plan list', () => {
    expect(AGENT_CONFIG_DIRS).toEqual(['.claude', '.cursor', '.kiro', '.agents', '.opencode', '.gemini', '.muse', '.codex', '.grok']);
    expect(AGENT_CONFIG_FILES).toEqual([
      'AGENTS*.md',
      'CLAUDE.md',
      'GEMINI.md',
      'MEMORY.md',
      '.mcp.json',
      'opencode.json',
      'opencode.jsonc',
      '.cursorrules',
      '.cursorignore',
    ]);
  });

  it.each([
    ['AGENTS.md', 'AGENTS*.md'],
    ['agents.md', 'AGENTS*.md'],
    ['AGENTS.override.md', 'AGENTS*.md'],
    ['Agents-Team.MD', 'AGENTS*.md'],
    ['claude.md', 'CLAUDE.md'],
    ['Gemini.md', 'GEMINI.md'],
    ['memory.MD', 'MEMORY.md'],
    ['.MCP.JSON', '.mcp.json'],
    ['OpenCode.json', 'opencode.json'],
    ['opencode.JSONC', 'opencode.jsonc'],
    ['.CURSORRULES', '.cursorrules'],
    ['.cursorIgnore', '.cursorignore'],
    ['AGENTS.txt', null],
    ['CLAUDE.md.bak', null],
    ['my-CLAUDE.md', null],
    ['opencode.json5', null],
    ['README.md', null],
  ])('file name %s matches %s', (name, rule) => {
    expect(agentConfigFile(name)).toBe(rule);
  });

  // `*` matches any run of characters, line breaks included (council round 1: `.*` stopped at them).
  it.each([
    ['AGENTS\n.md'],
    ['AGENTS\r.md'],
    ['AGENTS\r\n\n.md'],
    ['AGENTS-x\u2028.md'],
    ['agents\u2029.MD'],
    ['AGENTS\u0085\n## Rules\n.md'],
  ])('file name %j matches AGENTS*.md', (name) => {
    expect(agentConfigFile(name)).toBe('AGENTS*.md');
  });

  it('matches every pattern with each line break inside its wildcard; a literal name has no wildcard', () => {
    for (const glob of AGENT_CONFIG_FILES) {
      for (const brk of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
        expect(agentConfigFile(glob.replaceAll('*', `-${brk}-`)), `${glob} with ${JSON.stringify(brk)}`).toBe(glob);
      }
    }
    expect(agentConfigFile('CLAUDE\n.md')).toBeNull();
    expect(agentConfigFile('.mcp\u2028.json')).toBeNull();
  });

  it.each([
    ['.claude', '.claude'],
    ['.CLAUDE', '.claude'],
    ['.Kiro', '.kiro'],
    ['.claude-plugin', null],
    ['claude', null],
    ['.cursor-tools', null],
  ])('dir name %s matches %s', (name, rule) => {
    expect(agentConfigDir(name)).toBe(rule);
  });
});

describe('sanitizeTrees', () => {
  it('moves dirs whole, renames files at every depth, and only inside the given trees', () => {
    put('repo/.claude/settings.json');
    put('repo/.claude/CLAUDE.md');
    put('repo/a/b/.KIRO/steering/x.md');
    put('repo/a/b/c/Claude.md');
    put('_base/AGENTS.md');
    put('context/n/.mcp.json');
    put('elsewhere/CLAUDE.md');
    const out = sanitizeTrees(root, ['repo', '_base', 'context']);
    expect(out).toEqual([
      { from: 'repo/.claude', to: '_repo-agent-config/repo/.claude', kind: 'dir', rule: '.claude' },
      {
        from: 'repo/.claude/CLAUDE.md',
        to: '_repo-agent-config/repo/.claude/CLAUDE.md.council-data',
        kind: 'file',
        rule: 'CLAUDE.md',
      },
      { from: 'repo/a/b/.KIRO', to: '_repo-agent-config/repo/a/b/.KIRO', kind: 'dir', rule: '.kiro' },
      { from: 'repo/a/b/c/Claude.md', to: 'repo/a/b/c/Claude.md.council-data', kind: 'file', rule: 'CLAUDE.md' },
      { from: '_base/AGENTS.md', to: '_base/AGENTS.md.council-data', kind: 'file', rule: 'AGENTS*.md' },
      { from: 'context/n/.mcp.json', to: 'context/n/.mcp.json.council-data', kind: 'file', rule: '.mcp.json' },
    ]);
    expect(existsSync(join(root, 'elsewhere/CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(root, '_repo-agent-config/repo/a/b/.KIRO/steering/x.md'), 'utf8')).toBe('repo/a/b/.KIRO/steering/x.md\n');
  });

  it('renames agent-config files whose names hold line breaks, at every depth', () => {
    put('repo/AGENTS\n.md');
    put('repo/pkg/AGENTS-x\u2028.md');
    put('repo/pkg/deep/Agents\r\n## Rules\n.MD');
    const out = sanitizeTrees(root, ['repo']);
    expect(out.map((e) => [e.from, e.to, e.rule])).toEqual([
      ['repo/AGENTS\n.md', 'repo/AGENTS\n.md.council-data', 'AGENTS*.md'],
      ['repo/pkg/AGENTS-x\u2028.md', 'repo/pkg/AGENTS-x\u2028.md.council-data', 'AGENTS*.md'],
      ['repo/pkg/deep/Agents\r\n## Rules\n.MD', 'repo/pkg/deep/Agents\r\n## Rules\n.MD.council-data', 'AGENTS*.md'],
    ]);
    expect(readFileSync(join(root, 'repo/AGENTS\n.md.council-data'), 'utf8')).toBe('repo/AGENTS\n.md\n');
    expect(existsSync(join(root, 'repo/AGENTS\n.md'))).toBe(false);
  });

  it('never overwrites: a taken data name gets a number and still ends in .council-data', () => {
    put('repo/CLAUDE.md', 'one\n');
    put('repo/CLAUDE.md.council-data', 'two\n');
    put('repo/CLAUDE.md.2.council-data', 'three\n');
    sanitizeTrees(root, ['repo']);
    expect(readFileSync(join(root, 'repo/CLAUDE.md.council-data'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(root, 'repo/CLAUDE.md.2.council-data'), 'utf8')).toBe('three\n');
    expect(readFileSync(join(root, 'repo/CLAUDE.md.3.council-data'), 'utf8')).toBe('one\n');
  });

  it('moves and renames links by their own names, without following them', () => {
    put('repo/config/claude/settings.json');
    mkdirSync(join(root, 'repo/tools'), { recursive: true });
    symlinkSync('../config/claude', join(root, 'repo/tools/.claude'));
    symlinkSync('README.md', join(root, 'repo/AGENTS.md'));
    sanitizeTrees(root, ['repo']);
    expect(readlinkSync(join(root, '_repo-agent-config/repo/tools/.claude'))).toBe('../config/claude');
    expect(readlinkSync(join(root, 'repo/AGENTS.md.council-data'))).toBe('README.md');
    expect(existsSync(join(root, 'repo/config/claude/settings.json'))).toBe(true);
  });

  it('maps original paths to their final place', () => {
    put('repo/.cursor/rules/a.md');
    put('repo/.cursor/AGENTS.md');
    put('repo/x/GEMINI.md');
    const map = sanitizedPathMap(sanitizeTrees(root, ['repo']));
    expect(map('repo/.cursor/rules/a.md')).toBe('_repo-agent-config/repo/.cursor/rules/a.md');
    expect(map('repo/.cursor/AGENTS.md')).toBe('_repo-agent-config/repo/.cursor/AGENTS.md.council-data');
    expect(map('repo/x/GEMINI.md')).toBe('repo/x/GEMINI.md.council-data');
    expect(map('repo/x/other.md')).toBe('repo/x/other.md');
  });
});

/*
 * Round 1 row 9 (claude F11): every entry the cursor and muse research names as loaded from a workspace, at the
 * top level and nested, is moved or renamed by the sanitizer, and each backend's preflight scan finds it at any
 * depth before the sanitizer runs and nothing after.
 */
const CURSOR_ENTRIES = ['.cursor/rules/planted.mdc', '.cursor/hooks.json', '.cursor/mcp.json', '.cursor/cli.json', '.cursorrules', '.cursorignore', 'AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.mcp.json'];
const MUSE_ENTRIES = ['.muse/hooks.json', '.muse/settings.json', '.agents/AGENTS.md', '.agents/memory/MEMORY.md', '.agents/skills/planted/SKILL.md', '.agents/agents/planted.md', '.codex/skills/planted/SKILL.md', '.claude/CLAUDE.md', '.claude/skills/planted/SKILL.md', 'AGENTS.md', 'CLAUDE.md', 'MEMORY.md', '.mcp.json'];

describe('cursor and muse workspace entries (round 1 row 9)', () => {
  it.each([
    ['cursor', CURSOR_ENTRIES, CURSOR_WORKSPACE_CONFIG],
    ['muse', MUSE_ENTRIES, MUSE_WORKSPACE_CONFIG],
  ])('%s: the preflight scan finds every entry at any depth, and none after the sanitizer', (_backend, entries, names) => {
    for (const prefix of ['repo/', 'repo/pkg/', 'repo/pkg/deep/']) for (const rel of entries) put(`${prefix}${rel}`);
    const before = workspaceConfigIn(root, names);
    for (const prefix of ['repo/', 'repo/pkg/', 'repo/pkg/deep/']) {
      for (const rel of entries) {
        const top = rel.split('/')[0] ?? rel;
        expect(before, `${prefix}${rel}`).toContain(`${prefix}${top}`);
      }
    }
    sanitizeTrees(root, ['repo']);
    expect(workspaceConfigIn(root, names)).toEqual([]);
    for (const prefix of ['repo/', 'repo/pkg/', 'repo/pkg/deep/']) for (const rel of entries) expect(existsSync(join(root, `${prefix}${rel}`)), `${prefix}${rel}`).toBe(false);
  });

  it('the doctor --deep canary root, sanitized, leaves nothing either scan finds', () => {
    plantCanaryRoot(join(root, 'repo'), join(root, 'markers'));
    expect(workspaceConfigIn(root, CURSOR_WORKSPACE_CONFIG).length).toBeGreaterThan(0);
    sanitizeTrees(root, ['repo']);
    expect(workspaceConfigIn(root, CURSOR_WORKSPACE_CONFIG)).toEqual([]);
    expect(workspaceConfigIn(root, MUSE_WORKSPACE_CONFIG)).toEqual([]);
  });

  it('skips the quarantine dir, reports a matching dir without entering it, and reports links by their own names', () => {
    put('_repo-agent-config/repo/.cursor/hooks.json');
    put('repo/.cursor/rules/a.mdc');
    put('repo/notes/AGENTS.council-data');
    symlinkSync('/nonexistent', join(root, 'repo', '.cursorrules'));
    expect(workspaceConfigIn(root, CURSOR_WORKSPACE_CONFIG)).toEqual(['repo/.cursor', 'repo/.cursorrules']);
    expect(workspaceConfigIn(join(root, 'missing'), CURSOR_WORKSPACE_CONFIG)).toEqual([]);
  });

  it('the global list holds .cursorrules and every directory the two backends load', () => {
    expect(AGENT_CONFIG_FILES).toContain('.cursorrules');
    for (const d of ['.cursor', '.claude', '.agents', '.muse', '.codex']) expect(AGENT_CONFIG_DIRS).toContain(d);
  });
});
