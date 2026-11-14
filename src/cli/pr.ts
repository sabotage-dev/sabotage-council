import { dirname } from 'node:path';
import { loadConfig, type ConfigIssue } from '../config/index.js';
import { failRound, removeRoundRoots } from '../engine/index.js';
import { addCredit, postRound, type PostResult } from '../engine/post.js';
import { markerConfig, preparePrRound } from '../engine/pr.js';
import { ghApi, type GitHubApi } from '../forge/github.js';
import type { MirrorSource } from '../forge/mirror.js';
import { parsePrRef, prLabel, type PrRef } from '../forge/pr.js';
import { openStore } from '../store/index.js';
import { layoutOf, type RoundIo, type StorePaths } from './round.js';

/*
 * `round start pr`, `post` and `credit` (plan 3.6, 3.7, 7.1 step 5, 9.3). GitHub is read and written through the
 * user's `gh` (see forge/github.ts for why); tests inject a stub `gh` and a local mirror source.
 */

export interface PrIo extends RoundIo {
  /** The `gh` binary. Default: `gh` on PATH. */
  ghBin?: string | undefined;
  /** Where the mirror fetches from. Default: the GitHub https URL. */
  mirrorSource?: ((ref: PrRef) => MirrorSource) | undefined;
}

function formatIssue(issue: ConfigIssue): string {
  return issue.path === '' ? issue.message : `${issue.path}: ${issue.message}`;
}

function apiOf(io: PrIo): GitHubApi {
  return ghApi({ bin: io.ghBin, env: io.env });
}

async function config(io: PrIo, paths: StorePaths, models: boolean) {
  const registry = models ? (io.registry ?? (io.adapters ? { lister: io.adapters } : undefined)) : undefined;
  const c = await loadConfig(paths.configPath, { registry });
  for (const w of c.warnings) io.write(`warn  ${formatIssue(w)}`);
  if (!c.ok) {
    io.write(`config ${paths.configPath} has ${c.errors.length} error(s):`);
    for (const e of c.errors) io.write(`  ${formatIssue(e)}`);
    io.setExitCode(1);
    return null;
  }
  return c.config;
}

export interface StartPrArgs {
  target: string;
  dryRun: boolean;
  identity: boolean;
  facts: string[];
  questions: string[];
  json: boolean;
  nonce?: string | undefined;
}

/** `round start pr <target>`: prepare a council round (or take the identity path) and hand the legs to the worker. */
export async function roundStartPr(io: PrIo, paths: StorePaths, args: StartPrArgs, startWorker: (roundId: number, paths: StorePaths) => void): Promise<number | null> {
  const cfg = await config(io, paths, true);
  if (cfg === null) return null;
  let ref: PrRef;
  try {
    ref = parsePrRef(args.target);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
    return null;
  }
  const store = openStore(paths.dbPath);
  try {
    const layout = layoutOf(paths);
    const r = preparePrRound(store, {
      config: cfg,
      configPath: paths.configPath,
      layout,
      ref,
      api: apiOf(io),
      source: io.mirrorSource,
      env: io.env,
      ghBin: io.ghBin,
      dryRun: args.dryRun,
      identity: args.identity,
      facts: args.facts,
      questions: args.questions,
      nonce: args.nonce,
    });
    for (const w of r.warnings) io.write(`warn  ${w}`);
    if (r.kind === 'identity') {
      const out = { round_id: r.roundId, round_no: r.roundNo, mode: 'pr', kind: 'identity', target: prLabel(ref), identity: r.match, dry_run: args.dryRun, next: `sabotage-council post ${r.roundId} --dry-run` };
      io.write(args.json ? JSON.stringify(out) : String(r.roundId));
      return r.roundId;
    }
    const i = r.prepared.inputs;
    try {
      startWorker(i.roundId, paths);
    } catch (error) {
      failRound(store, i.roundId, 'worker-start', error instanceof Error ? error.message : String(error));
      removeRoundRoots(layout, i.roundId);
      io.write(`error: round ${i.roundId} failed: its worker did not start (${error instanceof Error ? error.message : String(error)})`);
      io.setExitCode(1);
      return null;
    }
    if (args.json) {
      io.write(
        JSON.stringify({
          round_id: i.roundId,
          round_no: i.roundNo,
          mode: 'pr',
          kind: 'council',
          target: i.label,
          head_sha: i.head,
          rule: i.rule,
          scope: i.scope,
          baseline_sha: i.baseline,
          full_round_reason: i.fullRoundReason,
          dry_run: args.dryRun,
          counted: { count: r.count.count, head_counted: r.count.headCounted, events: r.count.events.length, ignored: r.count.ignored.length },
          earlier_items: i.earlierItems.length,
          human_asks: i.humanAsks.length,
          round_dir: dirname(i.briefFile),
          brief_path: i.briefFile,
          next: `sabotage-council round wait ${i.roundId}`,
        }),
      );
    } else {
      io.write(String(i.roundId));
    }
    return i.roundId;
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
    return null;
  } finally {
    store.close();
  }
}

export function renderPost(r: PostResult): string[] {
  const out: string[] = [];
  const what = r.mode === 'dry-run' ? 'dry run (nothing posted)' : 'post';
  out.push(`round ${r.roundId} ${what}: ${r.outcome}${r.event !== null ? `, event ${r.event} (row ${String(r.row)})` : ''}, commit_id ${r.commitId}`);
  if (r.bodySha256 !== null) out.push(`body sha256 ${r.bodySha256}`);
  if (r.reviewSha256 !== null) out.push(`review sha256 ${r.reviewSha256} (the event and the body: --expect takes this one)`);
  if (r.ci !== null) out.push(`ci ${r.ci.state}: ${r.ci.note}`);
  for (const p of r.problems) out.push(`  ${p}`);
  if (r.reviewId !== null) out.push(`review ${r.reviewId}`);
  for (const g of r.guards) {
    out.push(`guard ${g.kind}${g.reviewId !== null ? ` (review ${g.reviewId})` : ''}: ${g.status === 'pending' ? `PENDING after ${g.attempts} attempt(s)` : g.status}: ${g.outcome}`);
  }
  if (r.body !== null) out.push('----- body -----', ...r.body.replace(/\n$/, '').split('\n'), '----- end -----');
  if (r.next !== null) out.push(`next: ${r.next}`);
  return out;
}

/**
 * `post <round> --dry-run | --post`. Exit 0 when rendered or posted; 1 when refused, superseded or failed, and when a
 * `--post` leaves a guard pending (run `post --post` again to resume it, P6 round 1 row 2).
 */
export async function postCommand(io: PrIo, paths: StorePaths, roundId: number, mode: 'dry-run' | 'post', json: boolean, expect?: string): Promise<void> {
  const cfg = await config(io, paths, false);
  if (cfg === null) return;
  const store = openStore(paths.dbPath);
  try {
    const r = postRound(store, { config: cfg, layout: layoutOf(paths), api: apiOf(io), roundId, mode, expect });
    if (json) io.write(JSON.stringify(r, null, 2));
    else for (const l of renderPost(r)) io.write(l);
    const ok = r.outcome === 'rendered' || r.outcome === 'posted' || r.outcome === 'already-posted';
    io.setExitCode(ok && !(mode === 'post' && r.guards.some((g) => g.status === 'pending')) ? 0 : 1);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  } finally {
    store.close();
  }
}

/** `credit <pr> <review-id>` (plan 3.6 step 4): vouch for an unmarked council review, at its own head and time. */
export async function creditCommand(io: PrIo, paths: StorePaths, target: string, reviewId: number, note: string | undefined): Promise<void> {
  const cfg = await config(io, paths, false);
  if (cfg === null) return;
  const store = openStore(paths.dbPath);
  try {
    const ref = parsePrRef(target);
    const c = addCredit(store, apiOf(io), ref, reviewId, markerConfig(cfg), note ?? null);
    io.write(`credited review ${reviewId} on ${prLabel(ref)}: head ${c.commitId.slice(0, 7)}, submitted ${c.submittedAt}`);
  } catch (error) {
    io.write(`error: ${error instanceof Error ? error.message : String(error)}`);
    io.setExitCode(1);
  } finally {
    store.close();
  }
}
