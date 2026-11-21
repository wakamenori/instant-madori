CREATE TABLE final_closure AS
WITH transitions AS (
 SELECT *,row_number() OVER(PARTITION BY issue ORDER BY created_at DESC,id DESC) seq
 FROM stg_github_issue_timeline WHERE event IN ('closed','reopened')
), candidates AS (
 SELECT t.issue,c.closed_at,c.labels,p.number pr,p.merged_at,p.head_ref,p.creator_type,p.files_complete,
 row_number() OVER(PARTITION BY t.issue ORDER BY (p.merge_commit_sha=c.commit_sha) DESC,p.number) choice,
 count(*) FILTER(WHERE p.merge_commit_sha=c.commit_sha) OVER(PARTITION BY t.issue) exact_matches,
 count(p.number) OVER(PARTITION BY t.issue) matches
 FROM transitions t JOIN stg_github_issue_closure c ON c.event_id=t.id
 LEFT JOIN stg_github_pr p ON p.merged_at<=c.closed_at AND
 (p.merge_commit_sha=c.commit_sha OR p.number IN (SELECT value FROM json_each(c.pr_numbers)))
 WHERE t.seq=1 AND t.event='closed'
)
SELECT * FROM candidates WHERE choice=1 AND (matches<=1 OR exact_matches=1);
