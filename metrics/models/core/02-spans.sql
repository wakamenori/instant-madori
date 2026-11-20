CREATE TABLE span AS
SELECT a.id actor,a.issue,CASE role WHEN 'owner' THEN 'owner_turn' WHEN 'implementer' THEN 'implementer_run'
 WHEN 'advisor' THEN 'advisor_run' ELSE 'coordinator_turn' END kind,r.started_at start,r.completed_at end
FROM actor a JOIN stg_t3_run r ON r.thread_id=a.id
WHERE role IN ('owner','implementer','advisor','coordinator') AND r.started_at IS NOT NULL
UNION ALL SELECT a.id,a.issue,'verifier_run',a.created_at,max(r.completed_at)
FROM actor a JOIN stg_t3_run r ON r.thread_id=a.id WHERE role='verifier' GROUP BY a.id,a.issue
UNION ALL SELECT a.id,a.issue,'advisor_run',s.started_at,s.completed_at FROM stg_t3_subagent s JOIN actor a ON a.id=s.id
WHERE s.origin='provider_native'
UNION ALL SELECT j.id,ij.issue,iif(workflow='check','ci_queue','deploy_queue'),j.created_at,j.started_at
FROM stg_actions_job j LEFT JOIN issue_job ij USING(id)
UNION ALL SELECT j.id,ij.issue,iif(workflow='check','ci_run','deploy_run'),j.started_at,j.completed_at
FROM stg_actions_job j LEFT JOIN issue_job ij USING(id)
UNION ALL SELECT c.id,c.issue_or_pr,'staging_occupancy',c.created_at,(
 SELECT min(e.created_at) FROM stg_github_comment e,json_each(e.markers) m
 WHERE m.value='staging_occupy_end' AND e.issue_or_pr=c.issue_or_pr AND e.created_at>=c.created_at)
FROM stg_github_comment c,json_each(c.markers) m WHERE m.value='staging_occupy_start';
CREATE INDEX span_issue ON span(issue,kind,start);
