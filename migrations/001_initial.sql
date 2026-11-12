-- 001_initial: the run store's core tables (plan section 8.1).
--
-- Conventions:
-- - Times are ISO-8601 UTC text. Booleans are 0/1 integers. *_json columns hold JSON text (json_valid).
-- - CHECK constraints pin the closed vocabularies of the behaviour spec (verdicts, severities, outcomes, roles).
--   Vocabularies a later phase may extend (backends, transports, failure classes, enforcement labels, leg
--   statuses, ledger states) are validated by the engine instead, because SQLite cannot alter a CHECK
--   constraint without rebuilding the table.
-- - The migration runner wraps this file in a transaction; do not put PRAGMA or BEGIN/COMMIT here.

-- What is reviewed. Round numbers belong to the target (3.6): pr by repo + number, plan by repo + path,
-- diff by repo + branch.
CREATE TABLE targets (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL CHECK (kind IN ('pr', 'plan', 'diff')),
  repo   TEXT,
  number INTEGER CHECK (number > 0),
  path   TEXT,
  branch TEXT,
  CHECK (kind <> 'pr' OR (repo IS NOT NULL AND number IS NOT NULL)),
  CHECK (kind <> 'plan' OR path IS NOT NULL),
  CHECK (kind <> 'diff' OR (repo IS NOT NULL AND branch IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX targets_pr_key ON targets (repo, number) WHERE kind = 'pr';
CREATE UNIQUE INDEX targets_plan_key ON targets (coalesce(repo, ''), path) WHERE kind = 'plan';
CREATE UNIQUE INDEX targets_diff_key ON targets (repo, branch) WHERE kind = 'diff';

-- One row per distinct occupant ever seated (backend + model + effort + transport).
CREATE TABLE occupants (
  id        INTEGER PRIMARY KEY,
  backend   TEXT NOT NULL,
  model     TEXT NOT NULL,
  effort    TEXT,
  transport TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX occupants_key ON occupants (backend, model, coalesce(effort, ''), transport);

CREATE TABLE rounds (
  id                         INTEGER PRIMARY KEY,
  target_id                  INTEGER NOT NULL REFERENCES targets (id),
  round_no                   INTEGER NOT NULL CHECK (round_no >= 1),
  mode                       TEXT NOT NULL CHECK (mode IN ('plan', 'diff', 'pr', 'auto')),
  head_sha                   TEXT NOT NULL,
  base_sha                   TEXT,
  baseline_sha               TEXT,
  full_round_reason          TEXT,
  nonce                      TEXT,
  roster_json                TEXT NOT NULL CHECK (json_valid(roster_json)),
  started_at                 TEXT NOT NULL,
  finished_at                TEXT,
  verdict                    TEXT CHECK (verdict IN ('SHIP', 'SHIP-WITH-FIXES', 'NEEDS-WORK')),
  owed_count                 INTEGER CHECK (owed_count >= 0),
  approve                    INTEGER CHECK (approve IN (0, 1)),
  needs_ruling               INTEGER NOT NULL DEFAULT 0 CHECK (needs_ruling IN (0, 1)),
  event_posted               TEXT CHECK (event_posted IN ('APPROVE', 'REQUEST_CHANGES', 'COMMENT')),
  review_id                  INTEGER,
  status                     TEXT NOT NULL,
  adjudicator_model_observed TEXT,
  adjudicator_tools_json     TEXT CHECK (json_valid(adjudicator_tools_json)),
  adjudicator_denials_json   TEXT CHECK (json_valid(adjudicator_denials_json)),
  adjudicator_cost_usd       REAL CHECK (adjudicator_cost_usd >= 0),
  adjudicator_turns          INTEGER CHECK (adjudicator_turns >= 0),
  adjudicator_ms             INTEGER CHECK (adjudicator_ms >= 0)
) STRICT;
CREATE INDEX rounds_target ON rounds (target_id, round_no);
CREATE INDEX rounds_started ON rounds (started_at);

-- One launch of one occupant for one round.
CREATE TABLE legs (
  id                 INTEGER PRIMARY KEY,
  round_id           INTEGER NOT NULL REFERENCES rounds (id),
  seat_id            TEXT NOT NULL,
  occupant_id        INTEGER NOT NULL REFERENCES occupants (id),
  attempt            INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  role               TEXT NOT NULL CHECK (role IN ('primary', 'fallback')),
  enforcement_label  TEXT,
  cli_version        TEXT,
  status             TEXT NOT NULL,
  failure_class      TEXT,
  verdict_raw        TEXT CHECK (verdict_raw IN ('SHIP', 'SHIP-WITH-FIXES', 'NEEDS-WORK', 'none')),
  verdict_effective  TEXT CHECK (verdict_effective IN ('SHIP', 'SHIP-WITH-FIXES', 'NEEDS-WORK', 'none')),
  model_observed     TEXT,
  effort_observed    TEXT,
  cwd_ok             INTEGER CHECK (cwd_ok IN (0, 1)),
  tools_used_json    TEXT CHECK (json_valid(tools_used_json)),
  tools_offered_json TEXT CHECK (json_valid(tools_offered_json)),
  root_mutated       INTEGER CHECK (root_mutated IN (0, 1)),
  nonce_seen         INTEGER CHECK (nonce_seen IN (0, 1)),
  started_at         TEXT,
  finished_at        TEXT,
  duration_ms        INTEGER CHECK (duration_ms >= 0),
  tokens_in          INTEGER CHECK (tokens_in >= 0),
  tokens_out         INTEGER CHECK (tokens_out >= 0),
  cost_usd           REAL CHECK (cost_usd >= 0),
  credits            REAL CHECK (credits >= 0),
  quota_used_pct     REAL CHECK (quota_used_pct >= 0),
  quota_note         TEXT,
  record_path        TEXT
) STRICT;
CREATE UNIQUE INDEX legs_attempt ON legs (round_id, seat_id, role, attempt);
CREATE INDEX legs_occupant ON legs (occupant_id);

-- Canonical findings of a round, as the adjudicator wrote them. The id (e.g. C1) is unique within a round.
CREATE TABLE findings (
  round_id      INTEGER NOT NULL REFERENCES rounds (id),
  id            TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'finding' CHECK (kind IN ('finding', 'human_ask')),
  title         TEXT NOT NULL,
  path          TEXT,
  line          INTEGER CHECK (line >= 1),
  severity      TEXT CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW', 'NIT')),
  outcome       TEXT NOT NULL CHECK (outcome IN ('owed', 'follow-up', 'nit', 'refuted', 'ruling', 'noted')),
  owner         TEXT,
  proof_ref     TEXT,
  same_as       TEXT,
  closes_item   TEXT,
  ruling_result TEXT CHECK (ruling_result IN ('upheld', 'overturned')),
  ruled_by      TEXT,
  ruled_at      TEXT,
  PRIMARY KEY (round_id, id)
) STRICT;

-- Findings as each leg raised them (F1, F2, ...), mapped to a canonical finding when the adjudicator did.
CREATE TABLE leg_findings (
  id                INTEGER PRIMARY KEY,
  leg_id            INTEGER NOT NULL REFERENCES legs (id),
  local_id          TEXT NOT NULL,
  severity_raw      TEXT,
  severity          TEXT NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW', 'NIT')),
  path              TEXT,
  line              INTEGER CHECK (line >= 1),
  title             TEXT NOT NULL,
  extracted_by      TEXT NOT NULL CHECK (extracted_by IN ('leg', 'adjudicator')),
  mapped_round_id   INTEGER,
  mapped_finding_id TEXT,
  unmapped_reason   TEXT,
  UNIQUE (leg_id, local_id),
  CHECK ((mapped_round_id IS NULL) = (mapped_finding_id IS NULL)),
  FOREIGN KEY (mapped_round_id, mapped_finding_id) REFERENCES findings (round_id, id)
) STRICT;
CREATE INDEX leg_findings_mapped ON leg_findings (mapped_round_id, mapped_finding_id);

-- Every seat that raised a canonical finding, duplicates included, at its own severity (via leg_findings).
CREATE TABLE finding_sources (
  round_id       INTEGER NOT NULL,
  finding_id     TEXT NOT NULL,
  leg_finding_id INTEGER NOT NULL REFERENCES leg_findings (id),
  PRIMARY KEY (round_id, finding_id, leg_finding_id),
  FOREIGN KEY (round_id, finding_id) REFERENCES findings (round_id, id)
) STRICT;
CREATE INDEX finding_sources_leg_finding ON finding_sources (leg_finding_id);

-- Earlier items carried into a delta round (3.5). A closed item with an unchanged body hash is not re-asked.
CREATE TABLE earlier_items (
  round_id    INTEGER NOT NULL REFERENCES rounds (id),
  source_id   TEXT NOT NULL,
  kind        TEXT,
  status      TEXT NOT NULL CHECK (status IN ('closed', 'half-closed', 'open')),
  evidence    TEXT,
  body_sha256 TEXT CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  PRIMARY KEY (round_id, source_id)
) STRICT;
CREATE INDEX earlier_items_source ON earlier_items (source_id, body_sha256);

-- The auto daemon's ledger: one row per (repo, PR, head) (9.4).
CREATE TABLE ledger (
  repo          TEXT NOT NULL,
  num           INTEGER NOT NULL CHECK (num > 0),
  head          TEXT NOT NULL,
  state         TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claim_pid     INTEGER,
  claim_started TEXT,
  heartbeat_at  TEXT,
  round_id      INTEGER REFERENCES rounds (id),
  round_no      INTEGER CHECK (round_no >= 1),
  records_sha   TEXT,
  review_id     INTEGER,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (repo, num, head)
) STRICT;
CREATE INDEX ledger_state ON ledger (state);
CREATE INDEX ledger_round ON ledger (round_id);

-- Non-blocking items for the follow-ups hook (D11). round_id + finding_id name the canonical finding.
CREATE TABLE followups (
  id          INTEGER PRIMARY KEY,
  target_id   INTEGER NOT NULL REFERENCES targets (id),
  round_id    INTEGER NOT NULL,
  finding_id  TEXT NOT NULL,
  status      TEXT NOT NULL,
  exported_at TEXT,
  hook_rc     INTEGER,
  UNIQUE (round_id, finding_id),
  FOREIGN KEY (round_id, finding_id) REFERENCES findings (round_id, id)
) STRICT;
CREATE INDEX followups_target_status ON followups (target_id, status);

-- Hand credits for unmarked council reviews (3.6), de-duplicated by review id.
CREATE TABLE credits (
  repo         TEXT NOT NULL,
  num          INTEGER NOT NULL CHECK (num > 0),
  review_id    INTEGER NOT NULL,
  commit_id    TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  credited_by  TEXT NOT NULL,
  credited_at  TEXT NOT NULL,
  note         TEXT,
  PRIMARY KEY (repo, num, review_id)
) STRICT;

-- Notifications, holds, rulings, retries.
CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL,
  round_id    INTEGER REFERENCES rounds (id),
  detail_json TEXT CHECK (json_valid(detail_json))
) STRICT;
CREATE INDEX events_round ON events (round_id);
CREATE INDEX events_kind_ts ON events (kind, ts);
