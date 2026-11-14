-- 004_adjudicator_record: P7, the headless adjudicator (plan 6.4). 001's rounds row already holds the adjudicator's
-- observed model, tools, permission denials, cost, turns and duration; a headless run also records:
--
-- - adjudicator_effort_observed: the effort of its API requests, from the transcript (the pin is ratified per request);
-- - adjudicator_record_path: the transcript of its last launch, the record its reads and edits were judged from.

ALTER TABLE rounds ADD COLUMN adjudicator_effort_observed TEXT;
ALTER TABLE rounds ADD COLUMN adjudicator_record_path TEXT;
