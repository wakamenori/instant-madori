ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'instruction'
  CONSTRAINT messages_kind CHECK (kind IN ('instruction', 'answer', 'explanation', 'question', 'notice'));
ALTER TABLE messages ADD COLUMN job_id TEXT
  CONSTRAINT messages_kind_job CHECK (
    (kind IN ('instruction', 'answer') AND job_id IS NULL)
    OR (kind IN ('explanation', 'question') AND job_id IS NOT NULL)
    OR kind = 'notice');
ALTER TABLE messages ADD COLUMN choices TEXT
  CONSTRAINT messages_choices CHECK ((kind = 'question') = (choices IS NOT NULL)
    AND (choices IS NULL OR CASE WHEN json_valid(choices)
      THEN json_type(choices) = 'array' AND length(CAST(choices AS BLOB)) <= 16384 ELSE 0 END));
ALTER TABLE jobs ADD COLUMN pattern_job TEXT GENERATED ALWAYS AS (pattern_id || '/' || id) VIRTUAL;
CREATE UNIQUE INDEX jobs_pattern_job ON jobs (pattern_job);
ALTER TABLE messages ADD COLUMN pattern_job TEXT
  GENERATED ALWAYS AS (pattern_id || '/' || job_id) VIRTUAL REFERENCES jobs (pattern_job);
CREATE INDEX messages_inputs ON messages (pattern_id, number) WHERE kind IN ('instruction', 'answer');
