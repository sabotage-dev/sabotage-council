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
} from '../src/root/index.js';
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
