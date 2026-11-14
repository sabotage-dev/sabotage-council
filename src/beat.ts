/*
 * Beats across synchronous work (P8 round 2 row 2). The engine reads GitHub and git synchronously (`gh api`, `git
 * fetch`, the root build, all through spawnSync), and a synchronous call holds the event loop, so no timer fires while
 * it runs. The auto daemon's pass lock and ledger claim have to stay fresh across that work: a pass registers a beat
 * here, and every git, gh and tar process the engine starts calls `syncBeat()` before and after it runs. The beat is
 * the registrant's to throttle; it never throws into the work it beats for.
 */

const beats = new Set<() => void>();

/** Registers a beat; the returned function removes it. */
export function onSyncBeat(fn: () => void): () => void {
  beats.add(fn);
  return () => {
    beats.delete(fn);
  };
}

/** Runs every registered beat: called by the engine before and after each git, gh and tar process it starts. */
export function syncBeat(): void {
  for (const fn of beats) {
    try {
      fn();
    } catch {
      // A beat that failed once is tried again at the next process; the work it beats for goes on.
    }
  }
}
