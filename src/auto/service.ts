import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/*
 * `auto install | uninstall` (plan 9.4): a launchd agent on macOS, a systemd user unit on Linux, running
 * `sabotage-council auto run` (the daemon loop) with the config, store and roots it was installed with. The service
 * file is rendered, written, validated (macOS: `plutil -lint`; Linux: the unit's own checks, and `systemd-analyze
 * verify` when it is installed), and then loaded unless `--no-load`: `launchctl bootstrap gui/<uid>` or
 * `systemctl --user enable --now`. The environment it gets is PATH and HOME only, so the user's CLIs and their logins
 * are found as in a shell; no token is written into the file.
 *
 * Loading is refused for a file rendered outside the default directory unless the caller names the loader itself:
 * tests render into a temp directory and never reach the real launchctl or systemctl.
 */

export const LAUNCHD_LABEL = 'dev.sabotage-council.auto';
export const SYSTEMD_UNIT = 'sabotage-council-auto.service';

export type ServicePlatform = 'darwin' | 'linux';

export interface ServiceSpec {
  /** The node binary and the CLI entry the service runs. */
  node: string;
  cli: string;
  configPath: string;
  dbPath: string;
  rootsPath: string;
  /** Install the shadow mode: `auto run --dry-run`. */
  dryRun: boolean;
  /** PATH and HOME for the service. */
  path: string;
  home: string;
  /** Where the daemon's output goes (macOS; systemd keeps it in the journal). */
  logFile: string;
}

export function serviceArgs(s: ServiceSpec): string[] {
  return [s.node, s.cli, 'auto', 'run', '--config', s.configPath, '--db', s.dbPath, '--roots', s.rootsPath, ...(s.dryRun ? ['--dry-run'] : [])];
}

export function defaultServiceDir(platform: ServicePlatform, home: string = homedir()): string {
  return platform === 'darwin' ? join(home, 'Library', 'LaunchAgents') : join(home, '.config', 'systemd', 'user');
}

export function serviceFileName(platform: ServicePlatform): string {
  return platform === 'darwin' ? `${LAUNCHD_LABEL}.plist` : SYSTEMD_UNIT;
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** The launchd agent: started at load, kept alive, throttled, its output in the log file. */
export function renderPlist(s: ServiceSpec): string {
  const str = (v: string): string => `<string>${xml(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(LAUNCHD_LABEL)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...serviceArgs(s).map((a) => `    ${str(a)}`),
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    `    <key>PATH</key>${str(s.path)}`,
    `    <key>HOME</key>${str(s.home)}`,
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>60</integer>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key>${str(s.logFile)}`,
    `  <key>StandardErrorPath</key>${str(s.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** One systemd command-line word: quoted, with `\`, `"`, `$` and `%` escaped as systemd reads them. */
export function systemdWord(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '$$$$').replace(/%/g, '%%')}"`;
}

/** One `Environment=` assignment, quoted the same way. */
function systemdEnv(k: string, v: string): string {
  return `Environment=${systemdWord(`${k}=${v}`)}`;
}

export function renderUnit(s: ServiceSpec): string {
  return [
    '[Unit]',
    'Description=sabotage-council auto reviewer',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${serviceArgs(s).map(systemdWord).join(' ')}`,
    systemdEnv('PATH', s.path),
    systemdEnv('HOME', s.home),
    'Restart=on-failure',
    'RestartSec=60',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** What is wrong with a rendered service file, by the engine's own reading (empty: nothing). */
export function serviceProblems(platform: ServicePlatform, text: string, s: ServiceSpec): string[] {
  const problems: string[] = [];
  const args = serviceArgs(s);
  if (platform === 'darwin') {
    if (!text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) problems.push('not an XML plist');
    if (!text.includes(`<key>Label</key><string>${LAUNCHD_LABEL}</string>`)) problems.push('no Label');
    for (const a of args) if (!text.includes(`<string>${xml(a)}</string>`)) problems.push(`ProgramArguments lacks ${a}`);
    const opened = (text.match(/<(dict|array|plist)\b[^>]*>/g) ?? []).length;
    const closed = (text.match(/<\/(dict|array|plist)>/g) ?? []).length;
    if (opened !== closed) problems.push('unbalanced elements');
  } else {
    for (const section of ['[Unit]', '[Service]', '[Install]']) if (!text.includes(`\n${section}\n`) && !text.startsWith(`${section}\n`)) problems.push(`no ${section} section`);
    const exec = /^ExecStart=(.*)$/m.exec(text)?.[1];
    if (exec === undefined) problems.push('no ExecStart');
    else if (exec !== args.map(systemdWord).join(' ')) problems.push('ExecStart does not quote the command line');
  }
  if (/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|sk-[A-Za-z0-9]{20,})/.test(text)) problems.push('the file holds a credential-shaped string');
  return problems;
}

export type Runner = (bin: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string; error?: string | undefined };

export const runSync: Runner = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message };
};

export interface ServiceOptions {
  platform: ServicePlatform;
  /** Where the file goes. Default: ~/Library/LaunchAgents or ~/.config/systemd/user. */
  dir?: string | undefined;
  /** Load (install) or unload (uninstall) it. */
  load: boolean;
  /** The loader binary: launchctl or systemctl. Required to load a file outside the default dir. */
  loader?: string | undefined;
  /** macOS validator; null skips it. Default /usr/bin/plutil when present. */
  plutil?: string | null | undefined;
  /** Linux validator; default `systemd-analyze` when present on PATH, else none. */
  analyze?: string | null | undefined;
  uid?: number | undefined;
  run?: Runner | undefined;
  home?: string | undefined;
}

export interface ServiceResult {
  file: string;
  written: boolean;
  removed: boolean;
  /** Validation output: empty when the file checks out. */
  problems: string[];
  /** The commands run (or, with load off, that would load it). */
  commands: string[][];
  loaded: boolean;
}

function loaderOf(o: ServiceOptions, dir: string): string {
  const isDefault = dir === defaultServiceDir(o.platform, o.home);
  if (o.loader !== undefined) return o.loader;
  if (!isDefault) throw new Error(`refusing to load a service file outside ${defaultServiceDir(o.platform, o.home)} without an explicit loader`);
  return o.platform === 'darwin' ? '/bin/launchctl' : 'systemctl';
}

function loadCommands(o: ServiceOptions, file: string): string[][] {
  if (o.platform === 'darwin') return [['bootstrap', `gui/${o.uid ?? process.getuid?.() ?? 0}`, file]];
  return [['--user', 'daemon-reload'], ['--user', 'enable', '--now', SYSTEMD_UNIT]];
}

function unloadCommands(o: ServiceOptions): string[][] {
  if (o.platform === 'darwin') return [['bootout', `gui/${o.uid ?? process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]];
  return [['--user', 'disable', '--now', SYSTEMD_UNIT]];
}

/** Writes, validates and (unless `load` is off) loads the service. Nothing loads when validation finds a problem. */
export function installService(spec: ServiceSpec, o: ServiceOptions): ServiceResult {
  const dir = o.dir ?? defaultServiceDir(o.platform, o.home);
  const file = join(dir, serviceFileName(o.platform));
  const run = o.run ?? runSync;
  const text = o.platform === 'darwin' ? renderPlist(spec) : renderUnit(spec);
  const problems = serviceProblems(o.platform, text, spec);
  const result: ServiceResult = { file, written: false, removed: false, problems, commands: [], loaded: false };
  if (problems.length > 0) return result;
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  writeFileSync(file, text, { mode: 0o644 });
  result.written = true;
  if (o.platform === 'darwin') {
    const plutil = o.plutil === undefined ? (existsSync('/usr/bin/plutil') ? '/usr/bin/plutil' : null) : o.plutil;
    if (plutil !== null) {
      const v = run(plutil, ['-lint', file]);
      if (v.status !== 0) problems.push(`plutil -lint: ${(v.stdout + v.stderr).trim() || v.error || `exit ${String(v.status)}`}`);
    }
  } else if (o.analyze !== null && o.analyze !== undefined) {
    const v = run(o.analyze, ['--user', 'verify', file]);
    if (v.status !== 0) problems.push(`systemd-analyze verify: ${(v.stdout + v.stderr).trim() || v.error || `exit ${String(v.status)}`}`);
  }
  const commands = loadCommands(o, file);
  result.commands = commands;
  if (problems.length > 0 || !o.load) return result;
  const loader = loaderOf(o, dir);
  for (const args of commands) {
    const r = run(loader, args);
    if (r.status !== 0) {
      problems.push(`${loader} ${args.join(' ')}: ${(r.stderr || r.stdout).trim() || r.error || `exit ${String(r.status)}`}`);
      return result;
    }
  }
  result.loaded = true;
  return result;
}

/** Unloads (unless `load` is off) and removes the service file. */
export function uninstallService(o: ServiceOptions): ServiceResult {
  const dir = o.dir ?? defaultServiceDir(o.platform, o.home);
  const file = join(dir, serviceFileName(o.platform));
  const run = o.run ?? runSync;
  const result: ServiceResult = { file, written: false, removed: false, problems: [], commands: unloadCommands(o), loaded: false };
  if (o.load) {
    const loader = loaderOf(o, dir);
    for (const args of result.commands) {
      const r = run(loader, args);
      // Not loaded is fine: the file still goes.
      if (r.status !== 0) result.problems.push(`${loader} ${args.join(' ')}: ${(r.stderr || r.stdout).trim() || r.error || `exit ${String(r.status)}`}`);
    }
  }
  if (existsSync(file)) {
    rmSync(file);
    result.removed = true;
  }
  if (o.load && o.platform === 'linux') run(loaderOf(o, dir), ['--user', 'daemon-reload']);
  return result;
}

/** Whether the service file is in place (status only reads it). */
export function serviceInstalled(platform: ServicePlatform, dir?: string, home?: string): { file: string; installed: boolean; dryRun: boolean | null } {
  const file = join(dir ?? defaultServiceDir(platform, home), serviceFileName(platform));
  if (!existsSync(file)) return { file, installed: false, dryRun: null };
  const text = readFileSync(file, 'utf8');
  return { file, installed: true, dryRun: text.includes('--dry-run') };
}
