CREATE VIEW stg_t3_subagent_history AS
SELECT natural_key AS id,
       payload ->> '$.thread_id' AS thread_id,
       payload ->> '$.child_thread_id' AS child_thread_id,
       payload ->> '$.provider' AS provider,
       payload ->> '$.origin' AS origin,
       payload ->> '$.status' AS status,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.started_at') AS started_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.completed_at') AS completed_at,
       valid_from,
       valid_to
FROM staging_record WHERE source='t3.subagent';

CREATE TABLE stg_t3_subagent AS SELECT * FROM stg_t3_subagent_history WHERE valid_to IS NULL;
