-- Effective commit times of the coordinator's owner limit. Earlier minutes have no recorded policy.
CREATE TABLE owner_limit(effective TEXT PRIMARY KEY,capacity INTEGER,revision TEXT);
INSERT INTO owner_limit VALUES ('2026-11-18T01:49:39.000Z',3,'faf6af125'),('2026-11-20T05:04:07.000Z',5,'a2b440cf0');

CREATE TABLE issue_availability AS
WITH changes AS (
 SELECT number issue,created_at at,0 tie,'open' state FROM stg_github_issue
 UNION ALL SELECT issue,created_at,id,iif(event='reopened','open','closed')
 FROM stg_github_issue_timeline WHERE event IN ('closed','reopened')
 UNION ALL SELECT number,closed_at,1,'closed' FROM stg_github_issue i WHERE closed_at IS NOT NULL AND NOT EXISTS
 (SELECT 1 FROM stg_github_issue_timeline t WHERE t.issue=i.number AND event='closed')
), periods AS (
 SELECT issue,unixepoch(at) start,unixepoch(lead(at) OVER(PARTITION BY issue ORDER BY at,tie)) end,state FROM changes
)
SELECT issue,start,end FROM periods WHERE state='open';
CREATE INDEX availability_issue ON issue_availability(issue,start,end);

CREATE TABLE issue_requirements AS
SELECT number issue,
 coalesce(h.blocked_by,(SELECT r.blocked_by FROM stg_github_issue_history r
 WHERE r.number=h.number AND r.blocked_by IS NOT NULL ORDER BY r.valid_from LIMIT 1)) blocked_by,
 coalesce(h.shared_resources,(SELECT r.shared_resources FROM stg_github_issue_history r
 WHERE r.number=h.number AND r.shared_resources IS NOT NULL ORDER BY r.valid_from LIMIT 1)) shared_resources,milestone,
 CASE WHEN row_number() OVER(PARTITION BY number ORDER BY valid_from)=1 THEN unixepoch(created_at) ELSE unixepoch(valid_from) END start,
 unixepoch(valid_to) end FROM stg_github_issue_history h;
CREATE INDEX requirement_issue ON issue_requirements(issue,start,end);

CREATE TABLE owner_capacity_minute AS
 SELECT m.*, (SELECT capacity FROM owner_limit WHERE unixepoch(effective)<=minute ORDER BY effective DESC LIMIT 1)-owners slots,
 EXISTS(SELECT 1 FROM issue_minute a JOIN issue_requirements i ON i.issue=a.issue AND i.start<=m.minute AND coalesce(i.end,m.minute+1)>m.minute
 WHERE a.minute=m.minute AND EXISTS(SELECT 1 FROM json_each(i.shared_resources) WHERE value='staging を占有する')) occupied,
 (SELECT count(*) FROM issue_minute a JOIN issue_requirements i ON i.issue=a.issue
 AND i.start<=m.minute AND coalesce(i.end,m.minute+1)>m.minute WHERE a.minute=m.minute AND i.milestone->>'$.title'='開発基盤') infrastructure
 FROM mart_active_minute m;
CREATE TABLE mart_slot_candidate AS
WITH candidates AS (
 SELECT a.minute,i.issue number,a.occupied,a.infrastructure,a.owners,
 CASE i.milestone->>'$.title' WHEN '開発基盤' THEN 'infrastructure' WHEN '期限なし' THEN 'undated' ELSE 'stage' END lane,EXISTS(SELECT 1 FROM json_each(i.shared_resources) WHERE value='staging を占有する') staging
 FROM owner_capacity_minute a JOIN issue_availability av ON av.start<=a.minute AND coalesce(av.end,a.minute+1)>a.minute
 JOIN issue_requirements i ON i.issue=av.issue AND i.start<=a.minute AND coalesce(i.end,a.minute+1)>a.minute
 WHERE slots>0 AND NOT EXISTS(SELECT 1 FROM issue_minute m WHERE m.minute=a.minute AND m.issue=i.issue)
 AND NOT EXISTS(SELECT 1 FROM json_each(i.blocked_by) b LEFT JOIN work_item w ON w.issue=b.value->>'$.number'
 WHERE w.issue IS NULL OR EXISTS(SELECT 1 FROM issue_availability dep WHERE dep.issue=w.issue AND dep.start<=a.minute AND coalesce(dep.end,a.minute+1)>a.minute))
), staging_rank AS (
 SELECT *,row_number() OVER(PARTITION BY minute,staging ORDER BY lane='undated',
 CASE lane WHEN 'infrastructure' THEN infrastructure>=2 ELSE owners-infrastructure>=3 END,number) resource_rank
 FROM candidates
), eligible AS (
 SELECT *,NOT staging OR (NOT occupied AND resource_rank=1) selectable FROM staging_rank
), lane_rank AS (
 SELECT *,row_number() OVER(PARTITION BY minute,lane ORDER BY selectable DESC,number) lane_position FROM eligible
)
SELECT minute,number,lane,selectable,row_number() OVER(PARTITION BY minute ORDER BY selectable DESC,lane='undated',
 CASE WHEN minute<unixepoch('2026-11-20T20:27:58Z') THEN 0
 WHEN lane='infrastructure' THEN lane_position>2-infrastructure ELSE lane_position>3-(owners-infrastructure) END,number) position
FROM lane_rank;

CREATE TABLE mart_empty_slot AS
WITH counts AS (
 SELECT a.minute,slots,count(c.number) ready,count(c.number) FILTER(WHERE selectable AND position<=slots) selectable
 FROM owner_capacity_minute a LEFT JOIN mart_slot_candidate c USING(minute) WHERE slots>0 GROUP BY a.minute
), reasons AS (
 SELECT minute,'no_ready_issue' reason,max(slots-ready,0) slots FROM counts
 UNION ALL SELECT minute,'resource_limit',min(slots,ready)-min(slots,selectable) FROM counts
 UNION ALL SELECT minute,'awaiting_dispatch',min(slots,selectable) FROM counts
)
SELECT * FROM reasons WHERE slots>0;
