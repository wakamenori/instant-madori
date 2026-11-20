CREATE VIEW stg_t3_run_history AS
SELECT natural_key AS id,
       payload ->> '$.thread_id' AS thread_id,
       payload ->> '$.ordinal' AS ordinal,
       payload ->> '$.status' AS status,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.requested_at') AS requested_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.started_at') AS started_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.completed_at') AS completed_at,
       payload ->> '$.user_message_id' AS user_message_id,
       valid_from,
       valid_to
FROM staging_record WHERE source='t3.run';

CREATE TABLE stg_t3_run AS SELECT * FROM stg_t3_run_history WHERE valid_to IS NULL;
