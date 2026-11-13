#!/usr/bin/env node
// A stand-in for the codex CLI in tests. It replays a materialized fixture: the event stream on stdout, the
// rollouts under $CODEX_HOME/sessions/<today>, and the answer in the -o file. Behaviour comes from
// $HOME/fake-codex.json, because the adapter scrubs every other variable.
//
// Round tests (P5) add the same opt-in keys as fake-claude: `byOccupant` ({ "<model>/<effort>": [case, ...] }, the
// Nth exec of that occupant takes the Nth case) and `replay` (the fixture's nonce, model and effort become the
// round's nonce from the brief on stdin and the requested -m and model_reasoning_effort).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME ?? '';
let config = JSON.parse(readFileSync(join(home, 'fake-codex.json'), 'utf8'));
const args = process.argv.slice(2);
const out = (s) => process.stdout.write(s);
const pad = (n) => String(n).padStart(2, '0');
const subst = (s, root) => s.split('__SC_ROOT__').join(root);

function log(name, value) {
  writeFileSync(join(home, name), JSON.stringify(value, null, 2));
}

if (args[0] === '--version') {
  out(`codex-cli ${config.version ?? '0.167.0'}\n`);
} else if (args[0] === 'login' && args[1] === 'status') {
  if (config.loggedIn === false) {
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  out('Logged in using ChatGPT\n');
} else if (args[0] === 'debug' && args[1] === 'models') {
  const efforts = ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort }));
  out(JSON.stringify({ models: (config.models ?? ['gpt-6.1-sol']).map((slug) => ({ slug, supported_reasoning_levels: efforts })) }));
} else if (args[0] === 'mcp' && args[1] === 'list') {
  out(JSON.stringify((config.mcp ?? []).map((name) => ({ name, enabled: true }))));
} else if (args[0] === 'debug' && args[1] === 'prompt-input') {
  log('prompt-input-argv.json', { args, cwd: process.cwd() });
  out(subst(readFileSync(config.promptInput, 'utf8'), process.cwd()));
} else if (args[0] === 'exec') {
  const stdin = readFileSync(0, 'utf8');
  const model = args[args.indexOf('-m') + 1];
  const effort = /^model_reasoning_effort="?([a-z]+)"?$/.exec(args.find((a) => a.startsWith('model_reasoning_effort=')) ?? '')?.[1];
  if (config.byOccupant) {
    const key = `${model}/${effort}`;
    const cases = config.byOccupant[key] ?? [{}];
    const counter = join(home, `fake-codex-launches-${key.replace(/[^\w.-]/g, '_')}`);
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(n + 1));
    config = { ...config, ...cases[Math.min(n, cases.length - 1)] };
  }
  let replay = (s) => s;
  if (config.replay && config.fixture) {
    const kase = JSON.parse(readFileSync(join(config.fixture, 'case.json'), 'utf8'));
    const nonce = /NONCE: ([0-9a-f]{12})/.exec(stdin)?.[1] ?? kase.nonce;
    replay = (s) => s.split(kase.nonce).join(nonce).split(kase.model).join(model).split(`effort":"${kase.effort}"`).join(`effort":"${effort}"`);
  }
  log('exec-argv.json', { args, cwd: process.cwd(), env: Object.keys(process.env).sort() });
  writeFileSync(join(home, 'exec-stdin.txt'), stdin);
  const root = args[args.indexOf('-C') + 1];
  const last = args[args.indexOf('-o') + 1];
  if (config.hang) {
    // A grandchild in the same process group, to prove the group kill reaches it.
    const child = spawn('sleep', ['300'], { stdio: 'ignore' });
    writeFileSync(join(home, 'grandchild.pid'), String(child.pid));
    setInterval(() => {}, 1000);
  } else {
    const fixture = config.fixture;
    const sessions = join(fixture, 'codex-home', 'sessions');
    const now = new Date();
    const day = join(process.env.CODEX_HOME ?? join(home, '.codex'), 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(day, { recursive: true });
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    if (existsSync(sessions)) {
      for (const file of walk(sessions).filter((f) => f.endsWith('.jsonl'))) {
        writeFileSync(join(day, file.split('/').pop()), replay(subst(readFileSync(file, 'utf8'), root)));
      }
    }
    const lastText = replay(readFileSync(join(fixture, 'last.txt'), 'utf8'));
    if (lastText !== '') writeFileSync(last, lastText);
    process.stderr.write(readFileSync(join(fixture, 'stderr.log'), 'utf8'));
    out(replay(subst(readFileSync(join(fixture, 'events.jsonl'), 'utf8'), root)));
    if (config.lingerMs) setTimeout(() => process.exit(0), config.lingerMs);
    if (config.exitCode) process.exitCode = config.exitCode;
  }
} else {
  process.stderr.write(`fake-codex: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
