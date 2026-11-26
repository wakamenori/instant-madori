CREATE VIEW record_policy AS SELECT '2026-11-22T01:04:44.000Z' effective,'43c2075b0' revision;

CREATE VIEW inside_actor AS
SELECT id,issue,iif(role='advisor','owner',role) role FROM actor
WHERE issue IS NOT NULL AND role IN ('owner','advisor','implementer','verifier','other');

CREATE TABLE span_kind(kind TEXT PRIMARY KEY,axis TEXT NOT NULL CHECK(axis IN ('turn','generation','local','ci','deploy','human','resource','context')));
INSERT INTO span_kind VALUES
 ('owner_turn','turn'),('implementer_run','turn'),('advisor_run','turn'),('verifier_run','turn'),('coordinator_turn','turn'),
 ('generation','generation'),('local_run','local'),
 ('ci_run','ci'),('deploy_run','deploy'),
 ('decision','human'),
 ('ci_queue','resource'),('deploy_queue','resource'),('docker_wait','resource'),
 ('staging_occupancy','context');

CREATE TEMP TABLE check_issue_attempt AS
SELECT DISTINCT ic.issue,j.run_id,j.run_attempt
FROM issue_change ic JOIN change c USING(pr) JOIN stg_actions_job j
 ON j.workflow='check' AND (j.head_branch=c.head_ref OR EXISTS(SELECT 1 FROM json_each(j.pr_numbers) WHERE value=c.pr));

CREATE TABLE span AS
WITH local_command AS (
 SELECT payload->>'$.thread' thread,payload->>'$.cwd' cwd,payload->>'$.name' name,
  payload->>'$.started_at' start,payload->>'$.ended_at' end,
  coalesce(payload->>'$.exit_code',payload->>'$.signal') result
 FROM staging_record WHERE source='run.span' AND valid_to IS NULL
), occupancy_labels AS (
 SELECT issue,id,event,created_at FROM stg_github_issue_timeline WHERE label='staging を占有中'
), launches AS (
 SELECT occurred_at,payload->>'$.input.session_id' session,payload->>'$.input.tool_use_id' tool_use_id,
  payload->>'$.input.background_task_id' task_id
 FROM stg_claude_hook WHERE payload->>'$.input.hook_event_name'='PostToolUse' AND payload->>'$.input.tool_name'='Bash'
), notifications AS (
 SELECT occurred_at,payload->>'$.input.session_id' session,payload->>'$.input.task_notification' notification,natural_key
 FROM stg_claude_hook WHERE payload->>'$.input.hook_event_name'='UserPromptSubmit' AND payload->>'$.input.task_notification' IS NOT NULL
), completions AS (
 SELECT *,row_number() OVER (PARTITION BY session,notification->>'$.tool_use_id',notification->>'$.task_id' ORDER BY occurred_at,natural_key) arrival
 FROM notifications
)
SELECT a.id actor,a.issue,CASE role WHEN 'owner' THEN 'owner_turn' WHEN 'implementer' THEN 'implementer_run'
 WHEN 'advisor' THEN 'advisor_run' WHEN 'verifier' THEN 'verifier_run' ELSE 'coordinator_turn' END kind,r.started_at start,r.completed_at end,
 CASE WHEN a.role='coordinator' THEN (SELECT i.issue FROM stg_t3_message m JOIN inside_actor i ON i.id=m.sender_thread_id
  WHERE m.id=r.user_message_id AND m.thread_id=a.id) END detail
FROM actor a JOIN stg_t3_run r ON r.thread_id=a.id
WHERE role IN ('owner','implementer','advisor','verifier','coordinator') AND r.started_at IS NOT NULL
UNION ALL SELECT a.id,a.issue,'advisor_run',s.started_at,s.completed_at,NULL FROM stg_t3_subagent s JOIN actor a ON a.id=s.id
WHERE s.origin='provider_native'
UNION ALL SELECT t.thread_id,i.issue,'generation',m.start,m.end,NULL
FROM stg_model_call m JOIN stg_session_thread t USING(session) JOIN inside_actor i ON i.id=t.thread_id
UNION ALL SELECT t.thread_id,i.issue,iif(c.mark='decision','decision','local_run'),c.start,c.end,iif(c.stands_for='local_run','waited:'||c.name,c.name)
FROM stg_tool_call c JOIN stg_session_thread t USING(session) JOIN inside_actor i ON i.id=t.thread_id
WHERE c.mark IS NULL OR c.mark='decision' OR c.stands_for='local_run'
UNION ALL SELECT t.thread_id,i.issue,'local_run',l.occurred_at,coalesce(c.notification->>'$.ended_at',c.occurred_at),
 'background:'||coalesce('exit '||(c.notification->>'$.exit_code'),c.notification->>'$.status')
FROM launches l JOIN completions c ON c.session=l.session AND c.notification->>'$.tool_use_id'=l.tool_use_id
 AND c.notification->>'$.task_id'=l.task_id AND c.arrival=1
JOIN stg_session_thread t ON t.session=l.session JOIN inside_actor i ON i.id=t.thread_id
UNION ALL SELECT i.id,i.issue,'local_run',c.start,c.end,'run:'||c.name||' exit '||c.result
FROM local_command c JOIN (SELECT id,min(issue) issue FROM inside_actor GROUP BY id) i ON i.id=coalesce(
 (SELECT id FROM inside_actor WHERE id=c.thread),
 (SELECT a.id FROM inside_actor a JOIN stg_t3_thread t ON t.id=a.id JOIN stg_t3_run r ON r.thread_id=a.id
  WHERE (c.cwd=t.worktree_path OR substr(c.cwd,1,length(t.worktree_path)+1)=t.worktree_path||'/')
   AND r.started_at<=c.start ORDER BY r.started_at DESC,a.id LIMIT 1))
WHERE NOT EXISTS (SELECT 1 FROM actor WHERE id=c.thread AND role='coordinator')
UNION ALL SELECT j.run_id||'/'||j.run_attempt,ij.issue,'ci_run',min(j.started_at),
 iif(count(*)=count(j.completed_at),max(j.completed_at),NULL),NULL
FROM stg_actions_job j JOIN check_issue_attempt ij USING(run_id,run_attempt)
WHERE j.workflow='check' GROUP BY ij.issue,j.run_id,j.run_attempt HAVING min(j.started_at) IS NOT NULL
UNION ALL SELECT j.id,ij.issue,'ci_queue',j.created_at,coalesce(j.started_at,j.completed_at),NULL
FROM stg_actions_job j JOIN check_issue_attempt ij USING(run_id,run_attempt) WHERE j.workflow='check'
UNION ALL SELECT a.run_id||'/'||a.run_attempt,ic.issue,'deploy_run',a.started_at,a.end,a.conclusion
FROM issue_change ic JOIN change c USING(pr) JOIN deploy_attempt a ON a.head_sha=c.merge_commit_sha WHERE a.started_at IS NOT NULL
UNION ALL SELECT a.run_id||'/'||a.run_attempt,ic.issue,'deploy_queue',iif(a.run_attempt>1,a.started_at,a.created_at),a.started_at,NULL
FROM issue_change ic JOIN change c USING(pr) JOIN deploy_attempt a ON a.head_sha=c.merge_commit_sha
UNION ALL SELECT DISTINCT d.wait_id,coalesce(a.issue,ij.issue),'docker_wait',d.start,d.end,a.id
FROM (SELECT wait_id,cwd,run_id,run_attempt,min(at) FILTER(WHERE phase='started') start,
  min(at) FILTER(WHERE phase IN ('acquired','cancelled')) end FROM stg_docker_slot GROUP BY wait_id) d
LEFT JOIN stg_t3_thread t ON d.cwd=t.worktree_path OR substr(d.cwd,1,length(t.worktree_path)+1)=t.worktree_path||'/'
LEFT JOIN actor a ON a.id=t.id LEFT JOIN stg_actions_job j ON j.run_id=d.run_id AND j.run_attempt=d.run_attempt
LEFT JOIN issue_job ij ON ij.id=j.id WHERE d.start IS NOT NULL
UNION ALL SELECT l.id,l.issue,'staging_occupancy',l.created_at,(
 SELECT min(e.created_at) FROM occupancy_labels e WHERE e.issue=l.issue AND e.event='unlabeled'
 AND (e.created_at,e.id)>(l.created_at,l.id)),NULL
FROM occupancy_labels l WHERE l.event='labeled'
UNION ALL SELECT comment_id,issue_or_pr,'staging_occupancy',started_at,max(ended_at),NULL
FROM stg_github_comment_block WHERE started_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM occupancy_labels WHERE created_at<=started_at)
 AND issue_or_pr NOT IN (SELECT number FROM stg_github_pr) GROUP BY issue_or_pr,started_at
UNION ALL SELECT c.id,c.issue_or_pr,'staging_occupancy',c.created_at,(
 SELECT min(e.created_at) FROM stg_github_comment e,json_each(e.markers) m
 WHERE m.value='staging_occupy_end' AND e.issue_or_pr=c.issue_or_pr AND e.created_at>=c.created_at
 AND e.created_at<(SELECT effective FROM record_policy)),NULL
FROM stg_github_comment c,json_each(c.markers) m WHERE m.value='staging_occupy_start'
 AND c.created_at<(SELECT effective FROM record_policy)
 -- The coordinator opens and closes occupancy on the Issue; its merge comment on the PR repeats the
 -- opening line but never closes it.
 AND NOT EXISTS (SELECT 1 FROM stg_github_comment_block b WHERE b.issue_or_pr=c.issue_or_pr AND b.started_at IS NOT NULL AND (b.comment_id=c.id OR (b.started_at<=c.created_at AND coalesce(b.ended_at,'9999')>=c.created_at)))
 AND c.issue_or_pr NOT IN (SELECT number FROM stg_github_pr);
CREATE INDEX span_issue ON span(issue,kind,start);
CREATE INDEX span_kind_time ON span(kind,start,end);
