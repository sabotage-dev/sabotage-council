-- 005_auto_ledger: P8, the auto daemon (plan 9.4). 001 created the ledger with one row per (repo, PR, head); the
-- daemon also records:
--
-- - claim_owner: the claim's owner as JSON (host, pid, token). claim_pid, claim_started and heartbeat_at (001) stay
--   the claim's pid, start and heartbeat: a claim whose process is gone (same host) or whose heartbeat is stale (a
--   reused pid, another host) is free. Every write a claimed row makes checks the token, so a claim taken over fences
--   its first owner.
-- - event, review_sha256: the event the row means to post and the review sha256 (the event and the body) its dry run
--   rendered, recorded with records_sha (001) before the POST; a resume posts only that review.
-- - dry_run: the row belongs to an `auto --dry-run` pass, whose rounds can render but never post.
-- - reason: why a row is failed, skipped, held or superseded, in plain words.
-- - created_at, checked_at: when the row was first written, and when a pass last read its PR's state (the prune
--   reads closed PRs a bounded number per pass, oldest check first).
-- - auto_state: the daemon's own settings that are not config (paused or not, and why).
--
-- The ledger states are validated by the engine (001's convention): running, posting, posted, approved, failed,
-- needs-ruling, superseded, skipped, retired, and rendered (a dry-run row that rendered its review).

ALTER TABLE ledger ADD COLUMN claim_owner TEXT;
ALTER TABLE ledger ADD COLUMN event TEXT CHECK (event IS NULL OR event IN ('APPROVE', 'REQUEST_CHANGES', 'COMMENT'));
ALTER TABLE ledger ADD COLUMN review_sha256 TEXT CHECK (review_sha256 IS NULL OR (length(review_sha256) = 64 AND review_sha256 NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE ledger ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1));
ALTER TABLE ledger ADD COLUMN reason TEXT;
ALTER TABLE ledger ADD COLUMN created_at TEXT;
ALTER TABLE ledger ADD COLUMN checked_at TEXT;
CREATE INDEX ledger_pr ON ledger (repo, num);

CREATE TABLE auto_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
