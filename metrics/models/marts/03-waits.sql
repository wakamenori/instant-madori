CREATE TABLE mart_merge_wait AS
WITH passes AS (SELECT c.pr,c.merged_at merged,max(e.at) last_pass FROM change c LEFT JOIN event e
 ON e.kind='verdict' AND e.attributes->>'$.pr'=c.pr AND e.attributes->>'$.verdict'='PASS' AND e.at<=c.merged_at
 WHERE c.merged_at IS NOT NULL GROUP BY c.pr)
SELECT *, (julianday(merged)-julianday(last_pass))*1440 minutes, CASE
 WHEN EXISTS(SELECT 1 FROM span WHERE kind='staging_occupancy' AND start<merged AND coalesce(end,merged)>last_pass) THEN 'staging occupied'
 WHEN EXISTS(SELECT 1 FROM span WHERE kind='deploy_run' AND start<merged AND end>last_pass) THEN 'deploy running'
 WHEN EXISTS(SELECT 1 FROM stg_github_pr_history h WHERE h.number=p.pr AND h.mergeable_state='dirty' AND h.valid_from<merged AND coalesce(h.valid_to,merged)>last_pass) THEN 'conflict or rebase'
 ELSE 'none' END reason,'1' definition_version FROM passes p;

CREATE TABLE mart_wip AS
WITH RECURSIVE ticks(t,last) AS (
 SELECT unixepoch(min(created_at))/600*600,unixepoch((SELECT max(valid_from) FROM staging_record)) FROM work_item
 UNION ALL SELECT t+600,last FROM ticks WHERE t+600<=last
), times AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',t,'unixepoch') at FROM ticks WHERE t IS NOT NULL)
SELECT at,(SELECT count(*) FROM mart_issue_flow WHERE launch<=at AND
 (CASE WHEN merged IS NULL THEN coalesce((SELECT max(settled_at) FROM owner WHERE owner.issue=mart_issue_flow.issue),'9999') ELSE max(merged,last_owner_activity) END)>at) active_owners,
 (SELECT count(*) FROM work_item w LEFT JOIN mart_issue_flow f USING(issue)
 WHERE w.ready_at<=at AND coalesce(w.closed_at,'9999')>at AND coalesce(f.launch,'9999')>at) queued_ready,'1' definition_version FROM times;
CREATE TABLE mart_health AS
WITH beats AS (SELECT s.key source,max(s.value->>'$.last_poll') last_poll,
 sum(coalesce(s.value->>'$.failed_cycles',0)) failed_cycles,sum(coalesce(s.value->>'$.skipped_cycles',0)) skipped_cycles
 FROM staging_record r,json_each(r.payload,'$.sources') s WHERE r.source='metrics.receiver' GROUP BY s.key)
SELECT h.source,h.last_observed_at last_append,b.last_poll,h.mean_lag_s_24h lag_seconds,h.held_now held,
 (SELECT count(*) FROM raw.l1_quarantine q WHERE q.source=h.source) quarantined,
 coalesce(b.failed_cycles,0) failed_cycles,coalesce(b.skipped_cycles,0) skipped_cycles,'1' definition_version
FROM raw.health_source h LEFT JOIN beats b USING(source);
