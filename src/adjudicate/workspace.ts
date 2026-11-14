import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashManifest, manifestOf } from '../root/hash.js';
import { walk } from '../root/walk.js';
import type { Store } from '../store/open.js';
import { roundFacts, type RoundFacts } from '../engine/facts.js';
import type { DataLayout } from '../engine/prepare.js';
import { rebuildRoot } from '../engine/run.js';
import { rootPathOf } from '../engine/roots.js';
import { roundSummary, type LegSummary, type RoundSummary } from '../engine/summary.js';
import { COUNCIL_DIR, MAINLOOP_DIR, OUTPUT_FILE, OUTPUT_PLACEHOLDER } from './launch.js';

/*
 * The headless adjudicator's working directory (plan 6.4, 7.2): a copy of the round's sealed root, proven to hash to
 * the tree the seats read, plus two engine dirs:
 *
 *   - `_council/` (read-only by the allow rule): ADJUDICATE.md, ROUND.json (the round as `round wait` prints it, with
 *     every path relative to the copy), RATIFICATION.md (the ratification table), TESTS.md (the test result) and
 *     each counted leg's answer;
 *   - `_mainloop/` (the only Edit target): the placeholder `ADJUDICATION.json`, created first so Edit is the only
 *     write the run needs.
 *
 * The copy lives in the run dir, never in the roots dir, and is removed when the run ends.
 */

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export interface Workspace {
  /** The working copy: the adjudicator's cwd. */
  root: string;
  /** `_mainloop/ADJUDICATION.json` in the copy. */
  output: string;
  /** The sealed tree hash the copy was proven against. */
  treeHash: string;
  /** The hash of `_council/` as written, for the after-run check. */
  inputsHash: string;
  /** Which root the copy was made from (an existing attempt, or a rebuild). */
  source: string;
  facts: RoundFacts;
  summary: RoundSummary;
}

/** The ADJUDICATE.md the plugin ships: the same procedure, schema and checks the interactive adjudicator reads. */
export function adjudicateSpec(): string {
  return readFileSync(new URL('../../plugin/ADJUDICATE.md', import.meta.url), 'utf8');
}

/** The tree hash of the copy without the two engine dirs: equal to the sealed hash while nothing else changed. */
export function copyTreeHash(root: string): string {
  return hashManifest(manifestOf(root).filter((e) => !ownDir(e.path)));
}

/** The hash of `_council/` alone. */
export function inputsTreeHash(root: string): string {
  return hashManifest(manifestOf(join(root, COUNCIL_DIR)));
}

function ownDir(path: string): boolean {
  const top = path.split('/')[0] ?? '';
  return top === COUNCIL_DIR || top === MAINLOOP_DIR;
}

/** Copies a tree entry by entry: files, links (verbatim) and dirs, each with its permission word. */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { mode: 0o700 });
  const entries = walk(from);
  for (const e of entries) {
    const dest = join(to, e.rel);
    if (e.kind === 'dir') mkdirSync(dest, { mode: 0o700 });
    else if (e.kind === 'file') {
      copyFileSync(e.abs, dest);
      chmodSync(dest, e.stats.mode & 0o7777);
    } else if (e.kind === 'symlink') symlinkSync(readlinkSync(e.abs), dest);
    else throw new WorkspaceError(`the root holds a ${e.kind} entry at ${e.rel}; only files, dirs and links are copied`);
  }
  // Dir modes last, deepest first, so a read-only dir is not closed before its contents are written.
  for (const e of [...entries].reverse()) if (e.kind === 'dir') chmodSync(join(to, e.rel), e.stats.mode & 0o7777);
}

/** The first root of the round that still hashes to the sealed tree, else a rebuild from the stored inputs. */
function sourceRoot(layout: DataLayout, facts: RoundFacts): string {
  for (let attempt = 1; attempt <= 64; attempt++) {
    const dir = rootPathOf(layout, facts.roundId, attempt);
    if (!existsSync(dir)) continue;
    try {
      if (hashManifest(manifestOf(dir)) === facts.detail.tree_hash) return dir;
    } catch {
      // An unreadable root is not the sealed root; try the next.
    }
  }
  for (let attempt = 1; attempt <= 64; attempt++) {
    if (existsSync(rootPathOf(layout, facts.roundId, attempt)) || existsSync(`${rootPathOf(layout, facts.roundId, attempt)}.git`)) continue;
    return rebuildRoot(layout, facts, attempt).root;
  }
  throw new WorkspaceError(`round ${facts.roundId} has no root that hashes to the sealed tree, and no free attempt to rebuild one`);
}

/** A leg as the headless adjudicator reads it: every path relative to the working copy, nothing from outside it. */
function legView(l: LegSummary, answer: string | null): Record<string, unknown> {
  return {
    seat: l.seat,
    role: l.role,
    attempt: l.attempt,
    backend: l.backend,
    model: l.model,
    effort: l.effort,
    status: l.status,
    counted: l.counted,
    failure_class: l.failure_class,
    verdict_raw: l.verdict_raw,
    verdict_reason: l.verdict_reason,
    findings: l.findings,
    findings_extracted_by: l.findings_extracted_by,
    findings_problem: l.findings_problem,
    answer_path: answer,
    ratification: l.ratification
      ? { status: l.ratification.status, failed_checks: l.ratification.failed_checks, notes: l.ratification.notes, model_observed: l.ratification.model_observed, effort_observed: l.ratification.effort_observed }
      : null,
  };
}

function legName(l: Pick<LegSummary, 'seat' | 'role' | 'attempt'>): string {
  return `${l.seat}-${l.role}-${l.attempt}`;
}

/** The ratification table (plan 7.2 inputs), one row per leg. */
export function ratificationTable(s: RoundSummary): string {
  const cell = (v: string): string => v.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const lines = [
    `# Ratification table, round ${s.round_id}`,
    '',
    `Quorum: ${s.quorum.label} (${s.quorum.note})`,
    '',
    '| Leg | Occupant | Status | Counted | Failure class | Failed checks |',
    '|---|---|---|---|---|---|',
  ];
  for (const l of s.legs) {
    const failed = (l.ratification?.failed_checks ?? []).map((c) => `${c.name}: ${c.detail}`).join('; ');
    lines.push(
      `| ${cell(legName(l))} | ${cell([l.backend, l.model, l.effort].filter((x) => x !== null).join(' / '))} | ${l.status} | ${l.counted ? 'yes' : 'no'} | ${l.failure_class ?? ''} | ${cell(failed.slice(0, 400))} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** The test result (plan 6.6): opt-in tests run only in auto (P8); a round without one says so. */
export function testsText(): string {
  return '# Test result\n\nNone: no tests ran for this round (opt-in tests, plan 6.6, run only in auto mode). Do not treat a missing test result as a failure.\n';
}

/**
 * Builds the working copy for a headless run in `runDir/work`: the sealed root copied and proven, then `_council/`
 * and the `_mainloop/` placeholder. Throws when no root hashes to the sealed tree or the copy does not.
 */
export function buildWorkspace(store: Store, layout: DataLayout, roundId: number, runDir: string, afterCopy?: (root: string) => void): Workspace {
  const facts = roundFacts(store, layout, roundId);
  const summary = roundSummary(store, layout, roundId);
  const source = sourceRoot(layout, facts);
  const root = join(runDir, 'work');
  copyTree(source, root);
  afterCopy?.(root);
  // A sealed tree never holds `_council` or `_mainloop`: its top level is the engine's names and the repository name,
  // which cannot start with "_" (root/build.ts).
  const copied = copyTreeHash(root);
  if (copied !== facts.detail.tree_hash) throw new WorkspaceError(`the working copy hashes to ${copied}, not the sealed ${facts.detail.tree_hash}`);
  const council = join(root, COUNCIL_DIR);
  mkdirSync(join(council, 'legs'), { recursive: true, mode: 0o700 });
  const legs = summary.legs.map((l) => {
    let answer: string | null = null;
    if (l.counted && l.answer_path !== null) {
      answer = `${COUNCIL_DIR}/legs/${legName(l)}/answer.md`;
      mkdirSync(join(council, 'legs', legName(l)), { mode: 0o700 });
      writeFileSync(join(root, answer), readFileSync(l.answer_path));
    }
    return legView(l, answer);
  });
  const view = {
    round_id: summary.round_id,
    round_no: summary.round_no,
    mode: summary.mode,
    target: summary.target,
    target_key: summary.target_key,
    head_sha: summary.head_sha,
    baseline_sha: summary.baseline_sha,
    scope: summary.scope,
    full_round_reason: summary.full_round_reason,
    rule: summary.rule,
    nonce: summary.nonce,
    root: '.',
    brief_path: 'BRIEF.md',
    output_path: OUTPUT_FILE,
    quorum: summary.quorum,
    legs,
    earlier_items: summary.earlier_items,
    human_asks: facts.detail.human_asks.map((text, i) => ({ id: `H${i + 1}`, text })),
    pr: summary.pr ? { author: summary.pr.author, trusted: summary.pr.trusted, user_change_request: summary.pr.user_change_request, review_items: summary.pr.review_items } : null,
    tests: null,
  };
  writeFileSync(join(council, 'ROUND.json'), `${JSON.stringify(view, null, 2)}\n`);
  writeFileSync(join(council, 'RATIFICATION.md'), ratificationTable(summary));
  writeFileSync(join(council, 'TESTS.md'), testsText());
  writeFileSync(join(council, 'ADJUDICATE.md'), adjudicateSpec());
  mkdirSync(join(root, MAINLOOP_DIR), { mode: 0o700 });
  const output = join(root, OUTPUT_FILE);
  writeFileSync(output, OUTPUT_PLACEHOLDER);
  return { root, output, treeHash: facts.detail.tree_hash, inputsHash: inputsTreeHash(root), source, facts, summary };
}

/** Removes the working copy (the run dir keeps its records). Dirs are opened first: a copied read-only dir would block it. */
export function removeWorkspace(ws: Pick<Workspace, 'root'>): void {
  if (!existsSync(ws.root)) return;
  try {
    chmodSync(ws.root, 0o700);
    for (const e of walk(ws.root)) if (e.kind === 'dir') chmodSync(e.abs, 0o700);
  } catch {
    // Best effort: rmSync below reports nothing either way.
  }
  rmSync(ws.root, { recursive: true, force: true });
}
