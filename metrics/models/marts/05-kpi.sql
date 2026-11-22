CREATE TABLE kpi_policy AS SELECT unixepoch('2026-11-21T12:21:00Z') since;
CREATE TABLE kpi_span(hours INTEGER);
INSERT INTO kpi_span VALUES (4),(8),(24);
CREATE TABLE kpi_target(target TEXT,kind TEXT);
INSERT INTO kpi_target VALUES ('機能','機能'),('全種類',NULL);

CREATE TABLE period AS
WITH RECURSIVE hours(hour,last) AS (
 SELECT min(minute)/3600*3600,max(minute)/3600*3600 FROM (
 SELECT minute FROM mart_active_minute UNION ALL
 SELECT unixepoch(closed_at) FROM issue_classification WHERE ownership='owner' AND pr IS NOT NULL
 )
 UNION ALL SELECT hour+3600,last FROM hours WHERE hour<last
), ranked AS (
 SELECT minute,row_number() OVER(ORDER BY minute) pos FROM mart_active_minute WHERE minute >= (SELECT since FROM kpi_policy)
), endpoints AS (
 SELECT hour,(SELECT max(pos) FROM ranked WHERE minute<hour+3600) stop FROM hours WHERE hour IS NOT NULL
)
SELECT hour,'hour' window,NULL span,hour start,hour+3600 end FROM endpoints
UNION ALL SELECT hour,'rolling',s.hours,r.minute,hour+3600 FROM endpoints e CROSS JOIN kpi_span s JOIN ranked r
 ON r.pos=max(1,e.stop-s.hours*60+1);

CREATE TABLE mart_kind_period AS
WITH minutes AS (
 SELECT p.hour,p.window,p.span,coalesce(c.kind,'unknown') kind,coalesce(c.area,'unknown') area,count(*) minutes
 FROM period p JOIN issue_minute m ON m.minute>=p.start AND m.minute<p.end
 LEFT JOIN issue_classification c USING(issue) GROUP BY 1,2,3,4,5
), completions AS (
 SELECT p.hour,p.window,p.span,coalesce(c.kind,'unknown') kind,coalesce(c.area,'unknown') area,count(*) completions
 FROM period p JOIN issue_classification c ON unixepoch(c.closed_at)>=p.start AND unixepoch(c.closed_at)<p.end
 WHERE c.pr IS NOT NULL AND c.ownership='owner' GROUP BY 1,2,3,4,5
), axes AS (
 SELECT p.hour,p.window,p.span,k.kind,a.area FROM period p CROSS JOIN (SELECT kind FROM issue_kind UNION ALL SELECT 'unknown') k
 CROSS JOIN (SELECT 'product' area UNION ALL SELECT 'development' UNION ALL SELECT 'unknown') a
)
SELECT a.hour,a.window,a.span,a.kind,a.area,coalesce(minutes,0) minutes,coalesce(completions,0) completions,
 poisson_lower(coalesce(completions,0)) count_low,poisson_upper(coalesce(completions,0)) count_high
FROM axes a
LEFT JOIN minutes m ON (a.hour,a.window,a.span,a.kind,a.area) IS (m.hour,m.window,m.span,m.kind,m.area)
LEFT JOIN completions c ON (a.hour,a.window,a.span,a.kind,a.area) IS (c.hour,c.window,c.span,c.kind,c.area);

CREATE TABLE mart_kpi AS
WITH totals AS MATERIALIZED (
 SELECT p.*,count(a.minute) active_minutes,coalesce(sum(a.owners),0) issue_minutes,
 coalesce(sum(a.feature_minutes),0) feature_minutes,
 (SELECT count(DISTINCT issue) FROM owner_interval i WHERE julianday(i.start)<julianday(p.start,'unixepoch')
 AND julianday(i.end)>julianday(p.start,'unixepoch')) open_start,
 (SELECT count(DISTINCT issue) FROM owner_interval i WHERE julianday(i.start)<julianday(p.end,'unixepoch')
 AND julianday(i.end)>julianday(p.end,'unixepoch')) open_end
 FROM period p LEFT JOIN mart_active_minute a ON a.minute>=p.start AND a.minute<p.end GROUP BY p.hour,p.window,p.span
), counts AS (
 SELECT k.hour,k.window,k.span,t.target,
 sum(CASE WHEN k.kind='機能' THEN k.completions ELSE 0 END) features,
 sum(k.completions) completions,sum(k.minutes) target_minutes
 FROM mart_kind_period k JOIN kpi_target t ON (t.kind IS NULL OR t.kind=k.kind)
 WHERE k.window='rolling' OR t.target='機能'
 GROUP BY k.hour,k.window,k.span,t.target
)
SELECT p.hour,p.window,p.span,c.target,p.start,p.end,active_minutes,issue_minutes,feature_minutes,features,
 open_start,open_end,completions,target_minutes,completions*60.0/active_minutes throughput,
 issue_minutes*1.0/active_minutes parallelism,feature_minutes*1.0/issue_minutes feature_share,
 target_minutes*1.0/issue_minutes target_share,target_minutes/60.0/completions hours_per_completion,
 poisson_lower(completions)*60/active_minutes throughput_low,poisson_upper(completions)*60/active_minutes throughput_high,
 target_minutes/60.0/poisson_upper(completions) hours_per_completion_low,
 target_minutes/60.0/poisson_lower(completions) hours_per_completion_high
FROM totals p JOIN counts c ON (p.hour,p.window,p.span) IS (c.hour,c.window,c.span);
