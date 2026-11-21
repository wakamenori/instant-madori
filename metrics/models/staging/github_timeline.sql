CREATE VIEW stg_github_issue_timeline AS
SELECT CAST(natural_key AS INTEGER) id,payload->>'$.issue' issue,payload->>'$.event' event,
       strftime('%Y-%m-%dT%H:%M:%fZ',payload->>'$.created_at') created_at,
       payload->>'$.label' label,payload->>'$.commit' commit_sha,payload->>'$.prs' pr_numbers
FROM staging_record WHERE source='github.issue.timeline' AND valid_to IS NULL;

CREATE VIEW stg_github_issue_closure AS
SELECT c.issue,c.id event_id,c.created_at closed_at,c.commit_sha,c.pr_numbers,
       (SELECT json_group_array(label ORDER BY label)
        FROM (SELECT l.label,l.event,
                     row_number() OVER (PARTITION BY l.label ORDER BY l.created_at DESC,l.id DESC) revision
              FROM stg_github_issue_timeline l
              WHERE l.issue=c.issue AND l.label IS NOT NULL
                AND (l.created_at,l.id)<(c.created_at,c.id))
        WHERE revision=1 AND event='labeled') labels
FROM stg_github_issue_timeline c WHERE c.event='closed';
