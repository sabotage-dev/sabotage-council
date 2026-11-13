#!/usr/bin/env node
// A stub `gh` for the pr-mode tests: it answers `gh api ...` from recorded JSON and logs every request.
// $FAKE_GH_DIR/routes.json maps "<METHOD> <path without query>" (or "graphql") to a response:
//   { "json": <value> } | { "file": "<path>" } | { "fail": "<stderr text>" } | { "echoReview": { "id": n, "login": "x" } }
//   | { "seq": [<response>, ...] }  (one per call, the last repeats)
// Every call appends one JSON line to $FAKE_GH_DIR/requests.jsonl: method, path, args, and the body read from stdin.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const dir = process.env.FAKE_GH_DIR;
if (!dir) {
  process.stderr.write('fake-gh: FAKE_GH_DIR is not set\n');
  process.exit(2);
}
const args = process.argv.slice(2);
if (args[0] !== 'api') {
  process.stderr.write(`fake-gh: only "gh api" is faked, got ${args.join(' ')}\n`);
  process.exit(2);
}
let method = 'GET';
let input = false;
let paginate = false;
let slurp = false;
let path = null;
const fields = {};
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--method' || a === '-X') method = args[++i];
  else if (a === '--input') input = args[++i] === '-';
  else if (a === '--paginate') paginate = true;
  else if (a === '--slurp') slurp = true;
  else if (a === '-f' || a === '-F' || a === '--raw-field' || a === '--field') {
    const kv = args[++i];
    const eq = kv.indexOf('=');
    fields[kv.slice(0, eq)] = kv.slice(eq + 1);
  } else if (!a.startsWith('-') && path === null) path = a;
  else {
    process.stderr.write(`fake-gh: unknown argument ${a}\n`);
    process.exit(2);
  }
}
const body = input ? readFileSync(0, 'utf8') : null;
const bare = path.split('?')[0];
const key = bare === 'graphql' ? 'graphql' : `${method} ${bare}`;
appendFileSync(join(dir, 'requests.jsonl'), `${JSON.stringify({ method, path, key, paginate, slurp, fields: key === 'graphql' ? { ...fields, query: undefined } : fields, body: body === null ? null : JSON.parse(body) })}\n`);

const routes = JSON.parse(readFileSync(join(dir, 'routes.json'), 'utf8'));
let route = routes[key];
if (route === undefined) {
  process.stderr.write(`gh: Not Found (HTTP 404) for ${key}\n`);
  process.exit(1);
}
if (route.seq) {
  const stateFile = join(dir, 'state.json');
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
  const n = state[key] ?? 0;
  state[key] = n + 1;
  writeFileSync(stateFile, JSON.stringify(state));
  route = route.seq[Math.min(n, route.seq.length - 1)];
}
if (route.fail !== undefined) {
  process.stderr.write(`${route.fail}\n`);
  process.exit(1);
}
let out;
if (route.json !== undefined) out = route.json;
else if (route.file !== undefined) out = JSON.parse(readFileSync(isAbsolute(route.file) ? route.file : join(dir, route.file), 'utf8'));
else if (route.echoReview !== undefined) {
  const req = JSON.parse(body);
  const states = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };
  out = { id: route.echoReview.id, user: { login: route.echoReview.login }, state: states[req.event], commit_id: req.commit_id, submitted_at: '2026-11-13T12:00:00Z', body: req.body };
} else out = {};
process.stdout.write(JSON.stringify(paginate && slurp ? [out] : out));
