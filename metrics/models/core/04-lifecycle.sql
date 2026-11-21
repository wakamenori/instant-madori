CREATE TABLE issue_kind(kind TEXT PRIMARY KEY);
INSERT INTO issue_kind VALUES ('機能'),('不具合'),('作りの見直し'),('外部への追従'),('開発の改善'),('確かめと判断');

CREATE TABLE issue_classification AS
WITH kinds AS (
 SELECT c.issue,k.kind FROM final_closure c,json_each(c.labels) l JOIN issue_kind k
 ON l.value=k.kind OR l.value LIKE k.kind||'：%'
), facts AS (
 SELECT w.issue,c.pr,c.closed_at,c.merged_at,(SELECT count(*) FROM kinds k WHERE k.issue=w.issue) n,
 (SELECT kind FROM kinds k WHERE k.issue=w.issue LIMIT 1) kind,b.kind backfill,
 CASE WHEN EXISTS(SELECT 1 FROM owner o WHERE o.issue=w.issue) THEN 'owner'
 WHEN c.pr IS NULL THEN NULL
 WHEN c.creator_type='Bot' THEN 'bypass'
 WHEN c.head_ref IN ('t3/issue-'||w.issue,'issue-'||w.issue) OR c.head_ref LIKE 't3/issue-'||w.issue||'-%' OR c.head_ref LIKE 'issue-'||w.issue||'-%' THEN 'missing_owner'
 ELSE 'bypass' END ownership,
 CASE WHEN EXISTS(SELECT 1 FROM stg_github_pr_file f WHERE f.pr=c.pr AND
 (f.filename GLOB 'apps/*' OR f.filename GLOB 'crates/*' OR f.filename GLOB 'packages/*'
 OR f.previous_filename GLOB 'apps/*' OR f.previous_filename GLOB 'crates/*' OR f.previous_filename GLOB 'packages/*')) THEN 'product'
 WHEN c.files_complete THEN 'development' END area
 FROM work_item w LEFT JOIN final_closure c USING(issue) LEFT JOIN backfill_kind b USING(issue)
)
SELECT issue,pr,closed_at,merged_at,ownership,area,n label_count,
 CASE n WHEN 1 THEN kind WHEN 0 THEN iif(closed_at IS NOT NULL,backfill,NULL) END kind,
 CASE WHEN n=1 THEN 'closure' WHEN n=0 AND closed_at IS NOT NULL AND backfill IS NOT NULL THEN 'backfill' END kind_source
FROM facts;
CREATE UNIQUE INDEX classification_issue ON issue_classification(issue);

CREATE TABLE owner_interval AS
WITH turns AS (
 SELECT o.issue,o.id,o.created_at start,lead(o.created_at) OVER(PARTITION BY o.issue ORDER BY o.created_at,o.id) next_start,
 coalesce((SELECT max(coalesce(r.completed_at,(SELECT max(valid_from) FROM staging_record))) FROM stg_t3_run r
 WHERE r.thread_id=o.id AND r.started_at IS NOT NULL),o.created_at) last_turn
 FROM owner o WHERE o.issue IS NOT NULL
)
SELECT t.issue,t.id,t.start,CASE WHEN next_start IS NULL THEN max(last_turn,coalesce(c.merged_at,start))
 ELSE min(last_turn,next_start) END end
FROM turns t LEFT JOIN issue_classification c USING(issue);
CREATE INDEX interval_issue ON owner_interval(issue,start,end);

CREATE TABLE issue_minute AS
WITH RECURSIVE samples(issue,at,end) AS (
 SELECT issue,start,end FROM owner_interval WHERE start<end
 UNION ALL SELECT issue,strftime('%Y-%m-%dT%H:%M:%fZ',at,'+1 minute'),end FROM samples
 WHERE julianday(at,'+1 minute')<julianday(end)
)
SELECT issue,unixepoch(at)/60*60 minute,min(at) at FROM samples GROUP BY issue,minute;
CREATE UNIQUE INDEX minute_issue ON issue_minute(minute,issue);
