import { existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { opencodeConfig } from './known.js';

/*
 * The opencode leg's command line, directories and environment (plan 4.2):
 *   - `opencode acp`; the engine is the ACP client (no fs or terminal capability, every permission request judged);
 *   - every leg has its own XDG config, data, state and cache dirs and its own `OPENCODE_DB`, so no background
 *     service or other leg shares its database (the "database is locked" and resume-without-config issues), no
 *     saved account or global config reaches it, and credentials come from provider environment variables only;
 *   - `HOME` is the leg's own empty dir, so no `AGENTS.md` walk reaches the user's home and no `~/.claude` skill
 *     root exists; `PWD` is the root (opencode takes its directory from `PWD`, not the spawn cwd);
 *   - `OPENCODE_DISABLE_{AUTOUPDATE,CLAUDE_CODE,PROJECT_CONFIG}=1`, and the council agent in
 *     `OPENCODE_CONFIG_CONTENT`.
 */

export const OPENCODE_ENV_ALLOW = [
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Provider credentials, passed through by name; values are never read, logged or recorded.
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'DEEPSEEK_API_KEY',
  'TOGETHER_AI_API_KEY',
  'FIREWORKS_API_KEY',
  'CEREBRAS_API_KEY',
  'META_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_API_KEY',
  'AZURE_RESOURCE_NAME',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
] as const;

export const OPENCODE_ENV_SET: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE: '1',
  OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  NO_COLOR: '1',
};

/** The CLI and its own server talk over loopback: a proxy must never see that traffic. */
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/**
 * The council's own install (`~/.sabotage-council/tools/opencode`, npm `--prefix`) when it exists, else `opencode`
 * on PATH.
 */
export function defaultOpencodeBin(env: NodeJS.ProcessEnv): string {
  const home = env['HOME'];
  const bin = home !== undefined && home !== '' ? join(home, '.sabotage-council', 'tools', 'opencode', 'node_modules', '.bin', 'opencode') : null;
  return bin !== null && existsSync(bin) ? bin : 'opencode';
}

export interface OpencodeLegFiles {
  log: string;
  stderr: string;
  process: string;
  dir: string;
  home: string;
  config: string;
  data: string;
  state: string;
  cache: string;
  db: string;
  /** The canary's planted config file (passed in `OPENCODE_CONFIG`). */
  planted: string;
}

export function opencodeLegFiles(legDir: string): OpencodeLegFiles {
  const leg = resolve(legDir);
  const dir = join(leg, 'opencode');
  return {
    log: join(leg, 'updates.jsonl'),
    stderr: join(leg, 'stderr.log'),
    process: join(leg, 'process.json'),
    dir,
    home: join(dir, 'home'),
    config: join(dir, 'config'),
    data: join(dir, 'data'),
    state: join(dir, 'state'),
    cache: join(dir, 'cache'),
    db: join(dir, 'opencode.db'),
    planted: join(dir, 'planted.json'),
  };
}

/**
 * Every place opencode 2.2.7 reads skill definitions from in a leg (its source): `skill/` and `skills/` under each
 * config directory (`config/plugin/skill.ts`; the leg's is `$XDG_CONFIG_HOME/opencode`), `skills/` under
 * `~/.claude` and `~/.agents` (`config/plugin/compatibility.ts`; `.claude` is off with OPENCODE_DISABLE_CLAUDE_CODE,
 * `.agents` has no switch) and the cache URL skills are pulled into (`skill/discovery.ts`). The data dir is
 * listed too, as the owner's ruling names it. Project dirs are not walked (OPENCODE_DISABLE_PROJECT_CONFIG); the
 * root scan covers the root.
 */
export function opencodeSkillDirs(files: OpencodeLegFiles): string[] {
  return [
    join(files.config, 'opencode', 'skill'),
    join(files.config, 'opencode', 'skills'),
    join(files.data, 'opencode', 'skill'),
    join(files.data, 'opencode', 'skills'),
    join(files.cache, 'opencode', 'skills'),
    join(files.home, '.agents', 'skills'),
    join(files.home, '.claude', 'skills'),
    join(files.home, '.config', 'opencode', 'skill'),
    join(files.home, '.config', 'opencode', 'skills'),
  ];
}

/**
 * The entries in the leg's skill locations: every file or link at any depth (stricter than opencode's own scan,
 * which reads `SKILL.md` and top-level `.md` files). Empty means provably no skill definition in the leg.
 */
export function opencodeSkillDefinitions(files: OpencodeLegFiles): string[] {
  const out: string[] = [];
  const visit = (path: string): void => {
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      return;
    }
    if (!stats.isDirectory()) {
      out.push(path);
      return;
    }
    for (const name of readdirSync(path).sort()) visit(join(path, name));
  };
  for (const dir of opencodeSkillDirs(files)) visit(dir);
  return out;
}

export function prepareOpencodeDirs(files: OpencodeLegFiles, planted?: Record<string, unknown>): void {
  for (const d of [files.home, files.config, files.data, files.state, files.cache]) mkdirSync(d, { recursive: true });
  if (planted !== undefined) writeFileSync(files.planted, `${JSON.stringify(planted, null, 2)}\n`);
}

export function opencodeConfigText(): string {
  return JSON.stringify(opencodeConfig());
}

export function opencodeEnv(source: NodeJS.ProcessEnv, files: OpencodeLegFiles, root: string, planted: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of OPENCODE_ENV_ALLOW) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  const userNoProxy = (source['NO_PROXY'] ?? source['no_proxy'] ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const noProxy = [...new Set([...userNoProxy, ...LOOPBACK])].join(',');
  return {
    ...env,
    ...OPENCODE_ENV_SET,
    HOME: files.home,
    PWD: root,
    XDG_CONFIG_HOME: files.config,
    XDG_DATA_HOME: files.data,
    XDG_STATE_HOME: files.state,
    XDG_CACHE_HOME: files.cache,
    OPENCODE_DB: files.db,
    OPENCODE_CONFIG_CONTENT: opencodeConfigText(),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...(planted ? { OPENCODE_CONFIG: files.planted } : {}),
  };
}
