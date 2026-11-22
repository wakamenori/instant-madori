CREATE TABLE improvement_target(id TEXT PRIMARY KEY,name TEXT,definition TEXT,unit TEXT,direction TEXT,version INTEGER);
WITH states(state,name) AS (VALUES ('post_merge','マージ後の確認'),('verifier','検証'),('owner_turn','担当の作業'),('implementer','実装役の作業'),
 ('check_wait','checkの待ち'),('ci','CI'),('staging_occupied','stagingの占有'),('deploy_running','デプロイの実行中'),
 ('coordinator_busy','指揮役がほかの仕事中'),('coordinator_asleep','指揮役が起きていない'),('owner_wait','担当の待ち'),('unknown','不明'))
INSERT INTO improvement_target SELECT 'activity.'||state,name,name||'の分数 ÷ 延べ時間','割合','down',1 FROM states;
WITH reasons(reason,name) AS (VALUES ('no_ready_issue','着手できるIssueが無い'),('resource_limit','資源の枠で選べない'),('awaiting_dispatch','指揮役がまだ立てていない'))
INSERT INTO improvement_target SELECT 'slot.'||reason,name,name||'の枠・分 ÷ 全枠・分','割合','down',1 FROM reasons;
INSERT INTO improvement_target VALUES
 ('approval.wait','承認待ち','担当と検証役が承認の要求で止まっていた分数 ÷ 延べ時間','割合','down',1),
 ('quality.first_pass','一度で合格','最初の検証で合格 ÷ 判定可能な完了Issue','割合','up',1),
 ('quality.rework','作りの見直し','観察を終えた原因Issueのうち見直しあり','割合','down',1),
 ('quality.escape','不具合漏れ','観察を終えた原因Issueのうち漏れあり','割合','down',1),
 ('prevention.uncommitted_fixes','自動修正の入れ忘れ','checkのgit diff検査が失敗したrunとheadの組数','件','up',1),
 ('prevention.r2_create_only','R2の上書き防止','deploy-stagingの専用stepが失敗したrunとheadの組数','件','up',1);

CREATE TABLE improvement AS
SELECT c.issue,c.merged_at,i.target,CASE WHEN t.id LIKE 'prevention.%' THEN 'prevention'
 WHEN t.id IS NOT NULL THEN 'compare' WHEN i.target GLOB '*[^a-zA-Z0-9._-]*' THEN 'manual' ELSE 'unknown_target' END mode,
 (SELECT count(*) FROM mart_active_minute WHERE minute<unixepoch(c.merged_at)) pos
FROM issue_classification c JOIN stg_github_issue i ON i.number=c.issue LEFT JOIN improvement_target t ON t.id=i.target
WHERE c.kind='開発の仕組みの改善';
INSERT INTO mart_record_gap SELECT issue,mode FROM improvement WHERE mode='unknown_target';

CREATE TABLE active_clock AS SELECT minute,row_number() OVER(ORDER BY minute) pos FROM mart_active_minute;
CREATE UNIQUE INDEX clock_minute ON active_clock(minute);
CREATE TABLE improvement_window AS
WITH adjacent AS (
 SELECT *,lag(pos) OVER(PARTITION BY target ORDER BY pos,issue) prev FROM improvement WHERE mode='compare' AND merged_at IS NOT NULL
), grouped AS (
 SELECT *,sum(prev IS NULL OR pos-prev>=(SELECT window_minutes FROM settings)) OVER(PARTITION BY target ORDER BY pos,issue) grp FROM adjacent
)
SELECT target,grp,json_group_array(issue ORDER BY pos,issue) issues,min(merged_at) first_merge,max(merged_at) last_merge,min(pos) first,max(pos) last,
 min((SELECT window_minutes FROM settings),min(pos),(SELECT count(*) FROM active_clock)-max(pos)) minutes
FROM grouped GROUP BY target,grp;

CREATE TABLE approval_wait AS
SELECT d.issue,d.start,coalesce(d.end,(SELECT min(iif(s.start<=d.start,s.end,s.start)) FROM span s
 WHERE s.actor=d.actor AND coalesce(s.end,'9999')>d.start),'9999') end
FROM mart_turn_detail d JOIN actor a ON a.id=d.actor
WHERE d.kind='approval' AND a.role IN ('owner','verifier');

CREATE TABLE target_sample AS
SELECT 'activity.'||state target,minute,count(*) hits FROM mart_minute GROUP BY state,minute
UNION ALL SELECT 'slot.'||reason,minute,slots FROM mart_empty_slot
UNION ALL SELECT 'approval.wait',m.minute,count(DISTINCT m.issue) FROM mart_minute m
JOIN approval_wait w ON w.issue=m.issue AND w.start<=m.at AND w.end>m.at GROUP BY m.minute;
CREATE INDEX target_sample_lookup ON target_sample(target,minute);
CREATE TABLE improvement_observation AS
WITH sides(side) AS (VALUES ('before'),('after')), windows AS (
 SELECT w.*,side,CASE side WHEN 'before' THEN first-minutes ELSE last END start FROM improvement_window w CROSS JOIN sides
), minute_values AS (
 SELECT w.target,w.grp,w.side,sum(coalesce(s.hits,0)) hits,
 sum(iif(w.target LIKE 'slot.%',a.owners+a.slots,a.owners)) total
 FROM windows w JOIN active_clock k ON k.pos>w.start AND k.pos<=w.start+w.minutes
 JOIN owner_capacity_minute a USING(minute) LEFT JOIN target_sample s ON s.target=w.target AND s.minute=k.minute
 WHERE w.target NOT LIKE 'quality.%' AND (w.target NOT LIKE 'slot.%' OR a.slots IS NOT NULL) GROUP BY 1,2,3
), quality_values AS (
 SELECT w.target,w.grp,w.side,sum(CASE w.target WHEN 'quality.first_pass' THEN q.first_pass WHEN 'quality.escape' THEN q.escaped ELSE q.rework END) hits,
 count(*) total FROM windows w JOIN mart_quality_issue q ON w.target LIKE 'quality.%'
 JOIN active_clock k ON k.minute=(SELECT max(minute) FROM active_clock WHERE minute<=unixepoch(q.merged_at))
 AND k.pos>w.start AND k.pos<=w.start+w.minutes
 WHERE ((w.side='before' AND q.merged_at<w.first_merge) OR (w.side='after' AND q.merged_at>w.last_merge))
 AND CASE WHEN w.target='quality.first_pass' THEN q.first_pass IS NOT NULL ELSE q.observed END
 GROUP BY 1,2,3
), samples AS (SELECT * FROM minute_values UNION ALL SELECT * FROM quality_values),
rates AS (SELECT w.*,s.hits,s.total,1.0*s.hits/s.total rate FROM windows w LEFT JOIN samples s USING(target,grp,side))
SELECT *, (rate+1.9208/total-1.96*sqrt(rate*(1-rate)/total+0.9604/(total*total)))/(1+3.8416/total) low,
 (rate+1.9208/total+1.96*sqrt(rate*(1-rate)/total+0.9604/(total*total)))/(1+3.8416/total) high FROM rates;

CREATE VIEW mart_improvement_effect AS
SELECT b.target,b.issues,b.minutes,b.rate before,a.rate after,a.rate-b.rate change,a.low-b.high change_low,a.high-b.low change_high,
 b.total before_denominator,a.total after_denominator FROM improvement_observation b JOIN improvement_observation a USING(target,grp)
WHERE b.side='before' AND a.side='after';

CREATE TABLE prevention_signal(target TEXT PRIMARY KEY,workflow TEXT,step TEXT);
INSERT INTO prevention_signal VALUES ('prevention.uncommitted_fixes','check','Run git diff --exit-code'),('prevention.r2_create_only','deploy-staging','Check R2 create-only writes on Cloudflare');
CREATE TABLE prevention_run AS
SELECT i.target,i.issue,j.run_id,j.head_sha,min(j.run_created_at) started_at,
 max(j.head_branch='main' AND j.event IN ('push','workflow_dispatch')) on_main,
 max(e.conclusion='failure') caught
FROM improvement i JOIN prevention_signal s USING(target)
JOIN stg_actions_job j ON j.workflow=s.workflow JOIN stg_actions_step e ON e.job_id=j.id AND e.name=s.step
WHERE e.conclusion IN ('success','failure') AND julianday(j.run_created_at)>=julianday(i.merged_at)
AND NOT EXISTS(SELECT 1 FROM improvement later WHERE later.target=i.target AND later.merged_at>i.merged_at AND julianday(later.merged_at)<=julianday(j.run_created_at))
GROUP BY i.target,i.issue,j.run_id,j.head_sha;

CREATE VIEW mart_prevention_catch AS SELECT * FROM prevention_run WHERE caught;
CREATE VIEW mart_prevention AS SELECT i.issue,i.target,count(r.run_id) checked_runs,
 sum(r.caught) catches,count(r.run_id) FILTER(WHERE on_main) main_runs,
 sum(r.caught) FILTER(WHERE on_main) main_failures,min(r.started_at) first_run,max(r.started_at) last_run FROM improvement i
LEFT JOIN prevention_run r USING(issue,target) WHERE mode='prevention' AND i.merged_at IS NOT NULL GROUP BY i.issue,i.target;
