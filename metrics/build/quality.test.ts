import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

function model(db: DatabaseSync, path: string) {
  db.exec(readFileSync(new URL("../models/" + path, import.meta.url), "utf8"));
}

void test("quality follows the closing PR and active observation clock", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
 CREATE TABLE mart_record_gap(issue,reason);
 CREATE TABLE issue_classification(issue,pr,merged_at,closed_at,area);
 INSERT INTO issue_classification VALUES (1,11,'2026-01-01','2026-01-01','product'),(2,12,'2026-03-01','2026-03-01','development'),(3,13,'2026-01-01','2026-01-01','product'),(4,14,'2026-01-01','2026-01-01','product');
 CREATE TABLE mart_active_minute(minute);
 WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<1800)
 INSERT INTO mart_active_minute SELECT unixepoch('2026-01-01')+60*i FROM n;
 CREATE TABLE stg_github_comment(issue_or_pr,created_at,markers);
 INSERT INTO stg_github_comment VALUES(11,'2025-12-31','["verdict_pass"]'),(14,'2025-12-31','["verdict_fail"]');
 INSERT INTO issue_classification VALUES(5,15,'2026-01-01','2026-01-01','product'),(6,16,'2026-01-01','2026-01-01','product'); INSERT INTO stg_github_comment VALUES(15,'2025-12-31','["verdict_pass"]'),(16,'2025-12-31','["verdict_pass","verdict_fail"]');
 CREATE TABLE stg_github_issue(number,type,cause,found_at,plan_change,created_at);
 INSERT INTO stg_github_issue VALUES
 (20,'不具合','#1','マージの後',NULL,'2026-01-01'),(21,'不具合','不明','マージの後',NULL,'2026-01-01'),
 (22,'作りの見直し','PR #11','マージの後','はい','2026-01-01'),(23,'不具合','#3','マージの前の検証',NULL,'2026-01-02'),
 (24,'不具合','#4','マージの後',NULL,'2026-02-01'),(25,'不具合','もとからあった','マージの後',NULL,'2026-01-01');
 CREATE TABLE stg_github_comment_block(issue_or_pr,type,cause,found_at,plan_change,created_at);
 INSERT INTO stg_github_comment_block VALUES(26,'作りの見直し','PR #11','マージの後','いいえ','2026-01-02');
 CREATE TABLE issue_change(issue,pr);
 INSERT INTO issue_change VALUES(1,11);
 CREATE TABLE stg_github_issue_timeline(issue,event,created_at);
 INSERT INTO stg_github_issue_timeline VALUES(2,'reopened','2026-02-10');
 CREATE TABLE stg_github_issue_closure(issue,closed_at,pr_numbers,commit_sha);
 INSERT INTO stg_github_issue_closure VALUES(2,'2026-02-01','[10]',NULL);
 CREATE TABLE change(pr,merged_at,merge_commit_sha,created_at);
 INSERT INTO change VALUES(10,'2026-02-01','a','2026-01-30'),(19,'2026-01-04','b','2026-01-03');
 CREATE TABLE verification_decision(issue,pr,round,at,actor,verdict,failed_checks);
 INSERT INTO verification_decision VALUES(1,11,1,1,'x','FAIL','["検査"]'),(1,11,2,2,'y','PASS','[]'),
 (1,19,1,3,'z','PASS','[]'),(3,13,1,1,'u',NULL,NULL),(4,14,1,1,NULL,'PASS','[]');
 `);
  model(db, "marts/09-quality.sql");
  const rows = (sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((r) => Object.values(r));
  assert.deepEqual(
    rows(
      "SELECT issue,first_pass,missing_verifier,rework,escaped,observed,record_pr_rounds FROM mart_quality_issue WHERE issue<=4 ORDER BY issue",
    ),
    [
      [1, 0, 0, 1, 1, 1, 1],
      [2, 0, 1, 0, 1, 0, 0],
      [3, null, 0, 0, 0, 1, 0],
      [4, 1, 0, 0, 0, 1, 0],
    ],
  );
  assert.deepEqual(rows("SELECT disposition FROM quality_discovery ORDER BY report_issue").flat(), [
    "within_window",
    "不明",
    "plan_change",
    "deferred",
    "late",
    "もとからあった",
    "within_window",
  ]);
  assert.deepEqual(
    rows(
      "SELECT failures,denominator,rate FROM mart_failed_check WHERE area='product' AND name='検査'",
    ),
    [[1, 3, 1 / 3]],
  );
  assert.deepEqual(
    rows(
      "SELECT first_pass,legacy_comment,missing_verifier FROM mart_quality_issue WHERE issue>=5 ORDER BY issue",
    ),
    [
      [1, 1, 0],
      [null, 1, 0],
    ],
  );
});

void test("compares equal active windows around clustered improvements and counts distinct CI catches", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
 CREATE TABLE settings(window_minutes); INSERT INTO settings VALUES(3);
 CREATE TABLE issue_classification(issue,pr,merged_at,kind);
 CREATE TABLE stg_github_issue(number,target,type);
 INSERT INTO stg_github_issue(number,target) VALUES(1,'activity.ci'),(2,'activity.ci'),(3,'slot.resource_limit'),(4,'absent'),(5,'操作できる'),(6,'prevention.r2_create_only');
 INSERT INTO issue_classification SELECT number,number+10,datetime(CASE number WHEN 2 THEN 600 WHEN 3 THEN 0 ELSE 540 END,'unixepoch'),'開発の改善' FROM stg_github_issue;
 CREATE TABLE mart_active_minute(minute); INSERT INTO mart_active_minute VALUES(0),(60),(480),(540),(600),(660),(720),(780);
 CREATE TABLE mart_minute(minute,state); INSERT INTO mart_minute SELECT minute,iif(minute<540,'ci','owner_turn') FROM mart_active_minute;
 CREATE TABLE owner_capacity_minute(minute,owners,slots); INSERT INTO owner_capacity_minute SELECT minute,1,2 FROM mart_active_minute;
 CREATE TABLE mart_empty_slot(minute,reason,slots);CREATE TABLE mart_record_gap(issue,reason);
 CREATE TABLE mart_quality_issue(merged_at,first_pass,escaped,rework,observed);
 CREATE TABLE stg_actions_job(id,workflow,run_id,head_sha,run_created_at,head_branch,event);
 INSERT INTO stg_actions_job VALUES(1,'deploy-staging',1,'a',datetime(540,'unixepoch'),'main','push'),(2,'deploy-staging',1,'a',datetime(540,'unixepoch'),'main','push'),(3,'deploy-staging',2,'b',datetime(30,'unixepoch'),'main','push');
 CREATE TABLE stg_actions_step(job_id,name,conclusion);
 INSERT INTO stg_actions_step SELECT id,'Check R2 create-only writes on Cloudflare','failure' FROM stg_actions_job;
 `);
  model(db, "marts/10-improvement.sql");
  const rows = (sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((r) => Object.values(r));
  assert.deepEqual(
    rows(
      "SELECT issues,minutes,before,after,change FROM mart_improvement_effect WHERE target='activity.ci'",
    ),
    [["[1,2]", 3, 1, 0, -1]],
  );
  assert.deepEqual(
    rows("SELECT change FROM mart_improvement_effect WHERE target='slot.resource_limit'"),
    [[null]],
  );
  assert.deepEqual(rows("SELECT issue FROM mart_record_gap"), [[4]]);
  assert.deepEqual(rows("SELECT issue FROM improvement WHERE mode='manual'"), [[5]]);
  assert.deepEqual(rows("SELECT catches,main_runs,main_failures FROM mart_prevention"), [
    [1, 1, 1],
  ]);
});

void test("a numbered comment supplies only an absent thread, while check names may supplement a verdict", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
 CREATE TABLE actor(issue,pr,id,role,created_at);
 INSERT INTO actor VALUES(1,2,'a','verifier',1),(1,2,'b','verifier',2);
 CREATE TABLE stg_t3_thread(id,sha,attempt);
 INSERT INTO stg_t3_thread VALUES('a','x',1),('b','y',2);
 CREATE TABLE stg_t3_message(id,thread_id,role,created_at,verdict,head,decided_at,failed_checks);
 INSERT INTO stg_t3_message VALUES(1,'a','assistant',4,'PASS','x',4,NULL),(2,'a','assistant',5,NULL,'x',NULL,NULL),
 (3,'b','assistant',6,'FAIL','y',6,NULL);
 CREATE TABLE issue_change(issue,pr);INSERT INTO issue_change VALUES(1,2);
 CREATE TABLE stg_github_comment_block(issue_or_pr,head,attempt,verdict,failed_checks,updated_at,comment_id,decided_at);
 INSERT INTO stg_github_comment_block VALUES(2,'x',1,'PASS','[]',7,1,4),(2,'y',2,'FAIL','["差分"]',8,2,5),
 (2,'z',3,'PASS','[]',10,3,9);
 `);
  model(db, "core/02-verification.sql");
  assert.deepEqual(
    db
      .prepare(
        "SELECT round,actor,verdict,at,failed_checks FROM verification_decision ORDER BY round",
      )
      .all()
      .map((r) => Object.values(r)),
    [
      [1, "a", null, 5, null],
      [2, "b", "FAIL", 6, '["差分"]'],
      [3, null, "PASS", 9, "[]"],
    ],
  );
});
