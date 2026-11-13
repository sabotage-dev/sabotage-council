import { ForgeError, restPath, type GitHubApi } from './github.js';
import type { PrRef } from './pr.js';

/*
 * The CI gate for a PR head (plan 3.7, 5.2 `auto.ci_gate`): `required-checks` (the default) judges only the
 * checks GitHub marks required for this PR, plus any required context the base branch's protection or rulesets name
 * that has not reported yet (pending, never green); `all` judges every check; `off` skips the gate. One GraphQL
 * query gives every check run and status context on the head with `isRequired` for this PR. A read that fails, or a
 * rollup for another commit, is `unknown`, which never approves.
 */

export type CiGate = 'required-checks' | 'all' | 'off';

export interface CiContext {
  name: string;
  required: boolean;
  /** green: success, neutral or skipped; red: failure, error, cancelled, timed out, action required, startup failure;
   * pending: anything not finished (queued, in progress, pending, expected, stale). */
  result: 'green' | 'red' | 'pending';
}

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
                  ... on CheckRun { name status conclusion isRequired(pullRequestNumber: $number) }
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
    return { name: String(node['name'] ?? '(unnamed check)'), required: node['isRequired'] === true, result };
  }
  if (node['__typename'] === 'StatusContext') {
    const state = String(node['state'] ?? '');
    const result = state === 'SUCCESS' ? 'green' : state === 'FAILURE' || state === 'ERROR' ? 'red' : 'pending';
    return { name: String(node['context'] ?? '(unnamed status)'), required: node['isRequired'] === true, result };
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

/**
 * Required context names the base branch's protection and rulesets name. Classic protection is read from the branch
 * object (readable without admin); rulesets from `rules/branches`. A read that fails throws: the gate is then
 * unknown, never green.
 */
export function readRequiredNames(api: GitHubApi, ref: PrRef, baseRef: string): string[] {
  const names = new Set<string>();
  const branch = api.get(`${restPath('repos', ref.owner, ref.repo)}/branches/${encodeURIComponent(baseRef)}`) as Obj;
  const protection = (branch['protection'] as Obj | undefined)?.['required_status_checks'] as Obj | undefined;
  for (const c of (protection?.['contexts'] as unknown[] | undefined) ?? []) if (typeof c === 'string') names.add(c);
  for (const c of (protection?.['checks'] as Obj[] | undefined) ?? []) if (typeof c['context'] === 'string') names.add(c['context']);
  const rules = api.list(`${restPath('repos', ref.owner, ref.repo)}/rules/branches/${encodeURIComponent(baseRef)}`) as Obj[];
  for (const rule of rules) {
    if (rule['type'] !== 'required_status_checks') continue;
    for (const c of (((rule['parameters'] as Obj | undefined)?.['required_status_checks'] as Obj[] | undefined) ?? [])) {
      if (typeof c['context'] === 'string') names.add(c['context']);
    }
  }
  return [...names];
}

/** Judges the contexts under the gate. Pure. */
export function judgeCi(gate: CiGate, contexts: readonly CiContext[], requiredNames: readonly string[] = []): CiState {
  if (gate === 'off') return { gate, state: 'off', failing: [], pending: [], note: 'the CI gate is off' };
  const judged = gate === 'all' ? [...contexts] : contexts.filter((c) => c.required || requiredNames.includes(c.name));
  const reported = new Set(contexts.map((c) => c.name));
  const missing = gate === 'all' ? [] : requiredNames.filter((n) => !reported.has(n));
  const failing = [...new Set(judged.filter((c) => c.result === 'red').map((c) => c.name))];
  const pending = [...new Set([...judged.filter((c) => c.result === 'pending').map((c) => c.name), ...missing.map((n) => `${n} (expected, not reported)`)])];
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
    const required = gate === 'required-checks' ? readRequiredNames(api, ref, baseRef) : [];
    return judgeCi(gate, contexts, required);
  } catch (error) {
    return { gate, state: 'unknown', failing: [], pending: [], note: `CI could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}
