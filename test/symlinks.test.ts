import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { escapingLinks, linkProblem, neutralizeSymlinks, symlinkText } from '../src/root/index.js';
import { removeDir, tempDir } from './helpers/git-fixture.js';

let tmp: string;
let root: string;
let home: string;

beforeEach(() => {
  tmp = tempDir('sc-links-');
  home = join(tmp, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'id_test'), 'FAKE PRIVATE KEY\n');
  root = join(tmp, 'roots', 'r1');
  mkdirSync(join(root, 'repo', 'sub'), { recursive: true });
  mkdirSync(join(root, '_base'), { recursive: true });
  writeFileSync(join(root, 'repo', 'README.md'), 'readme\n');
});
afterEach(() => removeDir(tmp));

function link(rel: string, target: string): void {
  symlinkSync(target, join(root, rel));
}

function isLink(rel: string): boolean {
  return lstatSync(join(root, rel)).isSymbolicLink();
}

describe('symlink neutralization (plan 5.3)', () => {
  it('neutralizes links to a fake ~/.ssh, ../.., an absolute path and a chain; keeps in-root links', () => {
    link('repo/ssh-abs', join(home, '.ssh')); // ~/.ssh with HOME = the fake home
    link('repo/ssh-key', join(home, '.ssh', 'id_test'));
    link('repo/ssh-rel', '../../../home/.ssh');
    link('repo/up', '../..');
    link('repo/abs', '/etc/hosts');
    link('repo/sub/c1', 'c2');
    link('repo/sub/c2', 'c3');
    link('repo/sub/c3', '../../../../home/.ssh/id_test');
    link('repo/sub/in', '../README.md');
    link('repo/sub/indir', '..');
    link('repo/to-base', '../_base');
    const out = neutralizeSymlinks(root, ['repo', '_base', 'context']);
    expect(Object.fromEntries(out.map((n) => [n.path, n.reason]))).toEqual({
      'repo/ssh-abs': 'absolute',
      'repo/ssh-key': 'absolute',
      'repo/ssh-rel': 'outside',
      'repo/up': 'outside',
      'repo/abs': 'absolute',
      'repo/sub/c1': 'outside',
      'repo/sub/c2': 'outside',
      'repo/sub/c3': 'outside',
    });
    for (const n of out) {
      expect(isLink(n.path)).toBe(false);
      expect(readFileSync(join(root, n.path), 'utf8')).toBe(`SYMLINK -> ${n.target} (not followed)\n`);
    }
    expect(readFileSync(join(root, 'repo/ssh-abs'), 'utf8')).toBe(`SYMLINK -> ${home}/.ssh (not followed)\n`);
    expect(readlinkSync(join(root, 'repo/sub/in'))).toBe('../README.md');
    expect(readlinkSync(join(root, 'repo/sub/indir'))).toBe('..');
    expect(readlinkSync(join(root, 'repo/to-base'))).toBe('../_base');
  });

  it('neutralizes dangling links and link loops', () => {
    link('repo/dangling', 'nope');
    link('repo/loop-a', 'loop-b');
    link('repo/loop-b', 'loop-a');
    const out = neutralizeSymlinks(root, ['repo']);
    expect(out.map((n) => [n.path, n.reason])).toEqual([
      ['repo/dangling', 'dangling'],
      ['repo/loop-a', 'dangling'],
      ['repo/loop-b', 'dangling'],
    ]);
  });

  it('neutralizes a relative link that leaves the root and comes back by name (it would escape a copy)', () => {
    link('repo/sub/back', '../../../r1/repo/README.md');
    expect(neutralizeSymlinks(root, ['repo']).map((n) => n.reason)).toEqual(['outside']);
  });

  it('does not walk into a linked directory, and only touches the dirs it is given', () => {
    mkdirSync(join(tmp, 'outside-dir'));
    symlinkSync(join(home, '.ssh'), join(tmp, 'outside-dir', 'evil'));
    link('repo/linked', '../../../outside-dir');
    writeFileSync(join(root, 'elsewhere'), 'x');
    symlinkSync('/etc/hosts', join(root, 'not-a-tree'));
    expect(neutralizeSymlinks(root, ['repo']).map((n) => n.path)).toEqual(['repo/linked']);
    expect(isLink('not-a-tree')).toBe(true);
  });

  it('escapes control characters so the replacement stays one line', () => {
    expect(symlinkText('a\nb\x7f')).toBe('SYMLINK -> a\\x0ab\\x7f (not followed)\n');
  });

  it('linkProblem: absolute first, then a lexical climb out, then dangling, then realpath outside', () => {
    link('repo/abs', '/abs');
    link('repo/climb', '../../out');
    link('repo/dangling', 'nope');
    link('repo/via', 'sub/hop');
    link('repo/sub/hop', '../../../../home');
    link('repo/ok', 'README.md');
    expect(linkProblem(root, root, 'repo/abs', '/abs')).toBe('absolute');
    expect(linkProblem(root, root, 'repo/climb', '../../out')).toBe('outside');
    expect(linkProblem(root, root, 'repo/dangling', 'nope')).toBe('dangling');
    expect(linkProblem(root, root, 'repo/via', 'sub/hop')).toBe('outside'); // lexically inside; realpath is not
    expect(linkProblem(root, root, 'repo/ok', 'README.md')).toBeNull();
  });

  it('escapingLinks reports absolute and outside links, not dangling ones', () => {
    link('repo/abs', '/etc/hosts');
    link('repo/dangling', 'nope');
    link('repo/ok', 'README.md');
    expect(escapingLinks(root)).toEqual([{ path: 'repo/abs', target: '/etc/hosts', reason: 'absolute' }]);
  });
});
