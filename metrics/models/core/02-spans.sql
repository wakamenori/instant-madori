CREATE TABLE span AS
SELECT a.id actor,a.issue,CASE role WHEN 'owner' THEN 'owner_turn' WHEN 'implementer' THEN 'implementer_run'
 WHEN 'advisor' THEN 'advisor_run' WHEN 'verifier' THEN 'verifier_run' ELSE 'coordinator_turn' END kind,r.started_at start,r.completed_at end
FROM actor a JOIN stg_t3_run r ON r.thread_id=a.id
WHERE role IN ('owner','implementer','advisor','coordinator','verifier') AND r.started_at IS NOT NULL
UNION ALL SELECT a.id,a.issue,'advisor_run',s.started_at,s.completed_at FROM stg_t3_subagent s JOIN actor a ON a.id=s.id
WHERE s.origin='provider_native'
UNION ALL SELECT j.id,ij.issue,iif(workflow='check','ci_queue','deploy_queue'),j.created_at,coalesce(j.started_at,j.completed_at)
FROM stg_actions_job j LEFT JOIN issue_job ij USING(id)
UNION ALL SELECT j.id,ij.issue,iif(workflow='check','ci_run','deploy_run'),j.started_at,j.completed_at
FROM stg_actions_job j LEFT JOIN issue_job ij USING(id)
UNION ALL SELECT comment_id,issue_or_pr,'staging_occupancy',started_at,max(ended_at)
FROM stg_github_comment_block WHERE started_at IS NOT NULL AND issue_or_pr NOT IN (SELECT number FROM stg_github_pr) GROUP BY issue_or_pr,started_at
UNION ALL SELECT c.id,c.issue_or_pr,'staging_occupancy',c.created_at,(
 SELECT min(e.created_at) FROM stg_github_comment e,json_each(e.markers) m
 WHERE m.value='staging_occupy_end' AND e.issue_or_pr=c.issue_or_pr AND e.created_at>=c.created_at)
FROM stg_github_comment c,json_each(c.markers) m WHERE m.value='staging_occupy_start'
 -- The coordinator opens and closes occupancy on the Issue; its merge comment on the PR repeats the
 -- opening line but never closes it.
 AND NOT EXISTS (SELECT 1 FROM stg_github_comment_block b WHERE b.issue_or_pr=c.issue_or_pr AND b.started_at IS NOT NULL AND (b.comment_id=c.id OR (b.started_at<=c.created_at AND coalesce(b.ended_at,'9999')>=c.created_at)))
 AND c.issue_or_pr NOT IN (SELECT number FROM stg_github_pr);
CREATE INDEX span_issue ON span(issue,kind,start);
