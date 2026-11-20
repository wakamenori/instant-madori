CREATE VIEW stg_actions_job_history AS
SELECT natural_key AS id,
       payload ->> '$.run_id' AS run_id,
       payload ->> '$.run_attempt' AS run_attempt,
       payload ->> '$.workflow' AS workflow,
       payload ->> '$.event' AS event,
       payload ->> '$.head_sha' AS head_sha,
       payload ->> '$.head_branch' AS head_branch,
       payload ->> '$.pr_numbers' AS pr_numbers,
       payload ->> '$.status' AS status,
       payload ->> '$.conclusion' AS conclusion,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.created_at') AS created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.started_at') AS started_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.completed_at') AS completed_at,
       payload ->> '$.runner_name' AS runner_name,
       payload ->> '$.steps' AS steps,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.run_created_at') AS run_created_at,
       payload ->> '$.run_conclusion' AS run_conclusion,
       valid_from,
       valid_to
FROM staging_record WHERE source='github.actions.job';

CREATE TABLE stg_actions_job AS SELECT * FROM stg_actions_job_history WHERE valid_to IS NULL;
