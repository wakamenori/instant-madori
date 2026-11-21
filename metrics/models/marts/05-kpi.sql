CREATE TABLE period AS
WITH RECURSIVE hours(hour,last) AS (
 SELECT min(minute)/3600*3600,max(minute)/3600*3600 FROM (
 SELECT minute FROM mart_active_minute UNION ALL
 SELECT unixepoch(closed_at) FROM issue_classification WHERE ownership='owner' AND pr IS NOT NULL
 )
 UNION ALL SELECT hour+3600,last FROM hours WHERE hour<last
), ranked AS (
 SELECT minute,row_number() OVER(ORDER BY minute) pos FROM mart_active_minute
), endpoints AS (
 SELECT hour,(SELECT max(pos) FROM ranked WHERE minute<hour+3600) stop FROM hours WHERE hour IS NOT NULL
)
SELECT hour,'hour' window,hour start,hour+3600 end FROM endpoints
UNION ALL SELECT hour,'rolling',r.minute,hour+3600 FROM endpoints e JOIN ranked r
 ON r.pos=max(1,e.stop-(SELECT window_minutes FROM settings)+1);

CREATE TABLE mart_kind_period AS
WITH minutes AS (
 SELECT p.hour,p.window,coalesce(c.kind,'unknown') kind,coalesce(c.area,'unknown') area,count(*) minutes
 FROM period p JOIN issue_minute m ON m.minute>=p.start AND m.minute<p.end
 LEFT JOIN issue_classification c USING(issue) GROUP BY 1,2,3,4
), completions AS (
 SELECT p.hour,p.window,coalesce(c.kind,'unknown') kind,coalesce(c.area,'unknown') area,count(*) completions
 FROM period p JOIN issue_classification c ON unixepoch(c.closed_at)>=p.start AND unixepoch(c.closed_at)<p.end
 WHERE c.pr IS NOT NULL AND c.ownership='owner' GROUP BY 1,2,3,4
), axes AS (
 SELECT p.hour,p.window,k.kind,a.area FROM period p CROSS JOIN (SELECT kind FROM issue_kind UNION ALL SELECT 'unknown') k
 CROSS JOIN (SELECT 'product' area UNION ALL SELECT 'development' UNION ALL SELECT 'unknown') a
)
SELECT hour,window,kind,area,coalesce(minutes,0) minutes,coalesce(completions,0) completions,
 poisson_lower(coalesce(completions,0)) count_low,poisson_upper(coalesce(completions,0)) count_high
FROM axes LEFT JOIN minutes USING(hour,window,kind,area) LEFT JOIN completions USING(hour,window,kind,area);

CREATE TABLE mart_kpi AS
WITH totals AS (
 SELECT p.*,count(a.minute) active_minutes,coalesce(sum(owners),0) issue_minutes,coalesce(sum(feature_minutes),0) feature_minutes,
 (SELECT coalesce(sum(completions),0) FROM mart_kind_period k WHERE k.hour=p.hour AND k.window=p.window AND kind='機能') features,
 (SELECT count(DISTINCT issue) FROM owner_interval i WHERE julianday(i.start)<julianday(p.start,'unixepoch')
 AND julianday(i.end)>julianday(p.start,'unixepoch')) open_start,
 (SELECT count(DISTINCT issue) FROM owner_interval i WHERE julianday(i.start)<julianday(p.end,'unixepoch')
 AND julianday(i.end)>julianday(p.end,'unixepoch')) open_end
 FROM period p LEFT JOIN mart_active_minute a ON a.minute>=p.start AND a.minute<p.end GROUP BY p.hour,p.window
)
SELECT *,features*60.0/active_minutes throughput,issue_minutes*1.0/active_minutes parallelism,
 feature_minutes*1.0/issue_minutes feature_share,feature_minutes/60.0/features hours_per_feature,
 poisson_lower(features)*60/active_minutes throughput_low,poisson_upper(features)*60/active_minutes throughput_high,
 feature_minutes/60.0/poisson_upper(features) hours_per_feature_low,
 feature_minutes/60.0/poisson_lower(features) hours_per_feature_high FROM totals;
