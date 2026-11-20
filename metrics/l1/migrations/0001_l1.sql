CREATE TABLE l1_source (
  source        TEXT PRIMARY KEY
                CHECK (source GLOB '[a-z]*' AND source NOT GLOB '*[^a-z0-9._-]*'),
  -- event: arrives once, appended as received (OTel, hook, the receiver's heartbeat).
  -- observation: polled state, appended only when it differs from the entity's latest observation.
  kind          TEXT NOT NULL CHECK (kind IN ('event', 'observation')),
  registered_at TEXT NOT NULL
                CHECK (registered_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  UNIQUE (source, kind)
) STRICT;

CREATE TRIGGER l1_source_no_update BEFORE UPDATE ON l1_source
BEGIN
  SELECT RAISE(ABORT, 'l1_source is append-only');
END;

CREATE TRIGGER l1_source_no_delete BEFORE DELETE ON l1_source
BEGIN
  SELECT RAISE(ABORT, 'l1_source is append-only');
END;

-- L1: every accepted record from every source, in one envelope, append-only.
CREATE TABLE l1_record (
  -- One row per ingestion, in insertion order. The L2 build's incremental cursor.
  ingest_id      INTEGER PRIMARY KEY,
  source         TEXT    NOT NULL,
  -- Copied from l1_source through the foreign key below, so the partial indexes can use it.
  kind           TEXT    NOT NULL,
  source_version TEXT    NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  -- When the receiver received the record. A record held for proof keeps its receive time.
  observed_at    TEXT    NOT NULL
                 CHECK (observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- When the source says it happened. Null when the source does not say.
  occurred_at    TEXT
                 CHECK (occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  natural_key    TEXT    NOT NULL CHECK (length(natural_key) BETWEEN 1 AND 512),
  -- sha256 of the canonical JSON of payload, computed after the source's privacy rule set.
  content_hash   TEXT    NOT NULL
                 CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
  payload        TEXT    NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  -- The observation of the same entity this one follows. Null for events and first observations.
  prev_ingest_id INTEGER REFERENCES l1_record (ingest_id),
  FOREIGN KEY (source, kind) REFERENCES l1_source (source, kind),
  CHECK (kind = 'observation' OR prev_ingest_id IS NULL)
) STRICT;

-- An event's retry or replay (same source, key and content) appends nothing.
CREATE UNIQUE INDEX l1_record_event
  ON l1_record (source, natural_key, content_hash) WHERE kind = 'event';

-- An entity's observations form one chain: one first observation per entity, at most one
-- successor per observation. So a new observation can only extend the latest one, and
-- A -> B -> A keeps the second A, which a (source, natural_key, content_hash) key would refuse.
CREATE UNIQUE INDEX l1_record_chain
  ON l1_record (source, natural_key, ifnull(prev_ingest_id, 0)) WHERE kind = 'observation';

-- The latest observation of an entity, and per-entity scans in L2.
CREATE INDEX l1_record_key ON l1_record (source, natural_key, ingest_id);

-- Health: last arrival and recent volume per source.
CREATE INDEX l1_record_arrival ON l1_record (source, observed_at);

CREATE TRIGGER l1_record_no_update BEFORE UPDATE ON l1_record
BEGIN
  SELECT RAISE(ABORT, 'l1_record is append-only');
END;

CREATE TRIGGER l1_record_no_delete BEFORE DELETE ON l1_record
BEGIN
  SELECT RAISE(ABORT, 'l1_record is append-only');
END;

-- An observation records a change of the same entity.
CREATE TRIGGER l1_record_observation_changes BEFORE INSERT ON l1_record
WHEN NEW.kind = 'observation' AND NEW.prev_ingest_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'an observation must change the observation it follows')
  WHERE NOT EXISTS (
    SELECT 1 FROM l1_record AS prev
    WHERE prev.ingest_id = NEW.prev_ingest_id
      AND prev.kind = 'observation'
      AND prev.source = NEW.source
      AND prev.natural_key = NEW.natural_key
      AND prev.content_hash <> NEW.content_hash
  );
END;

-- L1 quarantine: transport units that failed envelope validation (README rule 5).
-- content holds the unit after the source's rule set only when an allow-list rule set could be
-- applied to it, and is null otherwise, so nothing unscrubbed or unattributed is stored.
CREATE TABLE l1_quarantine (
  quarantine_id INTEGER PRIMARY KEY,
  source        TEXT NOT NULL REFERENCES l1_source (source),
  observed_at   TEXT NOT NULL
                CHECK (observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  -- Validation paths and codes, never received values.
  reason        TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 2000),
  -- sha256 of the raw unit (spool file bytes, OTLP request body). A replayed spool file or a
  -- retried request is quarantined once; two different bad units are both kept.
  unit_hash     TEXT NOT NULL CHECK (length(unit_hash) = 64 AND unit_hash NOT GLOB '*[^0-9a-f]*'),
  content       TEXT CHECK (content IS NULL OR (json_valid(content) AND json_type(content) = 'object')),
  UNIQUE (source, unit_hash)
) STRICT;

CREATE INDEX l1_quarantine_arrival ON l1_quarantine (source, observed_at);

CREATE TRIGGER l1_quarantine_no_update BEFORE UPDATE ON l1_quarantine
BEGIN
  SELECT RAISE(ABORT, 'l1_quarantine is append-only');
END;

CREATE TRIGGER l1_quarantine_no_delete BEFORE DELETE ON l1_quarantine
BEGIN
  SELECT RAISE(ABORT, 'l1_quarantine is append-only');
END;

-- Receiver state, not L1. Subjects proven to belong to this repository (a Claude session through
-- any of its hook records; later a Codex conversation through a T3 observation), with the L1 row
-- that proved it. L2 rebuilds the same facts from those L1 rows. Never revoked.
CREATE TABLE admission (
  subject         TEXT    PRIMARY KEY CHECK (subject GLOB '?*:?*'),
  proof_ingest_id INTEGER NOT NULL REFERENCES l1_record (ingest_id),
  admitted_at     TEXT    NOT NULL
                  CHECK (admitted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')
) STRICT, WITHOUT ROWID;

CREATE TRIGGER admission_no_update BEFORE UPDATE ON admission
BEGIN
  SELECT RAISE(ABORT, 'admission is append-only');
END;

CREATE TRIGGER admission_no_delete BEFORE DELETE ON admission
BEGIN
  SELECT RAISE(ABORT, 'admission is append-only');
END;

-- Receiver state, not L1. Records whose subject is not admitted yet, already scrubbed and hashed.
-- A row leaves by promotion into l1_record when its subject is admitted (keeping observed_at), or
-- by expiry after the hold TTL. Other projects' records end here and expire, so they never reach
-- L1. Only event sources can be held: kind is pinned to 'event' and checked against l1_source.
CREATE TABLE held_record (
  held_id        INTEGER PRIMARY KEY,
  subject        TEXT NOT NULL CHECK (subject GLOB '?*:?*'),
  source         TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'event' CHECK (kind = 'event'),
  source_version TEXT NOT NULL,
  observed_at    TEXT NOT NULL
                 CHECK (observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  occurred_at    TEXT
                 CHECK (occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  natural_key    TEXT NOT NULL,
  content_hash   TEXT NOT NULL CHECK (length(content_hash) = 64),
  payload        TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  FOREIGN KEY (source, kind) REFERENCES l1_source (source, kind),
  UNIQUE (source, natural_key, content_hash)
) STRICT;

CREATE INDEX held_record_subject ON held_record (subject, held_id);
CREATE INDEX held_record_arrival ON held_record (observed_at);

-- Health per registered source over the last 24 hours. Every input is an L1 row except held_now,
-- so the L4 health mart can replace this view with the same query over L1 alone.
-- The receiver's heartbeat (source metrics.receiver, written every minute) carries what L1 rows
-- cannot show: per-source last batch time (a poll that changed nothing appends no row), records
-- dropped before L1, and held records that expired. The field names below are the
-- HeartbeatTally type in metrics/receiver/receiver.ts; store.test.ts pins the two together.
CREATE VIEW health_source AS
WITH
  since AS (
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day') AS t
  ),
  arrivals AS (
    SELECT source, max(observed_at) AS last_observed_at, max(occurred_at) AS last_occurred_at
    FROM l1_record
    GROUP BY source
  ),
  recent AS (
    SELECT
      source,
      count(*) AS records_24h,
      avg((julianday(observed_at) - julianday(occurred_at)) * 86400.0) AS mean_lag_s_24h,
      max((julianday(observed_at) - julianday(occurred_at)) * 86400.0) AS max_lag_s_24h
    FROM l1_record
    WHERE observed_at >= (SELECT t FROM since)
    GROUP BY source
  ),
  quarantined AS (
    SELECT source, count(*) AS quarantined_24h
    FROM l1_quarantine
    WHERE observed_at >= (SELECT t FROM since)
    GROUP BY source
  ),
  held AS (
    SELECT source, count(*) AS held_now, min(observed_at) AS oldest_held_at
    FROM held_record
    GROUP BY source
  ),
  reported AS (
    SELECT
      tally.key AS source,
      max(json_extract(tally.value, '$.last_batch_at')) AS last_batch_at,
      sum(json_extract(tally.value, '$.dropped_foreign')) AS dropped_foreign_24h,
      sum(json_extract(tally.value, '$.dropped_unattributed')) AS dropped_unattributed_24h,
      sum(json_extract(tally.value, '$.dropped_unknown_service')) AS dropped_unknown_service_24h,
      sum(json_extract(tally.value, '$.expired')) AS expired_24h
    FROM l1_record AS beat, json_each(beat.payload, '$.sources') AS tally
    WHERE beat.source = 'metrics.receiver' AND beat.observed_at >= (SELECT t FROM since)
    GROUP BY tally.key
  )
SELECT
  l1_source.source,
  l1_source.kind,
  -- Event sources succeed when a record arrives; pollers when a batch completes.
  max(
    coalesce(reported.last_batch_at, arrivals.last_observed_at),
    coalesce(arrivals.last_observed_at, reported.last_batch_at)
  ) AS last_success_at,
  arrivals.last_observed_at,
  arrivals.last_occurred_at,
  ifnull(recent.records_24h, 0) AS records_24h,
  recent.mean_lag_s_24h,
  recent.max_lag_s_24h,
  ifnull(quarantined.quarantined_24h, 0) AS quarantined_24h,
  ifnull(reported.dropped_foreign_24h, 0) AS dropped_foreign_24h,
  ifnull(reported.dropped_unattributed_24h, 0) AS dropped_unattributed_24h,
  ifnull(reported.dropped_unknown_service_24h, 0) AS dropped_unknown_service_24h,
  ifnull(reported.expired_24h, 0) AS expired_24h,
  ifnull(held.held_now, 0) AS held_now,
  held.oldest_held_at
FROM l1_source
LEFT JOIN arrivals USING (source)
LEFT JOIN recent USING (source)
LEFT JOIN quarantined USING (source)
LEFT JOIN held USING (source)
LEFT JOIN reported USING (source);
