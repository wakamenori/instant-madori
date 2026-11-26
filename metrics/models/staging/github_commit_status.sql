CREATE VIEW stg_github_commit_status AS
SELECT natural_key id,payload->>'$.pr' pr,payload->>'$.sha' sha,payload->>'$.context' context,
       payload->>'$.state' state,payload->>'$.description' description,payload->>'$.attempt' attempt,
       payload->>'$.verdict' verdict,payload->>'$.failed_checks' failed_checks,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.created_at') created_at
FROM staging_record WHERE source='github.commit_status' AND valid_to IS NULL;
