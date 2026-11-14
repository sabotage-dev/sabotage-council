import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { DatabaseSync } from '../store/sqlite.js';

/*
 * Notifications (plan 9.4): on needs-ruling, failure, approval held and approval dismissed. Delivery goes to
 * `notify.command` (an executable, run without a shell, that receives the event as JSON on stdin), or, when none is
 * set, a built-in desktop notifier (macOS `osascript`, Linux `notify-send`). Each notification has a key; a key that
 * was delivered in the last 24 hours is not delivered again. A delivery that failed is recorded and does not count,
 * so the next occasion tries again. Notifications never carry a token or a nonce: they are built from ledger fields.
 */

export const NOTICE_KINDS = ['needs-ruling', 'failure', 'approval-held', 'approval-dismissed'] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

export const DEDUPE_MS = 24 * 60 * 60 * 1000;

export interface Notice {
  kind: NoticeKind;
  /** What dedupes it: the same key within 24 hours is delivered once. */
  key: string;
  title: string;
  message: string;
  repo: string | null;
  number: number | null;
  head: string | null;
  round_id: number | null;
  url: string | null;
  /** From an `auto --dry-run` pass: nothing was posted. */
  dry_run: boolean;
}

export type Deliver = (notice: Notice) => { ok: boolean; via: string; detail: string };

/** `~/x` to the home directory; anything else as given. */
export function expandHome(path: string, home: string = homedir()): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}

/** `notify.command`: the executable gets the notice as JSON on stdin; exit 0 is a delivery. */
export function commandDeliver(command: string, env: NodeJS.ProcessEnv = process.env): Deliver {
  const bin = expandHome(command, env['HOME'] ?? homedir());
  return (n) => {
    const r = spawnSync(bin, [], { input: `${JSON.stringify(n)}\n`, encoding: 'utf8', timeout: 30_000, env: { PATH: env['PATH'] ?? '/usr/bin:/bin', HOME: env['HOME'] ?? homedir() } });
    if (r.error) return { ok: false, via: 'command', detail: r.error.message };
    if (r.status !== 0) return { ok: false, via: 'command', detail: `exit ${String(r.status)}: ${String(r.stderr).trim().slice(0, 300)}` };
    return { ok: true, via: 'command', detail: 'exit 0' };
  };
}

/** The built-in desktop notifier; text goes in argv, never into a script. */
export function desktopDeliver(platform: NodeJS.Platform = process.platform, run: typeof spawnSync = spawnSync): Deliver {
  return (n) => {
    const text = `${n.message}${n.dry_run ? ' (dry run)' : ''}`;
    const r =
      platform === 'darwin'
        ? run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', n.title, text], { encoding: 'utf8', timeout: 15_000 })
        : run('notify-send', [n.title, text], { encoding: 'utf8', timeout: 15_000 });
    if (r.error) return { ok: false, via: 'desktop', detail: r.error.message };
    if (r.status !== 0) return { ok: false, via: 'desktop', detail: `exit ${String(r.status)}` };
    return { ok: true, via: 'desktop', detail: platform === 'darwin' ? 'osascript' : 'notify-send' };
  };
}

export type NotifyOutcome = 'sent' | 'deduped' | 'failed';

/** Whether this key was delivered within the dedupe window before `nowMs`. */
export function deliveredRecently(db: DatabaseSync, key: string, nowMs: number): boolean {
  const since = new Date(nowMs - DEDUPE_MS).toISOString();
  const row = db.prepare("SELECT 1 FROM events WHERE kind = 'notify' AND ts > ? AND json_extract(detail_json, '$.key') = ? LIMIT 1").get(since, key);
  return row !== undefined;
}

/** Delivers a notice unless its key was delivered in the last 24 hours; records the outcome as an event. */
export function notify(db: DatabaseSync, deliver: Deliver, notice: Notice, nowMs: number = Date.now()): NotifyOutcome {
  if (deliveredRecently(db, notice.key, nowMs)) return 'deduped';
  let r: ReturnType<Deliver>;
  try {
    r = deliver(notice);
  } catch (error) {
    r = { ok: false, via: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
  // Stamped with the pass's clock, which the dedupe window reads.
  db.prepare('INSERT INTO events (ts, kind, round_id, detail_json) VALUES (?, ?, ?, ?)').run(
    new Date(nowMs).toISOString(),
    r.ok ? 'notify' : 'notify-failed',
    notice.round_id,
    JSON.stringify({ key: notice.key, kind: notice.kind, via: r.via, detail: r.detail, title: notice.title, message: notice.message, dry_run: notice.dry_run }),
  );
  return r.ok ? 'sent' : 'failed';
}
