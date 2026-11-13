#!/usr/bin/env node
// A stand-in for cursor-agent in tests. It replays the synthetic fixture's stream on stdout and, like Cursor,
// runs the hooks in $CURSOR_CONFIG_DIR/hooks.json for each recorded hook event, with the event's input on stdin.
// Behaviour comes from $FAKE_CURSOR (a JSON file path).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const config = JSON.parse(readFileSync(process.env.FAKE_CURSOR ?? '/nonexistent', 'utf8'));
const args = process.argv.slice(2);
const root = args[args.indexOf('--workspace') + 1];
const subst = (s) => s.split('__SC_ROOT__').join(root);

if (args[0] === '--version') {
  process.stdout.write(`${config.version ?? '2026.11.11-b912975'}\n`);
} else if (args[0] === 'status') {
  process.stdout.write(config.loggedIn === false ? "Your stored authentication is invalid. Please log in again.\n" : 'Logged in\n');
} else if (args[0] === 'models') {
  process.stdout.write('Available models:\n  gpt-5.5-high\n  claude-opus-5-high\n');
} else if (args[0] === '-p') {
  writeFileSync(join(config.out, 'cursor-argv.json'), JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort(), home: process.env.HOME, configDir: process.env.CURSOR_CONFIG_DIR }, null, 2));
  const hooks = JSON.parse(readFileSync(join(process.env.CURSOR_CONFIG_DIR ?? '', 'hooks.json'), 'utf8')).hooks;
  const decisions = [];
  for (const line of readFileSync(join(config.fixture, 'hooks.ndjson'), 'utf8').split('\n').filter((l) => l.trim() !== '')) {
    const { event, payload } = JSON.parse(subst(line));
    for (const h of hooks[event] ?? []) {
      let out = '';
      let code = 0;
      try {
        out = execFileSync('/bin/sh', ['-c', h.command], { input: JSON.stringify(payload), encoding: 'utf8' });
      } catch (e) {
        out = String(e.stdout ?? '');
        code = e.status ?? 1;
      }
      decisions.push({ event, out, code });
    }
  }
  writeFileSync(join(config.out, 'cursor-hook-decisions.json'), JSON.stringify(decisions, null, 2));
  process.stdout.write(subst(readFileSync(join(config.fixture, 'stream.jsonl'), 'utf8')));
  if (config.hangAfterResult) setInterval(() => {}, 1000);
} else {
  process.stderr.write(`fake-cursor-agent: unexpected arguments ${JSON.stringify(args)}\n`);
  process.exit(2);
}
