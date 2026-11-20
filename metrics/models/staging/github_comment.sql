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
