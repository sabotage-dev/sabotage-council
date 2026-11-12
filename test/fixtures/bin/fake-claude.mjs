#!/usr/bin/env node
// A stand-in for the claude CLI in tests. It replays a fixture: the stream-json lines on stdout and the
// transcript under <projectsDirectory>/-sc-root/<session>.jsonl. Behaviour comes from $HOME/fake-claude.json,
// because the adapter scrubs every other variable.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.HOME ?? '';
const config = JSON.parse(readFileSync(join(home, 'fake-claude.json'), 'utf8'));
const args = process.argv.slice(2);
const FIXTURE_SESSION = '00000000-0000-4000-8000-0000000000c1';
const projects = join(home, 'projects');
const log = (name, value) => writeFileSync(join(home, name), JSON.stringify(value, null, 2));

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
  log('claude-argv.json', { args, cwd: process.cwd(), env: Object.keys(process.env).sort() });
  writeFileSync(join(home, 'claude-stdin.txt'), stdin);
  const subst = (s) => s.split('__SC_ROOT__').join(process.cwd()).split(FIXTURE_SESSION).join(session);
  const lines = subst(readFileSync(join(config.fixture, 'stream.jsonl'), 'utf8')).split('\n').filter((l) => l !== '');
  if (config.initTools) {
    const init = JSON.parse(lines[0]);
    init.tools = config.initTools;
    lines[0] = JSON.stringify(init);
  }
  mkdirSync(join(projects, '-sc-root'), { recursive: true });
  writeFileSync(join(projects, '-sc-root', `${session}.jsonl`), subst(readFileSync(join(config.fixture, 'projects', '-sc-root', `${FIXTURE_SESSION}.jsonl`), 'utf8')));
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
