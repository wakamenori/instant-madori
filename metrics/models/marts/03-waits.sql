CREATE TABLE mart_wip AS
WITH RECURSIVE ticks(t,last) AS (
 SELECT unixepoch(min(created_at))/600*600,unixepoch((SELECT max(valid_from) FROM staging_record)) FROM work_item
 UNION ALL SELECT t+600,last FROM ticks WHERE t+600<=last
), times AS (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',t,'unixepoch') at FROM ticks WHERE t IS NOT NULL)
SELECT at,(SELECT count(DISTINCT issue) FROM owner_interval WHERE start<=at AND end>at) active_owners,
 (SELECT count(*) FROM work_item w LEFT JOIN mart_issue_flow f USING(issue)
 WHERE w.ready_at<=at AND coalesce(w.closed_at,'9999')>at AND coalesce(f.launch,'9999')>at) queued_ready,'1' definition_version FROM times;
