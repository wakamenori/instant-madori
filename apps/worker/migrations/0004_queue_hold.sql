ALTER TABLE jobs ADD COLUMN holds_queue INTEGER NOT NULL DEFAULT 0
  CONSTRAINT jobs_queue_hold_state CHECK (holds_queue IN (0, 1)
    AND (holds_queue = 0 OR state IN ('cancelled', 'failed', 'limited', 'awaiting_answer')));
CREATE UNIQUE INDEX jobs_one_queue_hold_per_pattern ON jobs (pattern_id) WHERE holds_queue = 1;
