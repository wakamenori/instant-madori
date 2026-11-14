CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  body TEXT NOT NULL CHECK (
    length(CAST(body AS BLOB)) BETWEEN 1 AND 16384
    AND trim(body, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194,
      8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287,
      12288, 65279)) <> ''
  ),
  created_at TEXT NOT NULL,
  UNIQUE (pattern_id, number),
  UNIQUE (id, pattern_id),
  FOREIGN KEY (pattern_id, owner_id) REFERENCES patterns (id, owner_id)
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'validating', 'committing', 'completed',
    'awaiting_answer', 'cancelled', 'failed', 'limited'
  )),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  base_revision_id TEXT,
  base_is_null INTEGER GENERATED ALWAYS AS (base_revision_id IS NULL) VIRTUAL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, pattern_id),
  UNIQUE (id, base_revision_id),
  UNIQUE (id, base_is_null),
  FOREIGN KEY (pattern_id, owner_id) REFERENCES patterns (id, owner_id),
  FOREIGN KEY (message_id, pattern_id) REFERENCES messages (id, pattern_id),
  FOREIGN KEY (base_revision_id, pattern_id) REFERENCES revisions (id, pattern_id)
) STRICT;

CREATE UNIQUE INDEX jobs_one_active_per_pattern ON jobs (pattern_id)
  WHERE state IN ('running', 'validating', 'committing');
CREATE INDEX jobs_queue ON jobs (pattern_id, state);

CREATE TABLE revisions_new (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  snapshot_id TEXT NOT NULL,
  base_revision_id TEXT,
  base_is_null INTEGER GENERATED ALWAYS AS (base_revision_id IS NULL) VIRTUAL,
  created_at TEXT NOT NULL,
  job_id TEXT,
  conversation_number INTEGER CHECK (conversation_number >= 1),
  UNIQUE (pattern_id, number),
  UNIQUE (id, pattern_id),
  FOREIGN KEY (pattern_id, owner_id) REFERENCES patterns (id, owner_id),
  FOREIGN KEY (snapshot_id, owner_id) REFERENCES snapshots (id, owner_id),
  FOREIGN KEY (base_revision_id, pattern_id) REFERENCES revisions_new (id, pattern_id),
  FOREIGN KEY (job_id, pattern_id) REFERENCES jobs (id, pattern_id),
  FOREIGN KEY (job_id, base_revision_id) REFERENCES jobs (id, base_revision_id),
  FOREIGN KEY (job_id, base_is_null) REFERENCES jobs (id, base_is_null),
  FOREIGN KEY (pattern_id, conversation_number) REFERENCES messages (pattern_id, number)
) STRICT;

INSERT INTO revisions_new
  (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at)
  SELECT id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at
  FROM revisions;
DROP TABLE revisions;
ALTER TABLE revisions_new RENAME TO revisions;
CREATE UNIQUE INDEX revisions_by_job ON revisions (job_id) WHERE job_id IS NOT NULL;
