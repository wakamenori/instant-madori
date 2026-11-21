CREATE TABLE mart_record_gap AS
SELECT issue,'missing_closure' reason FROM work_item WHERE closed_at IS NOT NULL AND issue NOT IN (SELECT issue FROM final_closure)
UNION ALL SELECT issue,'missing_kind' FROM issue_classification WHERE label_count=0 AND closed_at IS NOT NULL
UNION ALL SELECT number,'missing_open_kind' FROM stg_github_issue i WHERE i.state='open' AND NOT EXISTS(
 SELECT 1 FROM json_each(i.labels) l JOIN issue_kind k ON l.value=k.kind OR l.value LIKE k.kind||'：%')
UNION ALL SELECT issue,'multiple_kinds' FROM issue_classification WHERE label_count>1
UNION ALL SELECT number,'missing_issue_yaml' FROM stg_github_issue WHERE type IS NULL
UNION ALL SELECT issue,ownership FROM issue_classification WHERE ownership IN ('missing_owner','bypass')
UNION ALL SELECT issue,'missing_verifier' FROM issue_classification c WHERE ownership='owner' AND pr IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM verification_decision d WHERE d.pr=c.pr)
UNION ALL SELECT issue,'invalid_verdict' FROM verification_decision WHERE verdict IS NULL OR legacy=1
UNION ALL SELECT CAST(natural_key AS INTEGER),reason FROM stg_github_invalid_yaml WHERE valid_to IS NULL AND source='github.issue'
UNION ALL SELECT c.issue_or_pr,'missing_comment_yaml' FROM stg_github_comment c
 WHERE EXISTS(SELECT 1 FROM json_each(c.markers) m WHERE m.value IN ('verdict_pass','verdict_fail','staging_occupy_start','staging_occupy_end')) AND NOT EXISTS
 (SELECT 1 FROM stg_github_comment_block b WHERE b.comment_id=c.id)
UNION ALL SELECT c.issue_or_pr,'invalid_comment_yaml' FROM stg_github_invalid_yaml g JOIN stg_github_comment c ON c.id=g.natural_key WHERE g.valid_to IS NULL AND g.source='github.comment';
CREATE VIEW mart_record_gap_count AS SELECT reason,count(*) records FROM mart_record_gap GROUP BY reason;
CREATE TABLE mart_kind_change AS
WITH edits AS (
 SELECT t.*,k.kind,lag(k.kind) OVER(PARTITION BY issue ORDER BY created_at,id) previous_kind
 FROM stg_github_issue_timeline t JOIN issue_kind k ON t.label=k.kind OR t.label LIKE k.kind||'：%' WHERE t.event='labeled'
)
SELECT issue,id,created_at,previous_kind,kind FROM edits WHERE kind<>previous_kind;
CREATE VIEW mart_kind_change_count AS SELECT count(*) changes FROM mart_kind_change;

CREATE TABLE mart_inactive_stretch AS
WITH running AS (
 SELECT started_at start,completed_at end FROM stg_t3_run
 UNION ALL SELECT started_at,completed_at FROM stg_t3_subagent
 UNION ALL SELECT started_at,completed_at FROM stg_actions_job
 UNION ALL SELECT started_at,end FROM deploy_attempt
), silent AS (
 SELECT minute,minute-60*row_number() OVER(ORDER BY minute) grp FROM mart_active_minute a
 WHERE NOT EXISTS(SELECT 1 FROM running WHERE unixepoch(start)<minute+60 AND coalesce(unixepoch(end),minute+60)>minute)
)
SELECT min(minute) start,max(minute)+60 end,count(*) minutes FROM silent GROUP BY grp HAVING count(*)>=30;

CREATE TABLE mart_verification_gap AS
SELECT issue,pr,actor,at,CASE WHEN verdict IS NULL THEN 'missing_verdict' ELSE 'legacy_verdict' END reason
FROM verification_decision WHERE actor IS NOT NULL AND (verdict IS NULL OR legacy=1);
