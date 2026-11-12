import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { GitError, runGit, type ShadowRepo } from './git.js';
import { decodeName, FileNameError, splitNul } from './names.js';

export interface TreeEntry {
  /** Git mode: 100644, 100755, 120000 (symlink), 160000 (submodule). */
  mode: string;
  /** Blob size in bytes (for a symlink: the target's length); null for a submodule. */
  size: number | null;
  /** Path inside the tree, `/` separated. */
  path: string;
}

/**
 * Every blob and submodule entry of a commit's tree (`git ls-tree -r -l -z`). Paths are read as bytes: a path that
 * is not valid UTF-8, or that the tree lists twice, throws FileNameError. Either would let two entries share one
 * decoded path, so a check could read one of them while the archive writes the other.
 */
export function listTree(shadow: ShadowRepo, sha: string): TreeEntry[] {
  const out = runGit(['ls-tree', '-r', '-l', '-z', '--full-tree', sha], { gitDir: shadow.gitDir }).stdout;
  const where = `commit ${sha.slice(0, 7)}`;
  const entries: TreeEntry[] = [];
  const seen = new Set<string>();
  for (const record of splitNul(out)) {
    const tab = record.indexOf(0x09);
    const head = tab < 0 ? '' : record.subarray(0, tab).toString('latin1');
    const [mode, , , size] = head.split(/ +/);
    if (mode === undefined || size === undefined || tab < 0) {
      throw new GitError(`unexpected ls-tree record: ${record.toString('utf8')}`, [], null, '');
    }
    const path = decodeName(record.subarray(tab + 1), where);
    if (seen.has(path)) throw new FileNameError(`${where}: the tree lists ${JSON.stringify(path)} twice`, path);
    seen.add(path);
    entries.push({ mode, size: size === '-' ? null : Number.parseInt(size, 10), path });
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
