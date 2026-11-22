CREATE TABLE mart_issue_flow AS
WITH launches AS (SELECT issue,min(created_at) launch FROM owner GROUP BY issue)
SELECT o.issue,w.title,w.ready_at,o.launch,c.pr,c.created_at pr_opened,c.merged_at merged,
 delivery.delivered deployed,
 (SELECT min(at) FROM event e WHERE e.issue=o.issue AND kind='report') first_report,
 coalesce((SELECT max(end) FROM span s WHERE s.issue=o.issue AND kind='owner_turn'),o.launch) last_owner_activity,
 (SELECT count(*) FROM actor a WHERE a.issue=o.issue AND role='verifier') verifier_rounds,
 (SELECT count(*) FROM event e WHERE e.issue=o.issue AND kind='verdict' AND attributes->>'$.verdict'='FAIL') fails,
 (SELECT count(*) FROM issue_job j JOIN stg_actions_job a USING(id) WHERE j.issue=o.issue AND a.workflow='check') check_jobs,
 (SELECT count(*) FROM event e WHERE e.issue=o.issue AND kind='coordinator_message') coordinator_messages,
 (SELECT count(*) FROM event e WHERE e.issue=o.issue AND kind='owner_wake') owner_wakes,'1' definition_version
FROM launches o LEFT JOIN work_item w USING(issue) LEFT JOIN final_closure f USING(issue) LEFT JOIN change c ON c.pr=f.pr LEFT JOIN deployment_delivery delivery ON delivery.pr=f.pr;

CREATE TABLE mart_issue_wait(issue INTEGER, state TEXT, minutes INTEGER,definition_version TEXT,PRIMARY KEY(issue,state));
