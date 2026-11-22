CREATE TABLE quality_discovery AS
WITH reports AS (
 SELECT number report_issue,type,cause,found_at,found_by,plan_change,created_at at FROM stg_github_issue WHERE cause IS NOT NULL
 UNION ALL SELECT issue_or_pr,type,cause,found_at,found_by,plan_change,created_at FROM stg_github_comment_block WHERE cause IS NOT NULL
 UNION ALL SELECT b.issue,b.kind,b.cause,b.found_at,b.found_by,b.plan_change,i.created_at
 FROM stg_classification_backfill b JOIN stg_github_issue i ON i.number=b.issue
 JOIN issue_classification c ON c.issue=b.issue AND c.kind_source='backfill'
 WHERE i.cause IS NULL AND b.cause IS NOT NULL
), causes AS (
 SELECT r.*,c.issue cause_issue,c.merged_at FROM reports r LEFT JOIN issue_classification c ON
 r.cause='#'||c.issue OR EXISTS(SELECT 1 FROM issue_change ic WHERE ic.issue=c.issue AND r.cause='PR #'||ic.pr)
)
SELECT *,CASE WHEN cause IN ('不明','もとからあった','外の変化') THEN cause
 WHEN plan_change='はい' THEN 'plan_change' WHEN found_at='マージの前の検証' THEN 'deferred'
 WHEN merged_at IS NULL OR at<merged_at THEN 'unresolved'
 WHEN (SELECT count(*) FROM mart_active_minute WHERE minute>=unixepoch(merged_at) AND minute<unixepoch(at))<=1800 THEN 'within_window'
 ELSE 'late' END disposition FROM causes;

CREATE TABLE verification_policy(effective TEXT PRIMARY KEY,revision TEXT NOT NULL);
INSERT INTO verification_policy VALUES ('2026-11-18T01:49:39.000Z','faf6af125');

CREATE TABLE mart_quality_issue AS
WITH completed AS (
 SELECT c.*,c.merged_at<(SELECT min(effective) FROM verification_policy) pre_verification
 FROM issue_classification c WHERE c.pr IS NOT NULL
), rounds AS (
 SELECT *,row_number() OVER(PARTITION BY issue,pr ORDER BY round,at,actor) seq FROM verification_decision
), legacy_comments AS (
 SELECT c.issue,count(DISTINCT m.value) verdicts,min(m.value) marker
 FROM completed c JOIN stg_github_comment b ON NOT c.pre_verification AND b.issue_or_pr=c.pr
 AND julianday(b.created_at)<=julianday(c.merged_at,'+5 minutes')
 JOIN json_each(b.markers) m WHERE m.value IN ('verdict_pass','verdict_fail') GROUP BY c.issue
)
SELECT c.issue,c.pr,c.merged_at,coalesce(c.area,'unknown') area,
 c.pre_verification,
 CASE WHEN c.pre_verification THEN NULL
      WHEN d.round=1 THEN d.verdict='PASS'
      WHEN d.round IS NULL AND l.verdicts=1 THEN l.marker='verdict_pass'
      WHEN d.round IS NULL AND l.verdicts IS NULL THEN 0 END first_pass,
 NOT c.pre_verification AND d.round IS NULL AND l.verdicts IS NULL missing_verifier,
 d.round IS NULL AND l.verdicts IS NOT NULL legacy_comment,
 CASE WHEN NOT c.pre_verification AND d.round=1 THEN d.failed_checks END failed_checks,
 (SELECT count(*) FROM mart_active_minute WHERE minute>=unixepoch(c.merged_at))>=1800 observed,
 EXISTS(SELECT 1 FROM quality_discovery q WHERE q.cause_issue=c.issue AND disposition='within_window' AND type IN ('製品の作りの見直し','開発の仕組みの作りの見直し')) rework,
 EXISTS(SELECT 1 FROM quality_discovery q WHERE q.cause_issue=c.issue AND disposition='within_window' AND type IN ('製品の不具合','開発の仕組みの不具合'))
 OR EXISTS(SELECT 1 FROM stg_github_issue_timeline t JOIN stg_github_issue_closure earlier ON earlier.issue=t.issue AND earlier.closed_at<t.created_at
 JOIN change original ON original.merge_commit_sha=earlier.commit_sha OR original.pr IN (SELECT value FROM json_each(earlier.pr_numbers))
 WHERE t.issue=c.issue AND t.event='reopened' AND t.created_at<=c.merged_at AND original.merged_at<t.created_at AND original.pr<>c.pr
 AND (SELECT count(*) FROM mart_active_minute WHERE minute>=unixepoch(original.merged_at) AND minute<unixepoch(t.created_at))<=1800) escaped,
 (SELECT count(*) FROM verification_decision v JOIN change p USING(pr)
 WHERE v.issue=c.issue AND v.pr<>c.pr AND p.created_at>=c.closed_at) record_pr_rounds
FROM completed c LEFT JOIN legacy_comments l USING(issue) LEFT JOIN rounds d ON d.issue=c.issue AND d.pr=c.pr AND d.seq=1;

CREATE VIEW mart_quality AS
SELECT area,count(*) completed,count(first_pass) first_denominator,sum(first_pass) passed,avg(first_pass) first_pass_rate,
 sum(legacy_comment) legacy_comments,sum(missing_verifier) missing_verifiers,
 sum(pre_verification) pre_verification,
 sum(first_pass IS NULL AND NOT pre_verification) missing_first_verdicts,
 sum(rework) reworks,avg(rework) rework_rate,sum(escaped) escapes,avg(escaped) escape_rate,
 sum(observed) observed,avg(observed) observed_share,sum(record_pr_rounds) record_pr_rounds FROM mart_quality_issue GROUP BY area;

CREATE VIEW mart_failed_check AS
WITH checks(name) AS (VALUES ('検査'),('振る舞い'),('地図'),('差分'),('終わった証拠'))
SELECT area,name,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM json_each(failed_checks) WHERE value=name)) failures,
 count(first_pass) denominator,count(*) FILTER(WHERE first_pass=0 AND missing_verifier=0 AND failed_checks IS NULL) unknown_checks,
 count(*) FILTER(WHERE EXISTS(SELECT 1 FROM json_each(failed_checks) WHERE value=name))*1.0/count(first_pass) rate
FROM mart_quality_issue CROSS JOIN checks GROUP BY area,name;
CREATE VIEW mart_discovery_count AS SELECT coalesce(c.area,'unknown') area,disposition,count(*) records
FROM quality_discovery d LEFT JOIN issue_classification c ON c.issue=d.cause_issue GROUP BY 1,2;

INSERT INTO mart_record_gap SELECT issue,'missing_first_round' FROM mart_quality_issue q WHERE first_pass IS NULL AND NOT pre_verification
AND NOT EXISTS(SELECT 1 FROM verification_decision v WHERE v.issue=q.issue AND v.pr=q.pr AND v.round=1);
INSERT INTO mart_record_gap SELECT issue,'missing_failed_checks' FROM mart_quality_issue
WHERE first_pass=0 AND missing_verifier=0 AND failed_checks IS NULL;

INSERT INTO mart_record_gap SELECT issue,'undated_comment_verdict' FROM mart_quality_issue WHERE legacy_comment;
INSERT INTO mart_record_gap SELECT issue,'missing_verifier' FROM mart_quality_issue WHERE missing_verifier;

CREATE VIEW mart_quality_interval AS
WITH proportions AS (
 SELECT area,'first_pass' metric,passed hits,first_denominator n FROM mart_quality
 UNION ALL SELECT area,'rework',reworks,completed FROM mart_quality
 UNION ALL SELECT area,'escape',escapes,completed FROM mart_quality
), estimates AS (SELECT *,hits*1.0/n rate FROM proportions)
SELECT *,max(0,(rate+1.9208/n-1.96*sqrt(rate*(1-rate)/n+0.9604/(n*n)))/(1+3.8416/n)) low,
 min(1,(rate+1.9208/n+1.96*sqrt(rate*(1-rate)/n+0.9604/(n*n)))/(1+3.8416/n)) high FROM estimates;
