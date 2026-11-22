CREATE TABLE mart_minute AS
WITH activity AS (
 SELECT *,CASE WHEN at>=merged_at THEN 'post_merge'
 WHEN verifier THEN 'verifier' WHEN owner_turn THEN 'owner_turn' WHEN implementer THEN 'implementer'
 WHEN check_wait THEN 'check_wait' WHEN ci THEN 'ci'
 WHEN handoff IN ('report','verdict') AND occupied AND deployable IS NOT 0 THEN 'staging_occupied'
 WHEN handoff='verdict' AND deploying AND deployable IS NOT 0 THEN 'deploy_running'
 WHEN handoff IN ('report','verdict','failed_verdict') THEN iif(coordinating,'coordinator_busy','coordinator_asleep')
 WHEN owner_wait THEN 'owner_wait' ELSE 'unknown' END state,
 (SELECT CASE WHEN a.end<=m.at THEN a.conclusion WHEN a.started_at<=m.at THEN 'running' ELSE 'queued' END
 FROM deploy_attempt a WHERE a.head_sha=m.merge_commit_sha AND (CASE WHEN a.run_attempt>1 THEN a.started_at ELSE a.created_at END)<=m.at
 ORDER BY a.created_at DESC,a.run_attempt DESC LIMIT 1) deploy
 FROM minute_activity m
)
SELECT issue,minute,at,state,CASE WHEN state='post_merge' THEN CASE
 WHEN (delivered IS NULL OR delivered>at) AND deploy IN ('running','queued','failure','timed_out','cancelled','skipped') THEN 'deploy_'||deploy
 WHEN occupied THEN 'staging_occupied' WHEN verifier THEN 'verifier' WHEN owner_turn THEN 'owner_check'
 WHEN implementer THEN 'implementer' WHEN ci THEN 'ci' WHEN holding_staging THEN 'staging_occupied'
 WHEN deploy IS NULL AND deployable=0 THEN 'deploy_exempt'
 WHEN deploy IS NULL AND EXISTS(SELECT 1 FROM deploy_attempt a WHERE a.head_sha=merge_commit_sha AND a.created_at>activity.at) THEN 'deploy_queued'
 WHEN owner_wait THEN 'owner_wait' WHEN delivered<=at AND method='later_commit' THEN 'deployed_by_later_commit'
 ELSE 'unknown' END END detail FROM activity;
INSERT INTO mart_issue_wait SELECT issue,state,count(*),'2' FROM mart_minute GROUP BY issue,state;
CREATE TABLE mart_active_minute AS
SELECT minute,count(*) owners,count(*) FILTER(WHERE kind='機能') feature_minutes
FROM issue_minute LEFT JOIN issue_classification USING(issue) GROUP BY minute;
CREATE UNIQUE INDEX active_minute ON mart_active_minute(minute);

CREATE TABLE mart_merge_wait AS
WITH passes AS (
 SELECT c.pr,c.merged_at merged,max(d.at) last_pass
 FROM change c LEFT JOIN verification_decision d ON d.pr=c.pr AND d.verdict='PASS' AND d.at<=c.merged_at
 WHERE c.merged_at IS NOT NULL GROUP BY c.pr
)
SELECT p.*,(julianday(merged)-julianday(last_pass))*1440 minutes,coalesce((
 SELECT state FROM mart_minute m JOIN issue_change ic USING(issue)
 WHERE ic.pr=p.pr AND m.at>=p.last_pass AND m.at<p.merged AND state IN ('staging_occupied','deploy_running','check_wait')
 GROUP BY state ORDER BY count(*) DESC,state LIMIT 1
),'none') reason,'2' definition_version FROM passes p;

CREATE TABLE mart_post_merge_deploy AS
SELECT c.issue,c.pr,p.merge_commit_sha,a.run_id,a.run_attempt,a.conclusion,
 a.created_at queued,a.started_at,a.end completed,
 CASE WHEN d.method IS NOT NULL THEN d.method WHEN s.deployable=0 THEN 'exempt'
 WHEN a.run_id IS NULL THEN 'missing_attempt' ELSE coalesce(a.conclusion,a.status) END delivery,
 d.delivered,d.run_id delivered_run_id,d.run_attempt delivered_attempt
FROM issue_classification c JOIN change p ON p.pr=c.pr JOIN deploy_scope s ON s.pr=c.pr
LEFT JOIN deploy_attempt a ON a.head_sha=p.merge_commit_sha LEFT JOIN deployment_delivery d ON d.pr=c.pr;
