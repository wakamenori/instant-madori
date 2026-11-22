CREATE VIEW stg_github_pr_history AS
SELECT natural_key AS id,
       payload ->> '$.number' AS number,
       payload ->> '$.state' AS state,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.created_at') AS created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.closed_at') AS closed_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.merged_at') AS merged_at,
       payload ->> '$.head_ref' AS head_ref,
       payload ->> '$.head_sha' AS head_sha,
       payload ->> '$.base_ref' AS base_ref,
       payload ->> '$.merge_commit_sha' AS merge_commit_sha,
       payload ->> '$.additions' AS additions,
       payload ->> '$.deletions' AS deletions,
       payload ->> '$.changed_files' AS changed_files,
       payload ->> '$.labels' AS labels,
       payload ->> '$.closes' AS closes,
       payload ->> '$.mergeable_state' AS mergeable_state,
       payload->>'$.creator_type' creator_type, payload->>'$.files' files, payload->>'$.files_complete' files_complete,
       valid_from,
       valid_to
FROM staging_record WHERE source='github.pr';

CREATE TABLE stg_github_pr AS SELECT * FROM stg_github_pr_history WHERE valid_to IS NULL;

CREATE VIEW stg_github_pr_file AS
SELECT p.number pr,f.value->>'$.filename' filename,f.value->>'$.previous_filename' previous_filename,
       f.value->>'$.status' status FROM stg_github_pr p,json_each(p.files) f;
