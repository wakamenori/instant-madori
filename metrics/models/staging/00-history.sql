CREATE TABLE staging_record AS
SELECT source, natural_key, ingest_id, payload, observed_at AS valid_from,
       lead(observed_at) OVER (PARTITION BY source,natural_key ORDER BY ingest_id) AS valid_to
FROM raw.l1_record;

CREATE INDEX staging_latest ON staging_record(source,valid_to,natural_key);
