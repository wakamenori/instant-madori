CREATE TABLE verification_decision AS
WITH messages AS (
 SELECT a.issue,a.pr,a.id actor,a.created_at launched,t.attempt,m.created_at,m.verdict,coalesce(m.head,t.sha) head,m.decided_at,m.failed_checks,
 row_number() OVER(PARTITION BY a.id,a.issue ORDER BY m.created_at DESC,m.id DESC) pos
 FROM actor a JOIN stg_t3_thread t USING(id) LEFT JOIN stg_t3_message m ON m.thread_id=a.id AND m.role='assistant'
 WHERE a.role='verifier'
), threads AS (
 SELECT *,coalesce(attempt,row_number() OVER(PARTITION BY issue,pr ORDER BY launched,actor)) round
 FROM messages WHERE pos=1
), comments AS (
 SELECT ic.issue,ic.pr,b.*,row_number() OVER(PARTITION BY ic.issue,ic.pr,b.attempt ORDER BY b.updated_at DESC,b.comment_id DESC) pos
 FROM stg_github_comment_block b JOIN issue_change ic ON ic.pr=b.issue_or_pr WHERE b.verdict IS NOT NULL
), statuses AS (
 SELECT ic.issue,s.pr,s.attempt round,s.sha head,s.created_at at,s.verdict,s.failed_checks,
 row_number() OVER(PARTITION BY ic.issue,s.pr,s.attempt ORDER BY s.created_at DESC,s.id DESC) pos
 FROM stg_github_commit_status s JOIN issue_change ic ON ic.pr=s.pr
 WHERE s.context='verify' AND s.attempt IS NOT NULL AND s.verdict IS NOT NULL
)
SELECT s.issue,s.pr,(SELECT t.actor FROM threads t WHERE t.issue=s.issue AND t.pr=s.pr AND t.round=s.round
 ORDER BY t.launched DESC,t.actor DESC LIMIT 1) actor,s.verdict,s.head,s.at,0 legacy,s.round,s.failed_checks
FROM statuses s WHERE s.pos=1
UNION ALL SELECT t.issue,t.pr,actor,t.verdict,t.head,coalesce(t.decided_at,t.created_at) at,t.decided_at IS NULL legacy,
 t.round,coalesce(t.failed_checks,b.failed_checks) failed_checks
FROM threads t LEFT JOIN comments b ON b.issue=t.issue AND b.pr=t.pr AND b.attempt=t.round AND b.pos=1 AND b.verdict=t.verdict
WHERE NOT EXISTS(SELECT 1 FROM statuses s WHERE s.pos=1 AND s.issue=t.issue AND s.pr=t.pr AND s.round=t.round)
UNION ALL SELECT issue,pr,NULL,verdict,head,decided_at,0,attempt,failed_checks FROM comments b WHERE pos=1
AND NOT EXISTS(SELECT 1 FROM statuses s WHERE s.pos=1 AND s.issue=b.issue AND s.pr=b.pr AND s.round=b.attempt)
AND NOT EXISTS(SELECT 1 FROM threads t WHERE t.issue=b.issue AND t.pr=b.pr AND t.round=b.attempt);
