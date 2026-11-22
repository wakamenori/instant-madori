CREATE TABLE ai_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  reserved INTEGER NOT NULL CHECK (reserved > 0),
  estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
  estimated_output_tokens INTEGER NOT NULL CHECK (estimated_output_tokens >= 0),
  reserved_at TEXT NOT NULL
    CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at) IS reserved_at),
  charged INTEGER CHECK (charged >= 0),
  uncached_input_tokens INTEGER CHECK (uncached_input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens >= 0),
  cache_write_5m_tokens INTEGER CHECK (cache_write_5m_tokens >= 0),
  cache_write_1h_tokens INTEGER CHECK (cache_write_1h_tokens >= 0),
  settled_at TEXT CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', settled_at) IS settled_at),
  month TEXT GENERATED ALWAYS AS (substr(reserved_at, 1, 7)) VIRTUAL,
  counted INTEGER GENERATED ALWAYS AS (coalesce(charged, reserved)) VIRTUAL,
  CONSTRAINT ai_attempts_settlement CHECK (
    (charged IS NULL) = (uncached_input_tokens IS NULL)
    AND (charged IS NULL) = (output_tokens IS NULL)
    AND (charged IS NULL) = (cache_read_tokens IS NULL)
    AND (charged IS NULL) = (cache_write_5m_tokens IS NULL)
    AND (charged IS NULL) = (cache_write_1h_tokens IS NULL)
    AND (charged IS NULL) = (settled_at IS NULL))
) STRICT;
CREATE INDEX ai_attempts_by_month ON ai_attempts (month);
CREATE INDEX ai_attempts_by_job ON ai_attempts (job_id);
