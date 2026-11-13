-- Users, projects, patterns and request records for the first service slice
-- (plan 4.3, 4.4, 4.7). Timestamps are ISO 8601 UTC strings written by the Worker.
-- D1 enforces foreign keys, so the composite keys below are checked on every write.

-- Internal users, keyed by the verified Access identity (issuer + subject).
-- The email is display data and may change; it is never used as the key.
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  access_issuer TEXT NOT NULL,
  access_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (access_issuer, access_subject)
) STRICT;

-- `version` counts changes to management fields (the name) only. Pattern progress,
-- jobs and revisions use their own conditions so they never conflict with a rename.
-- `next_pattern_number` numbers patterns without gaps or duplicates.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users (id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  version INTEGER NOT NULL CHECK (version >= 1),
  next_pattern_number INTEGER NOT NULL CHECK (next_pattern_number >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, owner_id)
) STRICT;

-- Newest first, with the ID as the tie-breaker for keyset pagination.
CREATE INDEX projects_by_owner ON projects (owner_id, created_at DESC, id DESC);

-- owner_id is repeated so public reads filter on it directly; the composite foreign key
-- guarantees it always equals the owner of the parent project. `number` is the creation
-- order within the project (taken from next_pattern_number); lists and default names use it,
-- because timestamps can tie.
CREATE TABLE patterns (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, number),
  FOREIGN KEY (project_id, owner_id) REFERENCES projects (id, owner_id)
) STRICT;

-- The first successful result of each mutating API request. A resend with the same
-- request ID and the same operation returns `result` instead of applying the change
-- again; failed attempts are not recorded and may be retried with the same ID.
-- Retention is decided together with data collection (plan 5.4).
CREATE TABLE requests (
  owner_id TEXT NOT NULL REFERENCES users (id),
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  result TEXT NOT NULL CHECK (json_valid(result)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, request_id)
) STRICT;
