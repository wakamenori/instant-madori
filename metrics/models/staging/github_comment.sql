CREATE VIEW stg_github_comment AS
SELECT natural_key AS id,
       payload ->> '$.issue_or_pr' AS issue_or_pr,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.created_at') AS created_at,
       payload ->> '$.author' AS author,
       payload ->> '$.markers' AS markers,
       payload ->> '$.body_length' AS body_length,
       valid_from,
       valid_to
FROM staging_record WHERE source='github.comment' AND valid_to IS NULL;

CREATE VIEW stg_github_comment_block_history AS
SELECT r.natural_key AS comment_id, r.ingest_id, r.payload->>'$.issue_or_pr' AS issue_or_pr,
       strftime('%Y-%m-%dT%H:%M:%fZ',r.payload->>'$.created_at') AS created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',r.payload->>'$.updated_at') AS updated_at,
       b.key AS ordinal, b.value AS fields, b.value->>'$.type' type,b.value->>'$.found_at' found_at,
       b.value->>'$.found_by' found_by,b.value->>'$.cause' cause,b.value->>'$.target' target,
       b.value->>'$.plan_change' plan_change,b.value->>'$.head' head,b.value->>'$.attempt' attempt,
       b.value->>'$.verdict' verdict,b.value->>'$.decided_at' decided_at,b.value->>'$.failed_checks' failed_checks,
       b.value->>'$.started_at' started_at,b.value->>'$.ended_at' ended_at,r.valid_from, r.valid_to
FROM staging_record r, json_each(r.payload,'$.fields') b WHERE source='github.comment';
CREATE VIEW stg_github_comment_block AS
SELECT * FROM stg_github_comment_block_history WHERE valid_to IS NULL;
