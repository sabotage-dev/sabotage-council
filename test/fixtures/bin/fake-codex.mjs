#!/usr/bin/env node
// A stand-in for the codex CLI in tests. It replays a materialized fixture: the event stream on stdout, the
// rollouts under $CODEX_HOME/sessions/<today>, and the answer in the -o file. Behaviour comes from
// $HOME/fake-codex.json, because the adapter scrubs every other variable.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME ?? '';
const config = JSON.parse(readFileSync(join(home, 'fake-codex.json'), 'utf8'));
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
        writeFileSync(join(day, file.split('/').pop()), subst(readFileSync(file, 'utf8'), root));
      }
    }
    const lastText = readFileSync(join(fixture, 'last.txt'), 'utf8');
    if (lastText !== '') writeFileSync(last, lastText);
    process.stderr.write(readFileSync(join(fixture, 'stderr.log'), 'utf8'));
    out(subst(readFileSync(join(fixture, 'events.jsonl'), 'utf8'), root));
    if (config.lingerMs) setTimeout(() => process.exit(0), config.lingerMs);
    if (config.exitCode) process.exitCode = config.exitCode;
  }
} else {
  process.stderr.write(`fake-codex: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
