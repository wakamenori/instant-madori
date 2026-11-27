-- Effective commit times of the coordinator's owner limit. Earlier minutes have no recorded policy.
CREATE TABLE owner_limit(effective TEXT PRIMARY KEY,capacity INTEGER,revision TEXT);
INSERT INTO owner_limit VALUES ('2026-11-18T01:49:39.000Z',3,'faf6af125'),('2026-11-20T05:04:07.000Z',5,'a2b440cf0');

CREATE TABLE dispatch_policy(effective TEXT PRIMARY KEY, infrastructure_max INTEGER NOT NULL, revision TEXT NOT NULL);
INSERT INTO dispatch_policy VALUES ('2026-11-27T16:16:38.000Z',1,'cbb1bc007');

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
WITH permanent_lane(title,lane) AS (
 VALUES ('開発基盤','infrastructure'),('期限なし','parked'),('初回提供の後','parked')
)
SELECT number issue,
 coalesce(h.blocked_by,(SELECT r.blocked_by FROM stg_github_issue_history r
 WHERE r.number=h.number AND r.blocked_by IS NOT NULL ORDER BY r.valid_from LIMIT 1)) blocked_by,
 coalesce(h.shared_resources,(SELECT r.shared_resources FROM stg_github_issue_history r
 WHERE r.number=h.number AND r.shared_resources IS NOT NULL ORDER BY r.valid_from LIMIT 1)) shared_resources,milestone,
 CASE WHEN h.milestone IS NULL THEN 'unplaced' ELSE coalesce(p.lane,'stage') END lane,
 EXISTS(SELECT 1 FROM json_each(h.labels) WHERE value='スループット') throughput,
 CASE WHEN row_number() OVER(PARTITION BY number ORDER BY valid_from)=1 THEN unixepoch(created_at) ELSE unixepoch(valid_from) END start,
 unixepoch(valid_to) end FROM stg_github_issue_history h LEFT JOIN permanent_lane p ON p.title=h.milestone->>'$.title';
CREATE INDEX requirement_issue ON issue_requirements(issue,start,end);

CREATE TABLE stage_feeder AS
WITH RECURSIVE first_policy(at) AS (
 SELECT unixepoch(min(effective)) FROM dispatch_policy
), boundaries(at) AS (
 SELECT at FROM first_policy WHERE at IS NOT NULL
 UNION SELECT start FROM issue_requirements,first_policy WHERE start>at
 UNION SELECT end FROM issue_requirements,first_policy WHERE end>at
 UNION SELECT start FROM issue_availability,first_policy WHERE start>at
 UNION SELECT end FROM issue_availability,first_policy WHERE end>at
), epochs AS (
 SELECT at start,lead(at) OVER(ORDER BY at) end FROM boundaries
), dependencies AS MATERIALIZED (
 SELECT i.issue,i.start,i.end,b.value->>'$.number' blocker
 FROM issue_requirements i,json_each(i.blocked_by) b
), open_issues AS MATERIALIZED (
 SELECT e.start epoch,i.issue,i.lane FROM epochs e
 JOIN issue_requirements i ON i.start<=e.start AND (i.end IS NULL OR e.start<i.end)
 JOIN issue_availability av ON av.issue=i.issue AND av.start<=e.start AND (av.end IS NULL OR e.start<av.end)
), open_edges AS MATERIALIZED (
 -- CROSS JOIN pins the order. Otherwise SQLite looks up the blocked issue by epoch alone, about 7x slower.
 SELECT o.epoch,o.issue,b.issue blocker FROM open_issues o
 CROSS JOIN dependencies d ON d.issue=o.issue AND d.start<=o.epoch AND (d.end IS NULL OR o.epoch<d.end)
 CROSS JOIN open_issues b ON b.epoch=o.epoch AND b.issue=d.blocker
), feeders(issue,epoch) AS (
 SELECT d.blocker,d.epoch FROM open_edges d JOIN open_issues o USING(epoch,issue) WHERE o.lane='stage'
 UNION
 SELECT d.blocker,d.epoch FROM feeders f JOIN open_edges d USING(epoch,issue)
)
SELECT f.issue,e.start,e.end FROM feeders f JOIN epochs e ON e.start=f.epoch;
CREATE INDEX stage_feeder_issue ON stage_feeder(issue,start,end);

CREATE TABLE owner_capacity_minute AS
 SELECT m.*, (SELECT capacity FROM owner_limit WHERE unixepoch(effective)<=minute ORDER BY effective DESC LIMIT 1)-owners slots,
 EXISTS(SELECT 1 FROM issue_minute a JOIN issue_requirements i ON i.issue=a.issue AND i.start<=m.minute AND coalesce(i.end,m.minute+1)>m.minute
 WHERE a.minute=m.minute AND EXISTS(SELECT 1 FROM json_each(i.shared_resources) WHERE value='staging を占有する')) occupied,
 (SELECT count(*) FROM issue_minute a JOIN issue_requirements i ON i.issue=a.issue
 AND i.start<=m.minute AND coalesce(i.end,m.minute+1)>m.minute WHERE a.minute=m.minute AND i.lane='infrastructure') infrastructure,
 EXISTS(SELECT 1 FROM dispatch_policy WHERE unixepoch(effective)<=minute) targets_only,
 (SELECT infrastructure_max FROM dispatch_policy WHERE unixepoch(effective)<=minute ORDER BY effective DESC LIMIT 1) infrastructure_max
 FROM mart_active_minute m;
CREATE TABLE mart_slot_candidate AS
WITH candidates AS (
 SELECT a.minute,i.issue number,a.occupied,a.infrastructure,a.targets_only,a.infrastructure_max,i.lane,
 EXISTS(SELECT 1 FROM json_each(i.shared_resources) WHERE value='staging を占有する') staging
 FROM owner_capacity_minute a JOIN issue_availability av ON av.start<=a.minute AND coalesce(av.end,a.minute+1)>a.minute
 JOIN issue_requirements i ON i.issue=av.issue AND i.start<=a.minute AND coalesce(i.end,a.minute+1)>a.minute
 WHERE slots>0 AND NOT EXISTS(SELECT 1 FROM issue_minute m WHERE m.minute=a.minute AND m.issue=i.issue)
 AND NOT EXISTS(SELECT 1 FROM json_each(i.blocked_by) b LEFT JOIN work_item w ON w.issue=b.value->>'$.number'
 WHERE w.issue IS NULL OR EXISTS(SELECT 1 FROM issue_availability dep WHERE dep.issue=w.issue AND dep.start<=a.minute AND coalesce(dep.end,a.minute+1)>a.minute))
 AND (NOT a.targets_only OR i.lane='stage' OR (i.lane='infrastructure' AND (
 i.throughput OR EXISTS(SELECT 1 FROM stage_feeder f WHERE f.issue=i.issue AND f.start<=a.minute AND (f.end IS NULL OR a.minute<f.end))
 )))
), staging_rank AS (
 SELECT *,row_number() OVER(PARTITION BY minute,staging ORDER BY lane<>'stage',number) stage_first_rank
 FROM candidates
), eligible AS (
 SELECT *,NOT staging OR (NOT occupied AND stage_first_rank=1) selectable FROM staging_rank
), lane_rank AS (
 SELECT *,row_number() OVER(PARTITION BY minute,lane ORDER BY selectable DESC,staging,number) lane_rank FROM eligible
)
SELECT minute,number,lane,selectable AND (NOT targets_only OR lane<>'infrastructure' OR lane_rank<=infrastructure_max-infrastructure) selectable
FROM lane_rank;

CREATE TABLE mart_empty_slot AS
WITH counts AS (
 SELECT a.minute,slots,count(c.number) ready,count(c.number) FILTER(WHERE selectable) selectable
 FROM owner_capacity_minute a LEFT JOIN mart_slot_candidate c USING(minute) WHERE slots>0 GROUP BY a.minute
), reasons AS (
 SELECT minute,'no_ready_issue' reason,max(slots-ready,0) slots FROM counts
 UNION ALL SELECT minute,'resource_limit',min(slots,ready)-min(slots,selectable) FROM counts
 UNION ALL SELECT minute,'awaiting_dispatch',min(slots,selectable) FROM counts
)
SELECT * FROM reasons WHERE slots>0;
