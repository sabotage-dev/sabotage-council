-- 003_post_guards: P6 council round 1 fold. Who is posting a round, what a post still owes, and one key per GitHub
-- repository.
--
-- - post_owner, post_claimed_at: `post --post` claims its round inside one IMMEDIATE transaction before any network
--   call, so two `post` commands on one round never both POST. The owner names its host and pid; a claim whose
--   process is gone, or that is older than an hour, can be taken over (the resume rules of plan 9.4 then apply).
-- - post_guards: the guards a post owes (the approval-race re-check, the dismissal of our own stale change request,
--   the withdrawal of a review GitHub bound to another commit), recorded as pending with the post's intent, marked
--   done when they ran, and resumed by the next `post` after a crash or a failed call. `outcome` says what the run
--   did, or why the last attempt failed.
-- - pr targets and credits are keyed by the lower-case `github.com/<owner>/<repo>`: GitHub resolves repository names
--   case-insensitively, so `Org/Repo#5` and `org/repo#5` are one pull request. Existing rows are normalized, and
--   duplicate pr targets are merged into the oldest (their rounds and follow-ups move with them).

ALTER TABLE rounds ADD COLUMN post_owner TEXT;
ALTER TABLE rounds ADD COLUMN post_claimed_at TEXT;

CREATE TABLE post_guards (
  id         INTEGER PRIMARY KEY,
  round_id   INTEGER NOT NULL REFERENCES rounds (id),
  kind       TEXT NOT NULL CHECK (kind IN ('approval-race', 'dismiss-stale', 'withdraw-off-head')),
  review_id  INTEGER,
  status     TEXT NOT NULL CHECK (status IN ('pending', 'done')),
  attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  outcome    TEXT,
  created_at TEXT NOT NULL,
  done_at    TEXT,
  CHECK (kind = 'approval-race' OR review_id IS NOT NULL),
  CHECK (status = 'pending' OR done_at IS NOT NULL)
) STRICT;
CREATE INDEX post_guards_round ON post_guards (round_id, status);

UPDATE rounds
   SET target_id = (SELECT min(b.id) FROM targets a JOIN targets b ON b.kind = 'pr' AND lower(b.repo) = lower(a.repo) AND b.number = a.number WHERE a.id = rounds.target_id)
 WHERE target_id IN (SELECT id FROM targets WHERE kind = 'pr');
UPDATE followups
   SET target_id = (SELECT min(b.id) FROM targets a JOIN targets b ON b.kind = 'pr' AND lower(b.repo) = lower(a.repo) AND b.number = a.number WHERE a.id = followups.target_id)
 WHERE target_id IN (SELECT id FROM targets WHERE kind = 'pr');
DELETE FROM targets WHERE kind = 'pr' AND id NOT IN (SELECT min(id) FROM targets WHERE kind = 'pr' GROUP BY lower(repo), number);
UPDATE targets SET repo = lower(repo) WHERE kind = 'pr';
UPDATE OR IGNORE credits SET repo = lower(repo);
DELETE FROM credits WHERE repo <> lower(repo);
