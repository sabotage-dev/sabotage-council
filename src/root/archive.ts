import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { GitError, runGit, type ShadowRepo } from './git.js';

export interface TreeEntry {
  /** Git mode: 100644, 100755, 120000 (symlink), 160000 (submodule). */
  mode: string;
  /** Blob size in bytes (for a symlink: the target's length); null for a submodule. */
  size: number | null;
  /** Path inside the tree, `/` separated. */
  path: string;
}

/** Every blob and submodule entry of a commit's tree (`git ls-tree -r -l -z`). */
export function listTree(shadow: ShadowRepo, sha: string): TreeEntry[] {
  const out = runGit(['ls-tree', '-r', '-l', '-z', '--full-tree', sha], { gitDir: shadow.gitDir }).stdout.toString('utf8');
  const entries: TreeEntry[] = [];
  for (const record of out.split('\0')) {
    if (record === '') continue;
    const tab = record.indexOf('\t');
    const [mode, , , size] = record.slice(0, tab).split(/ +/);
    if (mode === undefined || size === undefined) throw new GitError(`unexpected ls-tree record: ${record}`, [], null, '');
    entries.push({ mode, size: size === '-' ? null : Number.parseInt(size, 10), path: record.slice(tab + 1) });
  }
  return entries;
}

/**
 * Extracts a commit's tree into `dest` (plan 5.3): `git archive` writes to a temp file, then `tar` extracts it.
 * Never piped: piping failed rounds on macOS with SIGPIPE. Runs in the shadow repo, so the tree's own
 * `.gitattributes` cannot drop or rewrite files on the way out.
 */
export function extractTree(shadow: ShadowRepo, sha: string, dest: string, tarFile: string): void {
  runGit(['archive', '--format=tar', `--output=${tarFile}`, sha], { gitDir: shadow.gitDir });
  mkdirSync(dest, { recursive: true });
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' };
  if (process.env['PATH'] !== undefined) env['PATH'] = process.env['PATH'];
  const result = spawnSync('tar', ['-x', '-f', tarFile, '-C', dest], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.toString('utf8').trim();
    throw new GitError(`extracting ${sha} failed: ${detail}`, [], result.status, detail);
  }
}
