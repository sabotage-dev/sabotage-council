#!/usr/bin/env node
// A stand-in for the muse CLI in tests. It replays a recorded run: the envelope stream on stdout, the session log
// under $XDG_DATA_HOME/muse/sessions/2026/11/12/<id>/, and `export` from the fixture. Behaviour comes from
// $FAKE_MUSE (a JSON file path), else <HOME>/fake-muse.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(process.env.FAKE_MUSE ?? join(process.env.HOME ?? '', 'fake-muse.json'), 'utf8'));
const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
const subst = (s, sid) => s.split('__SC_ROOT__').join(process.cwd()).split(config.sessionId).join(sid);

if (args[0] === '--version') {
  process.stdout.write('Muse Code 1.4.15 (1.4.15-R8339.1)\n');
} else if (args[0] === 'usage') {
  if (config.loggedIn === false) {
    process.stdout.write('muse usage: not logged in: run `muse login` first\n');
    process.exit(1);
  }
  process.stdout.write('window: 3% used\n');
} else if (args[0] === 'exec') {
  const sid = arg('--session-id');
  writeFileSync(join(config.out, 'muse-argv.json'), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort(), xdgConfig: process.env.XDG_CONFIG_HOME, auth: process.env.MUSE_AUTH_PATH, home: process.env.HOME }, null, 2));
  const text = subst(readFileSync(join(config.fixture, 'stream.jsonl'), 'utf8'), sid);
  const dir = join(process.env.XDG_DATA_HOME ?? '', 'muse', 'sessions', '2026', '11', '12', sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.jsonl'), text.split('\n').filter((l) => l.includes('"kind": "session"') || l.includes('"kind":"session"')).join('\n') + '\n');
  process.stdout.write(text);
} else if (args[0] === 'export') {
  writeFileSync(arg('--out'), subst(readFileSync(join(config.fixture, 'export.json'), 'utf8'), arg('--session')));
} else {
  process.stderr.write(`fake-muse: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
