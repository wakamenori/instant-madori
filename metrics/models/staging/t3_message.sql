CREATE VIEW stg_t3_message AS
SELECT natural_key AS id,
       payload ->> '$.thread_id' AS thread_id,
       payload ->> '$.role' AS role,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.created_at') AS created_at,
       payload ->> '$.created_by' AS created_by,
       payload ->> '$.creation_source' AS creation_source,
       payload ->> '$.sender_thread_id' AS sender_thread_id,
       payload ->> '$.notification_kind' AS notification_kind,
       payload ->> '$.notification_outcome' AS notification_outcome,
       payload ->> '$.verdict' AS verdict,
       payload ->> '$.text_length' AS text_length,
       valid_from,
       valid_to
FROM staging_record WHERE source='t3.message' AND valid_to IS NULL;
