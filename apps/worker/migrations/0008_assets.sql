CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  object_key TEXT NOT NULL UNIQUE,
  media_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 1),
  width INTEGER NOT NULL CHECK (width >= 1),
  height INTEGER NOT NULL CHECK (height >= 1),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE (id, owner_id)
) STRICT;
