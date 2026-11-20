CREATE VIEW stg_github_issue_history AS
SELECT natural_key AS id,
       payload ->> '$.number' AS number,
       payload ->> '$.title' AS title,
       payload ->> '$.state' AS state,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.created_at') AS created_at,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload ->> '$.closed_at') AS closed_at,
       payload ->> '$.milestone' AS milestone,
       payload ->> '$.labels' AS labels,
       payload ->> '$.blocked_by' AS blocked_by,
       valid_from,
       valid_to
FROM staging_record WHERE source='github.issue';

CREATE TABLE stg_github_issue AS SELECT * FROM stg_github_issue_history WHERE valid_to IS NULL;

CREATE VIEW stg_github_blocked_by AS
SELECT i.number issue, b.value->>'$.number' blocker,b.value->>'$.state' state
FROM stg_github_issue i,json_each(i.blocked_by) b;
