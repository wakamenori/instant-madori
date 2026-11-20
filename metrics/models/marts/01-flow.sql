CREATE TABLE mart_issue_flow AS
WITH changes AS (
 SELECT ic.issue,c.*,row_number() OVER (PARTITION BY ic.issue ORDER BY
 (c.merged_at IS NOT NULL) DESC,EXISTS(SELECT 1 FROM json_each(c.closes) WHERE value=ic.issue) DESC,c.pr) rank
 FROM issue_change ic JOIN change c USING(pr)
), launches AS (SELECT issue,min(created_at) launch FROM owner GROUP BY issue)
SELECT o.issue,w.title,w.ready_at,o.launch,c.pr,c.created_at pr_opened,c.merged_at merged,
 (SELECT min(at) FROM event e WHERE e.issue=o.issue AND kind='deployed' AND attributes->>'$.pr'=c.pr) deployed,
 (SELECT min(at) FROM event e WHERE e.issue=o.issue AND kind='report') first_report,
 coalesce((SELECT max(end) FROM span s WHERE s.issue=o.issue AND kind='owner_turn'),o.launch) last_owner_activity,
 (SELECT count(*) FROM actor a WHERE a.issue=o.issue AND role='verifier') verifier_rounds,
 (SELECT count(*) FROM event e WHERE e.issue=o.issue AND kind='verdict' AND attributes->>'$.verdict'='FAIL') fails,
 (SELECT count(*) FROM issue_job j JOIN stg_actions_job a USING(id) WHERE j.issue=o.issue AND a.workflow='check') check_jobs,
 (SELECT count(*) FROM event e WHERE e.issue=o.issue AND kind='coordinator_message') coordinator_messages,
 (SELECT count(*) FROM event e WHERE e.issue=o.issue AND kind='owner_wake') owner_wakes,'1' definition_version
FROM launches o LEFT JOIN work_item w USING(issue) LEFT JOIN changes c ON c.issue=o.issue AND c.rank=1;

CREATE TABLE mart_issue_wait(issue INTEGER, state TEXT, minutes INTEGER,definition_version TEXT,PRIMARY KEY(issue,state));
