CREATE TABLE work_item AS
SELECT i.number AS issue, i.title, i.milestone, i.created_at,i.closed_at,
 CASE WHEN NOT EXISTS (
   SELECT 1 FROM json_each(i.blocked_by) b LEFT JOIN stg_github_issue blocker
     ON blocker.number=b.value->>'$.number' WHERE blocker.closed_at IS NULL
 ) THEN max(i.created_at,coalesce((
   SELECT max(blocker.closed_at) FROM json_each(i.blocked_by) b JOIN stg_github_issue blocker
     ON blocker.number=b.value->>'$.number'
 ),i.created_at)) END ready_at
FROM stg_github_issue i;
CREATE TABLE change AS SELECT number AS pr, closes,created_at, merged_at,head_ref,merge_commit_sha FROM stg_github_pr;

CREATE TABLE owner AS SELECT * FROM stg_t3_thread WHERE title_kind='owner' AND parent_thread_id IS NULL;
CREATE TABLE issue_change AS
SELECT DISTINCT issue,pr FROM (
 SELECT CAST(j.value AS INTEGER) issue,c.pr FROM change c,json_each(c.closes) j
 UNION SELECT issue,pr FROM final_closure WHERE pr IS NOT NULL
 UNION SELECT o.issue,c.pr FROM owner o,json_each(o.pr_numbers) j JOIN change c ON c.pr=j.value
 WHERE julianday(c.created_at)>=julianday(o.created_at)-1.0/24
);
CREATE TABLE actor AS
WITH coordinators(id) AS (
 SELECT parent_thread_id FROM stg_t3_thread WHERE title_kind='verifier'
 UNION SELECT m.sender_thread_id FROM stg_t3_message m JOIN owner o ON o.id=m.thread_id
 WHERE m.role='user'
)
SELECT t.id, CASE WHEN t.title_kind='verifier' THEN 'verifier'
 WHEN o.id IS NOT NULL THEN 'owner'
 WHEN parent.id IS NOT NULL AND t.provider='codex' THEN 'implementer'
 WHEN parent.id IS NOT NULL THEN 'advisor'
 WHEN t.id IN (SELECT id FROM coordinators) THEN 'coordinator' ELSE 'other' END role,
 coalesce(o.issue,parent.issue,t.issue,ic.issue) issue,t.pr,t.model,t.effort,t.created_at,t.settled_at
FROM stg_t3_thread t LEFT JOIN owner o ON o.id=t.id LEFT JOIN owner parent ON parent.id=t.parent_thread_id
LEFT JOIN issue_change ic ON ic.pr=t.pr AND (t.issue IS NULL OR ic.issue=t.issue)
UNION ALL SELECT s.id,'advisor',o.issue,NULL,NULL,NULL,s.started_at,s.completed_at
FROM stg_t3_subagent s LEFT JOIN owner o ON o.id=s.thread_id WHERE s.origin='provider_native';

CREATE TABLE issue_job AS
SELECT DISTINCT ic.issue,j.id FROM issue_change ic JOIN change c USING(pr)
JOIN stg_actions_job j ON j.workflow='check' AND (j.head_branch=c.head_ref OR EXISTS (SELECT 1 FROM json_each(j.pr_numbers) WHERE value=c.pr));

CREATE TABLE issue_deploy AS
SELECT ic.issue,c.pr,d.run_id,d.run_attempt,d.updated_at completed_at
FROM issue_change ic JOIN change c USING(pr) JOIN stg_actions_attempt d
ON d.workflow='deploy-staging' AND d.head_sha=c.merge_commit_sha AND d.conclusion='success';

INSERT INTO issue_job
SELECT DISTINCT d.issue,j.id FROM issue_deploy d JOIN stg_actions_job j USING(run_id,run_attempt);
