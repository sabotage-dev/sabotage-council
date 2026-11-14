#!/usr/bin/env node
// A stand-in for the claude CLI in tests. It replays a fixture: the stream-json lines on stdout and the
// transcript under <projectsDirectory>/-sc-root/<session>.jsonl. Behaviour comes from $HOME/fake-claude.json,
// because the adapter scrubs every other variable.
//
// Round tests (P5) add opt-in keys:
// - `byOccupant`: { "<model>/<effort>": [case, case, ...] }: the Nth launch of that occupant takes the Nth case (the
//   last one repeats), merged over the top-level config. The count lives in $HOME.
// - `replay: true`: the fixture's nonce, model and effort (from its case.json) become the round's nonce (read from
//   the brief on stdin) and the requested --model and --effort, so a recorded leg replays as this round's leg.
// - `delayMs` and `writeIntoRoot`: wait, then write that file into the root before answering.
// - `answer`: the result text to answer with instead of the fixture's (`${NONCE}` is the round's nonce).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME ?? '';
let config = JSON.parse(readFileSync(join(home, 'fake-claude.json'), 'utf8'));
const args = process.argv.slice(2);
const FIXTURE_SESSION = '00000000-0000-4000-8000-0000000000c1';
const projects = join(home, 'projects');
const log = (name, value) => writeFileSync(join(home, name), JSON.stringify(value, null, 2));
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === '--version') {
  process.stdout.write(`${config.version ?? '2.1.322'} (Claude Code)\n`);
} else if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(
    JSON.stringify({ loggedIn: config.loggedIn ?? true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'never-read', projectsDirectory: projects }),
  );
} else if (args[0] === 'plugin' && args[1] === 'list') {
  process.stdout.write(JSON.stringify(config.plugins ?? []));
} else if (args[0] === '-p') {
  const stdin = readFileSync(0, 'utf8');
  const session = args[args.indexOf('--session-id') + 1];
  const model = argValue('--model');
  const effort = argValue('--effort');
  if (config.byOccupant) {
    const key = `${model}/${effort}`;
    const cases = config.byOccupant[key] ?? [{}];
    const counter = join(home, `fake-claude-launches-${key.replace(/[^\w.-]/g, '_')}`);
    const n = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    writeFileSync(counter, String(n + 1));
    config = { ...config, ...cases[Math.min(n, cases.length - 1)] };
  }
  log('claude-argv.json', { args, cwd: process.cwd(), env: Object.keys(process.env).sort() });
  writeFileSync(join(home, 'claude-stdin.txt'), stdin);
  let replay = (s) => s;
  if (config.replay) {
    const kase = JSON.parse(readFileSync(join(config.fixture, 'case.json'), 'utf8'));
    const nonce = /NONCE: ([0-9a-f]{12})/.exec(stdin)?.[1] ?? kase.nonce;
    replay = (s) => s.split(kase.nonce).join(nonce).split(kase.model).join(model).split(`effort":"${kase.effort}"`).join(`effort":"${effort}"`);
  }
  const subst = (s) => replay(s.split('__SC_ROOT__').join(process.cwd()).split(FIXTURE_SESSION).join(session));
  const lines = subst(readFileSync(join(config.fixture, 'stream.jsonl'), 'utf8')).split('\n').filter((l) => l !== '');
  // Round tests: replace the answer (`${NONCE}` stands for the round's nonce).
  if (config.answer) {
    const nonce = /NONCE: ([0-9a-f]{12})/.exec(stdin)?.[1] ?? '';
    const at = lines.findIndex((l) => JSON.parse(l).type === 'result');
    const result = JSON.parse(lines[at]);
    result.result = config.answer.split('${NONCE}').join(nonce);
    lines[at] = JSON.stringify(result);
    // The stream carries the same text as an assistant text block, as Claude Code writes it.
    for (let i = 0; i < lines.length; i += 1) {
      const row = JSON.parse(lines[i]);
      if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue;
      let changed = false;
      for (const block of row.message.content) {
        if (block.type === 'text') {
          block.text = result.result;
          changed = true;
        }
      }
      if (changed) lines[i] = JSON.stringify(row);
    }
  }
  if (config.initTools || config.initVersion) {
    const init = JSON.parse(lines[0]);
    if (config.initTools) init.tools = config.initTools;
    if (config.initVersion) init.claude_code_version = config.initVersion;
    lines[0] = JSON.stringify(init);
  }
  mkdirSync(join(projects, '-sc-root'), { recursive: true });
  writeFileSync(join(projects, '-sc-root', `${session}.jsonl`), subst(readFileSync(join(config.fixture, 'projects', '-sc-root', `${FIXTURE_SESSION}.jsonl`), 'utf8')));
  if (config.trapTerm) process.on('SIGTERM', () => writeFileSync(join(home, 'got-sigterm'), 'SIGTERM'));
  // Round tests: wait, then write a file into the root (the cwd) before answering, as a leg that mutates the root.
  if (config.delayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, config.delayMs);
  if (config.writeIntoRoot) writeFileSync(join(process.cwd(), config.writeIntoRoot), 'written by a leg\n');
  if (config.hangAfterInit) {
    process.stdout.write(`${lines[0]}\n`);
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(lines.map((l) => `${l}\n`).join(''));
  }
} else {
  process.stderr.write(`fake-claude: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
