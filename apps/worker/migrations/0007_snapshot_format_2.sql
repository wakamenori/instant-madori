-- SQLite cannot change a CHECK. Dropping snapshots counts each referencing revision as
-- a deferred foreign key violation. Hold the rows aside and reinsert under the original
-- name to clear those violations. Renaming a populated replacement fails at commit.
PRAGMA defer_foreign_keys = on;
CREATE TABLE snapshots_v1 AS SELECT * FROM snapshots;
DROP TABLE snapshots;
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  format_version INTEGER NOT NULL CONSTRAINT snapshots_format_version CHECK (format_version IN (1, 2)),
  manifest_key TEXT NOT NULL UNIQUE,
  manifest_sha256 TEXT NOT NULL CHECK (
    length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE (id, owner_id)
) STRICT;
INSERT INTO snapshots (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
  SELECT id, owner_id, format_version, manifest_key, manifest_sha256, created_at FROM snapshots_v1;
DROP TABLE snapshots_v1;
