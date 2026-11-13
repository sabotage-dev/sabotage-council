import { spawnSync } from 'node:child_process';

/*
 * GitHub access for `pr` rounds (plan 5.1 `forge/`, 9.3), through the user's own `gh` CLI (`gh api`). Why `gh` and
 * not an SDK or `fetch`: `gh` already holds the user's login (keychain, `GH_TOKEN`, enterprise hosts), so the engine
 * never reads, stores or forwards a GitHub token (the same stance as plan 6.5 for every other credential); it
 * paginates (`--paginate --slurp`) and fails the whole read with a non-zero exit when any page fails, which is the
 * fail-closed read plan 3.6 asks for; and a stub `gh` on PATH replays recorded JSON in the tests, so the end-to-end
 * test runs the same code as a live round. No new dependency.
 */

export class ForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForgeError';
  }
}

/** The calls the engine makes. Paths are REST paths under the API root (`repos/o/r/pulls/1`). */
export interface GitHubApi {
  /** One GET; the parsed JSON. */
  get(path: string): unknown;
  /** Every page of a GET that returns an array (or an object holding `arrayKey`), flattened. Fails on any page. */
  list(path: string, arrayKey?: string): unknown[];
  /** A GraphQL query with variables; the `data` object. A response with `errors` fails. */
  graphql(query: string, variables: Record<string, string | number | boolean | null>): unknown;
  /** POST, PUT or PATCH with a JSON body; the parsed response. */
  send(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown): unknown;
}

export interface GhOptions {
  /** The `gh` binary. Default: `gh` on PATH. */
  bin?: string | undefined;
  /** The environment `gh` runs with. Default: the process's (gh reads the user's login from it). */
  env?: NodeJS.ProcessEnv | undefined;
  /** Per call. Default 120 s. */
  timeoutMs?: number | undefined;
}

/** A path segment of a REST path: `owner`, `repo` or a number, never a slash or a dot segment. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export function restPath(...parts: Array<string | number>): string {
  return parts
    .map((p) => {
      const s = String(p);
      if (!SEGMENT.test(s) || s === '.' || s === '..') throw new ForgeError(`unsafe path segment "${s}"`);
      return s;
    })
    .join('/');
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ForgeError(`${what}: the response is not JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** A `GitHubApi` that runs `gh api`. Every call is synchronous and fails closed: a non-zero exit is an error. */
export function ghApi(options: GhOptions = {}): GitHubApi {
  const bin = options.bin ?? 'gh';
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: '', CLICOLOR: '0' };
  const timeout = options.timeoutMs ?? 120_000;
  const run = (args: string[], input: string | undefined, what: string): unknown => {
    const r = spawnSync(bin, ['api', ...args], { env, input, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw new ForgeError(`${what}: could not run gh (${r.error.message})`);
    if (r.status !== 0) {
      const detail = `${r.stderr}`.trim().split('\n').slice(0, 3).join(' ') || `exit status ${String(r.status)}`;
      throw new ForgeError(`${what} failed: ${detail}`);
    }
    return parseJson(r.stdout, what);
  };
  return {
    get: (path) => run([path], undefined, `GET ${path}`),
    list: (path, arrayKey) => {
      const sep = path.includes('?') ? '&' : '?';
      const pages = run(['--paginate', '--slurp', `${path}${sep}per_page=100`], undefined, `GET ${path}`);
      if (!Array.isArray(pages)) throw new ForgeError(`GET ${path}: expected a list of pages`);
      const out: unknown[] = [];
      for (const page of pages) {
        const items = arrayKey === undefined ? page : (page as Record<string, unknown> | null)?.[arrayKey];
        if (!Array.isArray(items)) throw new ForgeError(`GET ${path}: a page is not a list${arrayKey === undefined ? '' : ` under "${arrayKey}"`}`);
        out.push(...(items as unknown[]));
      }
      return out;
    },
    graphql: (query, variables) => {
      const args = ['graphql', '-f', `query=${query}`];
      for (const [k, v] of Object.entries(variables)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ForgeError(`unsafe GraphQL variable name "${k}"`);
        if (v === null) continue;
        // -F converts numbers and booleans; strings go raw (-f) so a value is never read as a file (@...).
        args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${String(v)}`);
      }
      const r = run(args, undefined, 'GraphQL query') as { data?: unknown; errors?: unknown } | null;
      if (r === null || typeof r !== 'object') throw new ForgeError('GraphQL query: no response object');
      if (Array.isArray(r.errors) && r.errors.length > 0) throw new ForgeError(`GraphQL query failed: ${JSON.stringify(r.errors).slice(0, 300)}`);
      if (r.data === undefined || r.data === null) throw new ForgeError('GraphQL query: no data');
      return r.data;
    },
    send: (method, path, body) => run(['--method', method, '--input', '-', path], JSON.stringify(body), `${method} ${path}`),
  };
}
