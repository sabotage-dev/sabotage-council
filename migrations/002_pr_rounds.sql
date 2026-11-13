-- 002_pr_rounds: what P6's pr rounds record beside plan 8.1's rounds columns (event_posted, review_id).
--
-- - kind: a council round (seats, adjudication) or an identity approval (plan 3.10: no seats).
-- - marker: the first line the review body carries (plan 3.6, 3.10): written at round start, so a resumed post finds
--   its own review by it (plan 9.4).
-- - dry_run: the round was started with --dry-run; it can render its post but never post.
-- - posted_commit_id, posted_at, posted_body_sha256: the head the review was posted on (its commit_id), when, and the
--   sha256 of the exact body posted. A dismissal of our own review is an event.

ALTER TABLE rounds ADD COLUMN kind TEXT NOT NULL DEFAULT 'council' CHECK (kind IN ('council', 'identity'));
ALTER TABLE rounds ADD COLUMN marker TEXT;
ALTER TABLE rounds ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0 CHECK (dry_run IN (0, 1));
ALTER TABLE rounds ADD COLUMN posted_commit_id TEXT CHECK (posted_commit_id IS NULL OR (length(posted_commit_id) IN (40, 64) AND posted_commit_id NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE rounds ADD COLUMN posted_at TEXT;
ALTER TABLE rounds ADD COLUMN posted_body_sha256 TEXT CHECK (posted_body_sha256 IS NULL OR (length(posted_body_sha256) = 64 AND posted_body_sha256 NOT GLOB '*[^0-9a-f]*'));
CREATE INDEX rounds_review ON rounds (review_id) WHERE review_id IS NOT NULL;
