CREATE VIEW stg_t3_approval_history AS
SELECT natural_key AS id, payload->>'$.thread_id' AS thread_id,
       payload->>'$.provider_turn_id' AS provider_turn_id, payload->>'$.kind' AS kind,
       payload->>'$.status' AS status, payload->>'$.decision' AS decision,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.created_at') AS requested_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.resolved_at') AS resolved_at, valid_from, valid_to
FROM staging_record WHERE source='t3.approval';

CREATE TABLE stg_t3_approval AS SELECT * FROM stg_t3_approval_history WHERE valid_to IS NULL;
