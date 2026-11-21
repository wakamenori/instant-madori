CREATE TABLE verification_decision AS
WITH messages AS (
 SELECT a.issue,a.pr,a.id actor,m.created_at,m.verdict,coalesce(m.head,t.sha) head,m.decided_at,
 row_number() OVER(PARTITION BY a.id,a.issue ORDER BY m.created_at DESC,m.id DESC) pos
 FROM actor a JOIN stg_t3_thread t USING(id) LEFT JOIN stg_t3_message m ON m.thread_id=a.id AND m.role='assistant'
 WHERE a.role='verifier'
)
SELECT issue,pr,actor,verdict,head,coalesce(decided_at,created_at) at,decided_at IS NULL legacy
FROM messages WHERE pos=1
UNION ALL SELECT ic.issue,ic.pr,NULL,b.verdict,b.head,b.decided_at,0 FROM stg_github_comment_block b
JOIN issue_change ic ON ic.pr=b.issue_or_pr WHERE b.verdict IS NOT NULL
AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.pos=1 AND m.pr=ic.pr AND m.head=b.head AND m.verdict IS NOT NULL);
