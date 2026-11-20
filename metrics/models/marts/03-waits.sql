CREATE TABLE mart_merge_wait AS
WITH passes AS (SELECT c.pr,c.merged_at merged,max(e.at) last_pass FROM change c LEFT JOIN event e
 ON e.kind='verdict' AND e.attributes->>'$.pr'=c.pr AND e.attributes->>'$.verdict'='PASS' AND e.at<=c.merged_at
 WHERE c.merged_at IS NOT NULL GROUP BY c.pr)
SELECT *, (julianday(merged)-julianday(last_pass))*1440 minutes, CASE
 WHEN EXISTS(SELECT 1 FROM span WHERE kind='staging_occupancy' AND start<merged AND coalesce(end,merged)>last_pass) THEN 'staging_occupied'
 WHEN EXISTS(SELECT 1 FROM span WHERE kind='deploy_run' AND start<merged AND end>last_pass) THEN 'deploy_running'
 WHEN EXISTS(SELECT 1 FROM stg_github_pr_history h WHERE h.number=p.pr AND h.mergeable_state='dirty' AND h.valid_from<merged AND coalesce(h.valid_to,merged)>last_pass) THEN 'conflict_or_rebase'
 ELSE 'none' END reason,'1' definition_version FROM passes p;

CREATE TABLE mart_wip AS
WITH RECURSIVE ticks(t,last) AS (
 SELECT unixepoch(min(created_at))/600*600,unixepoch((SELECT max(valid_from) FROM staging_record)) FROM work_item
 UNION ALL SELECT t+600,last FROM ticks WHERE t+600<=last
), times AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',t,'unixepoch') at FROM ticks WHERE t IS NOT NULL)
SELECT at,(SELECT count(*) FROM mart_issue_flow WHERE launch<=at AND
 max(coalesce(merged,last_owner_activity),last_owner_activity)>at) active_owners,
 (SELECT count(*) FROM work_item w LEFT JOIN mart_issue_flow f USING(issue)
 WHERE w.ready_at<=at AND coalesce(w.closed_at,'9999')>at AND coalesce(f.launch,'9999')>at) queued_ready,'1' definition_version FROM times;
CREATE TABLE mart_health AS
WITH samples AS (
 SELECT s.key source,s.value tally,r.ingest_id
 FROM staging_record r,json_each(r.payload,'$.sources') s WHERE r.source='metrics.receiver'
), beats AS (
 SELECT source,max(tally->>'$.last_poll') last_poll,sum(coalesce(tally->>'$.failed_cycles',0)) failed_cycles,
 sum(coalesce(tally->>'$.skipped_cycles',0)) skipped_cycles FROM samples GROUP BY source
), arrivals AS (
 SELECT source,max(observed_at) last_append,avg((julianday(observed_at)-julianday(occurred_at))*1440) lag_minutes
 FROM raw.l1_record GROUP BY source
)
SELECT s.source,a.last_append,b.last_poll,a.lag_minutes,
 coalesce((SELECT tally->>'$.held_now' FROM samples x WHERE x.source=s.source AND tally->>'$.held_now' IS NOT NULL ORDER BY ingest_id DESC LIMIT 1),0) held,
 (SELECT count(*) FROM raw.l1_quarantine q WHERE q.source=s.source) quarantined,
 coalesce(b.failed_cycles,0) failed_cycles,coalesce(b.skipped_cycles,0) skipped_cycles,'1' definition_version
FROM raw.l1_source s LEFT JOIN arrivals a USING(source) LEFT JOIN beats b USING(source);
