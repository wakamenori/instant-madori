CREATE TABLE issue_kind(kind TEXT PRIMARY KEY,label TEXT UNIQUE NOT NULL,area TEXT);
INSERT INTO issue_kind VALUES
 ('機能','機能：利用者に見える振る舞いを足す・変える','product'),
 ('製品の不具合','製品の不具合：約束どおりに動かない製品を直す','product'),
 ('製品の作りの見直し','製品の作りの見直し：振る舞いを変えずに作りを変える','product'),
 ('開発の仕組みの改善','開発の仕組みの改善：作る・確かめる・届ける・動かす仕組みを良くする','development'),
 ('開発の仕組みの不具合','開発の仕組みの不具合：約束どおりに動かない仕組みを直す','development'),
 ('開発の仕組みの作りの見直し','開発の仕組みの作りの見直し：振る舞いを変えずに作りを変える','development'),
 ('外の変化への追従','外の変化への追従：依存・脆弱性・外のツールの変化に合わせる',NULL),
 ('確かめと判断','確かめと判断：試作・計測・受け入れ・計画づくりで知る・決める',NULL);

CREATE TABLE issue_classification AS
WITH kinds AS (
 SELECT c.issue,k.kind FROM final_closure c,json_each(c.labels) l JOIN issue_kind k
 ON l.value=k.label
), facts AS (
 SELECT w.issue,c.pr,c.closed_at,c.merged_at,(SELECT count(*) FROM kinds k WHERE k.issue=w.issue) n,
 (SELECT kind FROM kinds k WHERE k.issue=w.issue LIMIT 1) kind,bk.kind backfill,
 CASE WHEN EXISTS(SELECT 1 FROM owner o WHERE o.issue=w.issue) THEN 'owner'
 WHEN c.pr IS NULL THEN NULL
 WHEN c.creator_type='Bot' THEN 'bypass'
 WHEN c.head_ref IN ('t3/issue-'||w.issue,'issue-'||w.issue) OR c.head_ref LIKE 't3/issue-'||w.issue||'-%' OR c.head_ref LIKE 'issue-'||w.issue||'-%' THEN 'missing_owner'
 ELSE 'bypass' END ownership
 FROM work_item w LEFT JOIN final_closure c USING(issue) LEFT JOIN (SELECT payload->>'$.issue' issue,payload->>'$.kind' kind FROM staging_record WHERE source='classification.backfill' AND valid_to IS NULL) b USING(issue) LEFT JOIN issue_kind bk ON bk.kind=b.kind
), classified AS (
SELECT issue,pr,closed_at,merged_at,ownership,n label_count,
 CASE n WHEN 1 THEN kind WHEN 0 THEN iif(closed_at IS NOT NULL,backfill,NULL) END kind,
 CASE WHEN n=1 THEN 'closure' WHEN n=0 AND closed_at IS NOT NULL AND backfill IS NOT NULL THEN 'backfill' END kind_source
FROM facts
) SELECT c.*,k.area FROM classified c LEFT JOIN issue_kind k USING(kind);
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
