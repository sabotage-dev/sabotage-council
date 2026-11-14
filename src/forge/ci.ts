import { ForgeError, restPath, type GitHubApi } from './github.js';
import type { PrRef } from './pr.js';

/*
 * The CI gate for a PR head (plan 3.7, 5.2 `auto.ci_gate`): `required-checks` (the default) judges only the
 * checks GitHub marks required for this PR, plus any required check the base branch's protection or rulesets name
 * that has not reported yet (pending, never green); `all` judges every check; `off` skips the gate. One GraphQL
 * query gives every check run and status context on the head with `isRequired` for this PR, and the GitHub App that
 * reported each check run. A required check bound to an app is satisfied only by a check of that name from that app
 * (P6 round 1 row 11): a same-name check from another app, or a commit status (which names no app), leaves it
 * pending. A read that fails, or a rollup for another commit, is `unknown`, which never approves.
 */

export type CiGate = 'required-checks' | 'all' | 'off';

export interface CiContext {
  name: string;
  required: boolean;
  /** green: success, neutral or skipped; red: failure, error, cancelled, timed out, action required, startup failure;
   * pending: anything not finished (queued, in progress, pending, expected, stale). */
  result: 'green' | 'red' | 'pending';
  /** The GitHub App that reported a check run (its database id); null for a commit status, or when GitHub does not say. */
  appId: number | null;
}

/** A check the base branch requires: its name, and the GitHub App it must come from (null: any app). */
export interface RequiredCheck {
  name: string;
  appId: number | null;
}

/** Whether a reported check satisfies a requirement: the same name, and the bound app when there is one. */
export const satisfies = (req: RequiredCheck, c: CiContext): boolean => req.name === c.name && (req.appId === null || req.appId === c.appId);

export interface CiState {
  gate: CiGate;
  /** off: the gate is off; green, red, pending; unknown: it could not be read for this head. */
  state: 'off' | 'green' | 'red' | 'pending' | 'unknown';
  /** The checks the gate judged, by result. */
  failing: string[];
  pending: string[];
  /** Why the state is unknown, or a note on what was judged. */
  note: string;
}

export const CI_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              contexts(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) checkSuite { app { databaseId } } }
                  ... on StatusContext { context state isRequired(pullRequestNumber: $number) }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const RED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

type Obj = Record<string, unknown>;

function contextOf(node: Obj): CiContext | null {
  if (node['__typename'] === 'CheckRun') {
    const status = String(node['status'] ?? '');
    const conclusion = String(node['conclusion'] ?? '');
    const result = status !== 'COMPLETED' ? 'pending' : GREEN.has(conclusion) ? 'green' : RED.has(conclusion) ? 'red' : 'pending';
    const app = ((node['checkSuite'] as Obj | null | undefined)?.['app'] as Obj | null | undefined)?.['databaseId'];
    return { name: String(node['name'] ?? '(unnamed check)'), required: node['isRequired'] === true, result, appId: typeof app === 'number' ? app : null };
  }
  if (node['__typename'] === 'StatusContext') {
    const state = String(node['state'] ?? '');
    const result = state === 'SUCCESS' ? 'green' : state === 'FAILURE' || state === 'ERROR' ? 'red' : 'pending';
    return { name: String(node['context'] ?? '(unnamed status)'), required: node['isRequired'] === true, result, appId: null };
  }
  return null;
}

/** Every check context on the PR's newest commit, which must be `head`. Throws on a failed read or another head. */
export function readCiContexts(api: GitHubApi, ref: PrRef, head: string): CiContext[] {
  const out: CiContext[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data = api.graphql(CI_QUERY, { owner: ref.owner, name: ref.repo, number: ref.number, after }) as Obj;
    const pr = ((data['repository'] as Obj | null)?.['pullRequest'] ?? null) as Obj | null;
    const node = ((pr?.['commits'] as Obj | undefined)?.['nodes'] as Obj[] | undefined)?.[0];
    const commit = node?.['commit'] as Obj | undefined;
    if (!commit) throw new ForgeError('the CI read found no commit on the pull request');
    if (String(commit['oid']).toLowerCase() !== head.toLowerCase()) throw new ForgeError(`the CI read is for ${String(commit['oid']).slice(0, 7)}, not the reviewed head ${head.slice(0, 7)}`);
    const rollup = commit['statusCheckRollup'] as Obj | null;
    if (rollup === null || rollup === undefined) return out;
    const contexts = rollup['contexts'] as Obj;
    for (const n of (contexts['nodes'] as Obj[] | undefined) ?? []) {
      const c = contextOf(n);
      if (c !== null) out.push(c);
    }
    const info = contexts['pageInfo'] as Obj | undefined;
    if (info?.['hasNextPage'] !== true) return out;
    after = String(info['endCursor']);
  }
  throw new ForgeError('the CI read has more than 2000 contexts');
}

/** An app id GitHub binds a required check to: a positive id; null (or -1, "any app") binds none. */
function boundApp(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;
}

/**
 * The checks the base branch's protection and rulesets require, each with the app it is bound to (classic
 * protection's `checks[].app_id`, a ruleset's `integration_id`; a bare classic `contexts` name binds none). Classic
 * protection is read from the branch object (readable without admin); rulesets from `rules/branches`. A read that
 * fails throws: the gate is then unknown, never green.
 */
export function readRequiredChecks(api: GitHubApi, ref: PrRef, baseRef: string): RequiredCheck[] {
  const out = new Map<string, RequiredCheck>();
  const add = (name: unknown, appId: number | null): void => {
    if (typeof name === 'string') out.set(`${name}\u0000${String(appId)}`, { name, appId });
  };
  const branch = api.get(`${restPath('repos', ref.owner, ref.repo)}/branches/${encodeURIComponent(baseRef)}`) as Obj;
  const protection = (branch['protection'] as Obj | undefined)?.['required_status_checks'] as Obj | undefined;
  const checks = (protection?.['checks'] as Obj[] | undefined) ?? [];
  for (const c of checks) add(c['context'], boundApp(c['app_id']));
  // `contexts` repeats the names of `checks` without their apps: a name already bound there is not loosened.
  for (const c of (protection?.['contexts'] as unknown[] | undefined) ?? []) if (!checks.some((k) => k['context'] === c)) add(c, null);
  const rules = api.list(`${restPath('repos', ref.owner, ref.repo)}/rules/branches/${encodeURIComponent(baseRef)}`) as Obj[];
  for (const rule of rules) {
    if (rule['type'] !== 'required_status_checks') continue;
    for (const c of (((rule['parameters'] as Obj | undefined)?.['required_status_checks'] as Obj[] | undefined) ?? [])) add(c['context'], boundApp(c['integration_id']));
  }
  return [...out.values()];
}

/** Judges the contexts under the gate. Pure. */
export function judgeCi(gate: CiGate, contexts: readonly CiContext[], required: readonly RequiredCheck[] = []): CiState {
  if (gate === 'off') return { gate, state: 'off', failing: [], pending: [], note: 'the CI gate is off' };
  const judged = gate === 'all' ? [...contexts] : contexts.filter((c) => c.required || required.some((r) => satisfies(r, c)));
  const missing = gate === 'all' ? [] : required.filter((r) => !contexts.some((c) => satisfies(r, c)));
  const failing = [...new Set(judged.filter((c) => c.result === 'red').map((c) => c.name))];
  const pending = [
    ...new Set([
      ...judged.filter((c) => c.result === 'pending').map((c) => c.name),
      ...missing.map((r) => (r.appId === null ? `${r.name} (expected, not reported)` : `${r.name} (expected from app ${r.appId}, not reported)`)),
    ]),
  ];
  const state = failing.length > 0 ? 'red' : pending.length > 0 ? 'pending' : 'green';
  const note =
    judged.length === 0 && missing.length === 0 ? (gate === 'all' ? 'no checks on this head' : 'no required checks on this head') : `${judged.length + missing.length} check(s) judged`;
  return { gate, state, failing, pending, note };
}

/** The gate's state for the head; any read failure is `unknown`, with why. */
export function readCi(api: GitHubApi, ref: PrRef, head: string, baseRef: string, gate: CiGate): CiState {
  if (gate === 'off') return judgeCi('off', []);
  try {
    const contexts = readCiContexts(api, ref, head);
    const required = gate === 'required-checks' ? readRequiredChecks(api, ref, baseRef) : [];
    return judgeCi(gate, contexts, required);
  } catch (error) {
    return { gate, state: 'unknown', failing: [], pending: [], note: `CI could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
