CREATE TABLE check_period AS
SELECT DISTINCT ic.issue,c.pr,a.head_sha,
 CASE WHEN a.run_attempt>1 THEN a.started_at ELSE a.created_at END start,
 CASE WHEN a.status='completed' THEN a.updated_at END end
FROM issue_change ic JOIN change c USING(pr) JOIN stg_github_pr p ON p.number=c.pr
JOIN stg_actions_attempt a ON a.workflow='check'
 -- A routed attempt also includes time spent waiting for and running mode.
 AND (a.run_id,a.run_attempt) NOT IN (SELECT run_id,run_attempt FROM stg_actions_job
 WHERE workflow='check' AND name='mode' AND run_id IS NOT NULL AND run_attempt IS NOT NULL) AND
 (a.head_sha=p.head_sha OR EXISTS(SELECT 1 FROM issue_job ij JOIN stg_actions_job j USING(id)
 WHERE ij.issue=ic.issue AND j.run_id=a.run_id AND j.run_attempt=a.run_attempt
 AND (j.head_branch=c.head_ref OR EXISTS(SELECT 1 FROM json_each(j.pr_numbers) WHERE value=c.pr))))
UNION SELECT ic.issue,ic.pr,j.head_sha,j.created_at,j.completed_at
FROM issue_change ic JOIN change c USING(pr) JOIN stg_github_pr p ON p.number=c.pr
JOIN measured_actions_job j ON j.workflow='check'
 AND (j.head_sha=p.head_sha OR j.head_branch=c.head_ref OR EXISTS(SELECT 1 FROM json_each(j.pr_numbers) WHERE value=c.pr));
CREATE INDEX check_issue ON check_period(issue,start,end);
CREATE TABLE check_gate AS
SELECT DISTINCT d.issue,d.at start,j.end,j.start queued
FROM verification_decision d JOIN check_period j USING(issue,pr)
WHERE d.verdict='PASS' AND (j.head_sha=d.head OR
 (length(d.head)>=7 AND j.head_sha LIKE d.head||'%'));

CREATE TABLE handoff AS
SELECT issue,at,CASE WHEN kind='verdict' AND attributes->>'$.verdict'='FAIL' THEN 'failed_verdict' ELSE kind END kind
FROM event WHERE kind IN ('launch','report','coordinator_message','verdict');
CREATE INDEX handoff_issue ON handoff(issue,at);


CREATE TABLE minute_activity AS
SELECT m.*,c.merged_at,p.merge_commit_sha,d.deployable,delivery.delivered,delivery.method,
 EXISTS(SELECT 1 FROM span s WHERE s.issue=m.issue AND kind='verifier_run' AND start<=at AND coalesce(end,'9999')>at) verifier,
 EXISTS(SELECT 1 FROM span s WHERE s.issue=m.issue AND kind IN ('owner_turn','advisor_run') AND start<=at AND coalesce(end,'9999')>at) owner_turn,
 EXISTS(SELECT 1 FROM span s WHERE s.issue=m.issue AND kind='implementer_run' AND start<=at AND coalesce(end,'9999')>at) implementer,
 EXISTS(SELECT 1 FROM check_period s WHERE s.issue=m.issue AND start<=at AND coalesce(end,'9999')>at) ci,
 EXISTS(SELECT 1 FROM check_gate g WHERE g.issue=m.issue AND g.start<=at AND g.queued<=at AND coalesce(g.end,'9999')>at) check_wait,
 EXISTS(SELECT 1 FROM span s WHERE kind='staging_occupancy' AND s.issue<>m.issue AND start<=at AND coalesce(end,'9999')>at) occupied,
 EXISTS(SELECT 1 FROM deploy_attempt a WHERE a.started_at<=at AND coalesce(a.end,'9999')>at) deploying,
 EXISTS(SELECT 1 FROM span s WHERE kind='staging_occupancy' AND s.issue=m.issue AND start<=at AND coalesce(end,'9999')>at) holding_staging,
 EXISTS(SELECT 1 FROM span s WHERE kind='coordinator_turn' AND start<=at AND coalesce(end,'9999')>at) coordinating,
 (SELECT h.kind FROM handoff h WHERE h.issue=m.issue AND h.at<=m.at ORDER BY h.at DESC LIMIT 1) handoff,
 EXISTS(SELECT 1 FROM event e WHERE e.issue=m.issue AND e.kind='owner_wake' AND e.at>m.at
 AND e.attributes->>'$.wake_kind' IN ('pr_watch','monitor','delegate_done','subagent_done','bg_cmd_done')
 AND e.at=(SELECT min(n.at) FROM event n WHERE n.issue=m.issue AND n.kind='owner_wake' AND n.at>m.at)) owner_wait
FROM issue_minute m LEFT JOIN issue_classification c USING(issue)
LEFT JOIN deployment_delivery delivery ON delivery.pr=c.pr LEFT JOIN change p ON p.pr=c.pr LEFT JOIN deploy_scope d ON d.pr=coalesce(c.pr,
 (SELECT ic.pr FROM issue_change ic WHERE ic.issue=m.issue ORDER BY ic.pr LIMIT 1));
