#!/usr/bin/env node
// A stand-in for the grok CLI in tests. It replays a recorded leg: the stream on stdout and the session dir under
// $GROK_HOME/sessions/<encoded cwd>/<session id>/. Behaviour comes from $GROK_HOME/fake-grok.json.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const grokHome = process.env.GROK_HOME ?? '';
const config = JSON.parse(readFileSync(join(grokHome, 'fake-grok.json'), 'utf8'));
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const log = (name, value) => writeFileSync(join(grokHome, name), JSON.stringify(value, null, 2));

if (args[0] === '--version') {
  process.stdout.write(`grok ${config.version ?? '1.0.70'} (f50904eaee6c) [stable]\n`);
} else if (args[0] === 'models') {
  process.stdout.write(config.loggedIn === false ? 'You are not logged in.\n' : 'You are logged in with grok.com.\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n');
} else if (args[0] === 'inspect') {
  process.stdout.write(readFileSync(config.inspect, 'utf8').split('__SC_ROOT__').join(process.cwd()));
} else if (args[0] === '--prompt-file') {
  const cwd = arg('--cwd');
  const session = arg('-s');
  log('grok-argv.json', { args, cwd: process.cwd(), env: Object.keys(process.env).sort(), home: process.env.HOME });
  const subst = (s) => s.split('__SC_ROOT__').join(cwd).split(config.sessionId).join(session).split('__SC_GROK_HOME__').join(grokHome);
  const dest = join(grokHome, 'sessions', encodeURIComponent(cwd), session);
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(join(config.fixture, 'session'))) writeFileSync(join(dest, f), subst(readFileSync(join(config.fixture, 'session', f), 'utf8')));
  if (config.hang) setInterval(() => {}, 1000);
  else process.stdout.write(subst(readFileSync(join(config.fixture, 'stream.jsonl'), 'utf8')));
} else {
  process.stderr.write(`fake-grok: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
