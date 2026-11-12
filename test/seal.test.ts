import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderBrief } from '../src/brief/index.js';
import {
  buildRoot,
  CHANGED_FILES_UNKNOWN,
  checkIntegrity,
  IntegrityError,
  prepareRoot,
  sealRoot,
  sweepResidue,
  type RootInputs,
  type RootLayout,
} from '../src/root/index.js';
import { createFixture, removeDir, type Fixture } from './helpers/git-fixture.js';


// Each root spawns a few dozen git processes; slow CI runners need more than the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
let fx: Fixture;
let n = 0;
const rootPath = (): string => join(fx.roots, `t${n++}`);

beforeAll(() => {
  fx = createFixture();
});
afterAll(() => removeDir(fx.tmp));

function inputs(extra: Partial<RootInputs> = {}): RootInputs {
  return { repo: fx.repo, name: 'fixture', head: fx.head, base: fx.mainTip, ...extra };
}

const NONCE = '0123456789ab';
const brief = (layout: RootLayout) =>
  renderBrief({ mode: 'diff', target: 'fixture@feature', round: 1, highOnlyFromRound: 4, layout, nonce: NONCE });

const PROMISES = ['fixture/', '_base/', 'PR.diff', 'COMMITS.log'];

describe('integrity check (plan 5.3)', () => {
  it('passes on a fresh root and fails with a clear message on each kind of damage', () => {
    const built = buildRoot(rootPath(), inputs());
    expect(checkIntegrity(built.root, built.expected, PROMISES)).toEqual([]);

    truncateSync(join(built.root, 'fixture/src/app.ts'), 3);
    unlinkSync(join(built.root, 'fixture/docs/guide.md')); // the first file of a top-level dir
    writeFileSync(join(built.root, 'fixture/src/planted-empty.ts'), '');
    unlinkSync(join(built.root, 'PR.diff'));
    unlinkSync(join(built.root, 'fixture/links/in2'));
    symlinkSync(join(fx.home, '.ssh'), join(built.root, 'fixture/links/in2'));

    const issues = checkIntegrity(built.root, built.expected, PROMISES);
    expect(issues).toEqual(
      expect.arrayContaining([
        'size mismatch: fixture/src/app.ts: expected 26 bytes, found 3',
        expect.stringMatching(/^missing: fixture\/docs\/guide\.md \(7 bytes from fixture@/),
        'zero-byte file that the git tree does not have: fixture/src/planted-empty.ts',
        expect.stringMatching(/^missing: PR\.diff/),
        'the brief promises PR.diff, which is missing',
        'symlink target changed: fixture/links/in2',
        'symlink escapes the root (absolute): fixture/links/in2',
        'symlink escapes the root (outside): fixture/links/in1', // in1 -> in2 now leaves the root
      ]),
    );
    expect(issues).toHaveLength(8);
    expect(() => sealRoot(built, PROMISES)).toThrow(IntegrityError);
    expect(() => sealRoot(built, PROMISES)).toThrow(/^root integrity check failed \(8 issues\):\n- /);
  });

  it('accepts zero-byte files the git tree has, and fails a promised file the build never made', () => {
    const built = buildRoot(rootPath(), inputs());
    expect(checkIntegrity(built.root, built.expected, [...PROMISES, 'FOLD.diff', 'context/notes/'])).toEqual([
      'the brief promises FOLD.diff, which is missing',
      'the brief promises context/notes/, which is missing',
    ]);
  });

  it('flags a directory where the brief promises a file, and the reverse', () => {
    const built = buildRoot(rootPath(), inputs());
    expect(checkIntegrity(built.root, built.expected, ['fixture', 'PR.diff/'])).toEqual([
      'the brief promises the file fixture, which is a directory',
      'the brief promises the directory PR.diff/, which is not a directory',
    ]);
  });
});

describe('tree hash, git commit and residue sweep (plan 3.1, 5.3)', () => {
  it('gives the same hash for the same inputs, built twice in different places', () => {
    const delta = (layout: RootLayout) =>
      renderBrief({ mode: 'diff', target: 'fixture@feature', round: 2, highOnlyFromRound: 4, layout, nonce: NONCE });
    const a = prepareRoot(rootPath(), inputs({ baseline: fx.baseline }), delta);
    const b = prepareRoot(rootPath(), inputs({ baseline: fx.baseline }), delta);
    expect(a.sealed.treeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.sealed.treeHash).toBe(a.sealed.treeHash);
  });

  it('takes the hash after the brief: a different nonce gives a different hash', () => {
    const a = prepareRoot(rootPath(), inputs(), brief);
    const other = prepareRoot(rootPath(), inputs(), (layout) =>
      renderBrief({ mode: 'diff', target: 'fixture@feature', round: 1, highOnlyFromRound: 4, layout, nonce: 'ba9876543210' }),
    );
    expect(other.sealed.treeHash).not.toBe(a.sealed.treeHash);
    expect(a.sealed.manifest.map((e) => e.path)).toContain('BRIEF.md');
  });

  it('commits the root with its git dir outside the root, and sweeps clean before any change', () => {
    const { sealed } = prepareRoot(rootPath(), inputs(), brief);
    expect(existsSync(join(sealed.root, '.git'))).toBe(false);
    expect(sealed.gitDir).toBe(`${sealed.root}.git`);
    expect(sealed.commit).toMatch(/^[0-9a-f]{40}$/);
    const report = sweepResidue(sealed);
    expect(report).toEqual({ treeHash: sealed.treeHash, unchanged: true, changes: [], gitStatus: [], gitStatusError: null });
  });

  it('lists residue anywhere: modified, added (also in ignored paths), removed, and new empty dirs', () => {
    const { sealed } = prepareRoot(rootPath(), inputs(), brief);
    appendFileSync(join(sealed.root, 'fixture/README.md'), 'edited by a leg\n');
    appendFileSync(join(sealed.root, 'fixture/logs/keep.log'), 'edited too\n'); // tracked, but matched by .gitignore
    writeFileSync(join(sealed.root, 'fixture/scratch.log'), 'ignored by the tree .gitignore\n');
    rmSync(join(sealed.root, 'COMMITS.log'));
    mkdirSync(join(sealed.root, 'fixture/newdir'));
    const report = sweepResidue(sealed);
    expect(report.unchanged).toBe(false);
    expect(report.treeHash).not.toBe(sealed.treeHash);
    expect(report.changes).toEqual([
      { path: 'COMMITS.log', change: 'removed' },
      { path: 'fixture/README.md', change: 'modified' },
      { path: 'fixture/logs/keep.log', change: 'modified' },
      { path: 'fixture/newdir', change: 'added' },
      { path: 'fixture/scratch.log', change: 'added' },
    ]);
    // keep.log shows as modified, not ignored: every file was committed with --force.
    expect(report.gitStatus).toEqual(
      expect.arrayContaining([' D COMMITS.log', ' M fixture/README.md', ' M fixture/logs/keep.log', '!! fixture/scratch.log']),
    );
    expect(report.gitStatusError).toBeNull();
  });

  it('notices a changed execute bit', () => {
    const { sealed } = prepareRoot(rootPath(), inputs(), brief);
    chmodSync(join(sealed.root, 'fixture/README.md'), 0o755);
    expect(sweepResidue(sealed).changes).toEqual([{ path: 'fixture/README.md', change: 'modified' }]);
  });

  it('keeps comparing hashes when the git dir is gone', () => {
    const { sealed } = prepareRoot(rootPath(), inputs(), brief);
    rmSync(sealed.gitDir, { recursive: true, force: true });
    const before = sweepResidue(sealed);
    expect(before.unchanged).toBe(true);
    expect(before.gitStatusError).not.toBeNull();
  });

  it('refuses a git dir inside the root, or one that already exists', () => {
    const built = buildRoot(rootPath(), inputs());
    writeFileSync(join(built.root, 'BRIEF.md'), 'x\n');
    expect(() => sealRoot(built, [], { gitDir: join(built.root, 'inner.git') })).toThrow(/outside the root/);
    mkdirSync(`${built.root}.git`);
    expect(() => sealRoot(built, [])).toThrow(/already exists/);
  });
});

describe('context entries', () => {
  it('copies a single file, and a link given as the path stays a link that the symlink pass judges', () => {
    const file = join(fx.tmp, 'one-file.md');
    writeFileSync(file, 'one file\n');
    const link = join(fx.tmp, 'link-to-key');
    symlinkSync(join(fx.home, '.ssh', 'id_test'), link);
    const built = buildRoot(rootPath(), inputs({ context: [{ path: file }, { name: 'key', path: link }] }));
    expect(built.context.map((c) => [c.name, c.isDir])).toEqual([
      ['one-file.md', false],
      ['key', false],
    ]);
    expect(readFileSync(join(built.root, 'context/one-file.md'), 'utf8')).toBe('one file\n');
    expect(readFileSync(join(built.root, 'context/key'), 'utf8')).toBe(`SYMLINK -> ${join(fx.home, '.ssh', 'id_test')} (not followed)\n`);
    expect(checkIntegrity(built.root, built.expected, ['context/one-file.md', 'context/key'])).toEqual([]);
  });

  it('refuses a context ref that does not resolve, and a .git directory as context', () => {
    expect(() => buildRoot(rootPath(), inputs({ context: [{ name: 'lib', repo: fx.ctxRepo, ref: 'no-such-branch' }] }))).toThrow(
      /does not resolve to a commit/,
    );
    expect(() => buildRoot(rootPath(), inputs({ context: [{ name: 'g', path: join(fx.repo, '.git') }] }))).toThrow(/not context/);
  });
});

describe('delta-round fallback detection (plan 3.6)', () => {
  it('a normal delta writes FOLD.diff', () => {
    const built = buildRoot(rootPath(), inputs({ baseline: fx.baseline }));
    expect(built.fold).toEqual({ kind: 'delta', baseline: fx.baseline });
    expect(built.files.foldDiff).toBe(true);
  });

  it('missing: the baseline is not in the repository; changed files unknown', () => {
    const missing = 'a'.repeat(40);
    const built = buildRoot(rootPath(), inputs({ baseline: missing }));
    expect(built.fold).toEqual({
      kind: 'fallback',
      baseline: missing,
      fallback: 'missing',
      reason: 'the baseline head aaaaaaa is missing from the repository',
      changedFiles: CHANGED_FILES_UNKNOWN,
    });
    expect(built.files.foldDiff).toBe(false);
    expect(existsSync(join(built.root, 'FOLD.diff'))).toBe(false);
  });

  it('not an ancestor: a rebase; lists the files whose content differs from the baseline tree', () => {
    const built = buildRoot(rootPath(), inputs({ baseline: fx.diverged }));
    expect(built.fold).toMatchObject({ kind: 'fallback', fallback: 'not-ancestor' });
    if (built.fold?.kind !== 'fallback') throw new Error('expected a fallback');
    expect(built.fold.reason).toBe(`the baseline head ${fx.diverged.slice(0, 7)} is not an ancestor of this head (force-push or rebase)`);
    expect(built.fold.changedFiles).toEqual(expect.arrayContaining(['src/app.ts', 'src/new.ts', 'links/chain1']));
    expect(built.fold.changedFiles).not.toContain('README.md');
  });

  it('empty fold: the content equals what was reviewed', () => {
    const built = buildRoot(rootPath(), inputs({ head: fx.emptyOnTop, baseline: fx.head }));
    expect(built.fold).toEqual({
      kind: 'fallback',
      baseline: fx.head,
      fallback: 'empty-fold',
      reason: `the fold from the baseline head ${fx.head.slice(0, 7)} is empty: the content equals what was reviewed`,
      changedFiles: [],
    });
  });

  it('a fallback round still builds and seals with a full-review brief', () => {
    const { brief: b, sealed } = prepareRoot(rootPath(), inputs({ baseline: fx.diverged }), (layout) =>
      renderBrief({ mode: 'diff', target: 'fixture@feature', round: 3, highOnlyFromRound: 4, layout, nonce: NONCE }),
    );
    expect(b.scope).toBe('fallback');
    expect(b.rule).toBe('serious');
    expect(b.text).toContain('is not an ancestor of this head (force-push or rebase)');
    expect(sweepResidue(sealed).unchanged).toBe(true);
  });
});
