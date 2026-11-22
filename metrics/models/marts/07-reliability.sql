CREATE TABLE mart_health AS
WITH samples AS (
 SELECT s.key source,s.value tally,r.ingest_id
 FROM staging_record r,json_each(r.payload,'$.sources') s WHERE r.source='metrics.receiver'
), beats AS (
 SELECT source,max(tally->>'$.last_poll') last_poll,sum(coalesce(tally->>'$.failed_cycles',0)) failed_cycles,
 sum(coalesce(tally->>'$.skipped_cycles',0)) skipped_cycles FROM samples GROUP BY source
), recent_quarantine AS (
 SELECT q.source,count(*) records FROM raw.l1_quarantine q
 JOIN (SELECT minute FROM mart_active_minute ORDER BY minute DESC LIMIT 480) a ON a.minute=unixepoch(q.observed_at)/60*60
 GROUP BY q.source
), arrivals AS (
 SELECT source,max(observed_at) last_append,avg((julianday(observed_at)-julianday(occurred_at))*1440) lag_minutes
 FROM raw.l1_record GROUP BY source
)
SELECT s.source,coalesce(q.records,0) recent_quarantined,a.last_append,b.last_poll,a.lag_minutes,
 coalesce((SELECT tally->>'$.held_now' FROM samples x WHERE x.source=s.source AND tally->>'$.held_now' IS NOT NULL ORDER BY ingest_id DESC LIMIT 1),0) held,
 (SELECT count(*) FROM raw.l1_quarantine q WHERE q.source=s.source) quarantined,
 (SELECT max(observed_at) FROM raw.l1_quarantine q WHERE q.source=s.source) last_quarantine,
 coalesce(b.failed_cycles,0) failed_cycles,coalesce(b.skipped_cycles,0) skipped_cycles,'1' definition_version
FROM raw.l1_source s LEFT JOIN arrivals a USING(source) LEFT JOIN beats b USING(source) LEFT JOIN recent_quarantine q USING(source);

CREATE VIEW record_policy AS SELECT '2026-11-22T01:04:44.000Z' effective,'43c2075b0' revision;

CREATE VIEW required_issue_yaml AS
SELECT c.issue FROM issue_classification c JOIN stg_github_issue i ON i.number=c.issue
WHERE (c.closed_at IS NOT NULL AND i.created_at>=(SELECT effective FROM record_policy)
 AND c.kind IN ('製品の不具合','製品の作りの見直し','開発の仕組みの改善','開発の仕組みの不具合','開発の仕組みの作りの見直し'));

CREATE TABLE mart_verification_gap AS
SELECT v.issue,v.pr,v.actor,v.at,CASE WHEN v.verdict IS NULL THEN 'missing_verdict' ELSE 'legacy_verdict' END reason
FROM verification_decision v JOIN actor a ON a.id=v.actor AND a.issue IS v.issue
WHERE coalesce(v.at,a.created_at)>=(SELECT effective FROM record_policy) AND (v.verdict IS NULL OR v.legacy=1);

-- A body edit and dispatch can both happen between GitHub polls.
CREATE VIEW dispatch_observation AS
WITH polls AS (
 SELECT payload->>'$.sources."github.issue".last_poll' at FROM staging_record WHERE source='metrics.receiver'
 AND coalesce(payload->>'$.sources."github.issue".failed_cycles',0)+coalesce(payload->>'$.sources."github.issue".skipped_cycles',0)=0
)
SELECT o.issue,coalesce((SELECT min(at) FROM polls WHERE at>=o.created_at),
 (SELECT min(h.valid_from) FROM stg_github_issue_history h WHERE h.number=o.issue AND h.valid_from>=o.created_at),o.created_at) at
FROM owner o WHERE o.created_at>=(SELECT effective FROM record_policy);

CREATE TABLE mart_record_gap AS
SELECT issue,'missing_closure' reason FROM work_item WHERE closed_at>=(SELECT effective FROM record_policy) AND issue NOT IN (SELECT issue FROM final_closure)
UNION ALL SELECT issue,'missing_kind' FROM issue_classification WHERE kind IS NULL AND label_count=0 AND closed_at>=(SELECT effective FROM record_policy)
UNION ALL SELECT c.issue,'missing_open_kind' FROM issue_classification c JOIN stg_github_issue i ON i.number=c.issue
 WHERE i.state='open' AND c.label_count=0 AND i.valid_from>=(SELECT effective FROM record_policy)
UNION ALL SELECT c.issue,'multiple_kinds' FROM issue_classification c JOIN stg_github_issue i ON i.number=c.issue
 WHERE c.label_count>1 AND coalesce(c.closed_at,i.valid_from)>=(SELECT effective FROM record_policy)
UNION ALL SELECT r.issue,CASE WHEN g.reason IS NULL THEN 'missing_issue_yaml' ELSE g.reason END
 FROM required_issue_yaml r JOIN stg_github_issue i ON i.number=r.issue
 LEFT JOIN stg_github_invalid_yaml g ON g.source='github.issue' AND g.natural_key=CAST(r.issue AS TEXT) AND g.valid_to IS NULL
 WHERE i.type IS NULL
UNION ALL SELECT c.issue,'missing_dispatch_target' FROM issue_classification c
 WHERE c.kind='開発の仕組みの改善' AND c.kind_source='current' AND EXISTS(
 SELECT 1 FROM dispatch_observation d JOIN stg_github_issue_history h ON h.number=d.issue
 WHERE d.issue=c.issue AND h.valid_from<=d.at AND (h.valid_to IS NULL OR h.valid_to>d.at)
 AND h.target IS NULL AND EXISTS(SELECT 1 FROM json_each(h.labels) l JOIN issue_kind k ON k.label=l.value WHERE k.kind=c.kind))
UNION ALL SELECT issue,ownership FROM issue_classification WHERE ownership IN ('missing_owner','bypass') AND closed_at>=(SELECT effective FROM record_policy)
UNION ALL SELECT issue,'invalid_verdict' FROM mart_verification_gap
UNION ALL SELECT c.issue_or_pr,'missing_comment_yaml' FROM stg_github_comment c
 WHERE c.created_at>=(SELECT effective FROM record_policy) AND EXISTS(SELECT 1 FROM json_each(c.markers) m WHERE m.value IN ('verdict_pass','verdict_fail','staging_occupy_start','staging_occupy_end')) AND NOT EXISTS
 (SELECT 1 FROM stg_github_comment_block b WHERE b.comment_id=c.id)
UNION ALL SELECT c.issue_or_pr,'invalid_comment_yaml' FROM stg_github_invalid_yaml g JOIN stg_github_comment c ON c.id=g.natural_key
 WHERE g.valid_to IS NULL AND g.source='github.comment' AND c.created_at>=(SELECT effective FROM record_policy);
WITH paths AS (
 SELECT pr,filename path FROM stg_github_pr_file UNION ALL
 SELECT pr,previous_filename FROM stg_github_pr_file WHERE previous_filename IS NOT NULL
), files AS (
 SELECT pr,min(product) only_product,max(product) any_product FROM (
 SELECT pr,path GLOB 'apps/*' OR path GLOB 'crates/*' OR path GLOB 'packages/*' product FROM paths
 ) GROUP BY pr
)
INSERT INTO mart_record_gap
SELECT c.issue,'label_file_mismatch' FROM issue_classification c JOIN final_closure fc USING(issue,pr)
LEFT JOIN files f USING(pr)
WHERE c.closed_at>=(SELECT effective FROM record_policy) AND c.kind_source='closure' AND fc.files_complete AND
 ((c.area='product' AND coalesce(f.any_product,0)=0) OR (c.area='development' AND f.only_product=1));
CREATE VIEW mart_record_gap_count AS SELECT reason,count(*) records FROM mart_record_gap GROUP BY reason;
CREATE TABLE mart_kind_change AS
WITH edits AS (
 SELECT t.*,k.kind,lag(k.kind) OVER(PARTITION BY issue ORDER BY created_at,id) previous_kind
 FROM stg_github_issue_timeline t JOIN issue_kind k ON t.label=k.label WHERE t.event='labeled'
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
