CREATE VIEW stg_actions_attempt_history AS
SELECT payload->>'$.run_id' run_id,payload->>'$.run_attempt' run_attempt,payload->>'$.workflow' workflow,
       payload->>'$.head_sha' head_sha,payload->>'$.status' status,payload->>'$.conclusion' conclusion,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.created_at') created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.started_at') started_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.updated_at') updated_at, valid_from,valid_to
FROM staging_record WHERE source='github.actions.attempt';
CREATE VIEW stg_actions_attempt AS SELECT * FROM stg_actions_attempt_history WHERE valid_to IS NULL;
