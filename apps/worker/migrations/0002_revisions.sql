-- A snapshot fixes immutable R2 content. A revision places that content in a
-- pattern's history. Version 1 contains display data only (plan 6.1b, unit 4).
CREATE UNIQUE INDEX patterns_id_owner ON patterns (id, owner_id);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  format_version INTEGER NOT NULL CHECK (format_version = 1),
  manifest_key TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (id, owner_id)
) STRICT;

-- Current means the greatest number, so no mutable current-revision pointer is
-- needed. The base must belong to this pattern, including during a concurrent commit.
CREATE TABLE revisions (
  id TEXT PRIMARY KEY,
  pattern_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  snapshot_id TEXT NOT NULL,
  base_revision_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (pattern_id, number),
  UNIQUE (id, pattern_id),
  FOREIGN KEY (pattern_id, owner_id) REFERENCES patterns (id, owner_id),
  FOREIGN KEY (snapshot_id, owner_id) REFERENCES snapshots (id, owner_id),
  FOREIGN KEY (base_revision_id, pattern_id) REFERENCES revisions (id, pattern_id)
) STRICT;
