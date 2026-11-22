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
 CREATE VIEW record_policy AS SELECT '2026-11-22T01:04:44.000Z' effective; CREATE TABLE mart_record_gap(issue,reason);
 CREATE TABLE issue_classification(issue,pr,merged_at,closed_at,area);
 INSERT INTO issue_classification VALUES (1,11,'2027-01-01','2027-01-01','product'),(2,12,'2027-03-01','2027-03-01','development'),(3,13,'2027-01-01','2027-01-01','product'),(4,14,'2027-01-01','2027-01-01','product');
 INSERT INTO issue_classification VALUES(27,37,'2027-03-01','2027-03-01','development');
 CREATE TABLE mart_active_minute(minute);
 WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<1800)
 INSERT INTO mart_active_minute SELECT unixepoch('2027-01-01')+60*i FROM n;
 CREATE TABLE stg_github_comment(issue_or_pr,created_at,markers);
 INSERT INTO stg_github_comment VALUES(11,'2026-12-31','["verdict_pass"]'),(14,'2026-12-31','["verdict_fail"]');
 INSERT INTO issue_classification VALUES(5,15,'2027-01-01','2027-01-01','product'),(6,16,'2027-01-01','2027-01-01','product'); INSERT INTO stg_github_comment VALUES(15,'2026-12-31','["verdict_pass"]'),(16,'2026-12-31','["verdict_pass","verdict_fail"]');
 INSERT INTO issue_classification VALUES
 (7,17,'2026-11-18T01:49:38.999Z',NULL,'history'),(8,18,'2026-11-18T01:49:39.000Z',NULL,'history'),
 (9,29,'2027-01-01T00:00:00.000Z',NULL,'window'),(10,30,'2027-01-01T00:00:00.000Z',NULL,'window');
 INSERT INTO stg_github_comment VALUES(29,'2027-01-01T00:00:48.000Z','["verdict_pass"]'),(30,'2027-01-01T00:05:00.001Z','["verdict_pass"]');
 CREATE TABLE stg_github_issue(number,type,cause,found_at,plan_change,created_at);
 INSERT INTO stg_github_issue VALUES
 (20,'製品の不具合','#1','マージの後',NULL,'2027-01-01'),(21,'製品の不具合','不明','マージの後',NULL,'2027-01-01'),
 (22,'製品の作りの見直し','PR #11','マージの後','はい','2027-01-01'),(23,'製品の不具合','#3','マージの前の検証',NULL,'2027-01-02'),
 (24,'製品の不具合','#4','マージの後',NULL,'2027-02-01'),(25,'製品の不具合','もとからあった','マージの後',NULL,'2027-01-01');
 CREATE TABLE stg_github_comment_block(issue_or_pr,type,cause,found_at,plan_change,created_at);
 INSERT INTO stg_github_comment_block VALUES(26,'製品の作りの見直し','PR #11','マージの後','いいえ','2027-01-02');
 INSERT INTO stg_github_issue VALUES(28,'開発の仕組みの不具合','#27','マージの後',NULL,'2027-03-02');
 INSERT INTO stg_github_comment_block VALUES(29,'開発の仕組みの作りの見直し','#27','マージの後','いいえ','2027-03-02');
 CREATE TABLE issue_change(issue,pr);
 INSERT INTO issue_change VALUES(1,11);
 CREATE TABLE stg_github_issue_timeline(issue,event,created_at);
 INSERT INTO stg_github_issue_timeline VALUES(2,'reopened','2027-02-10');
 CREATE TABLE stg_github_issue_closure(issue,closed_at,pr_numbers,commit_sha);
 INSERT INTO stg_github_issue_closure VALUES(2,'2027-02-01','[10]',NULL);
 CREATE TABLE change(pr,merged_at,merge_commit_sha,created_at);
 INSERT INTO change VALUES(10,'2027-02-01','a','2027-01-30'),(19,'2027-01-04','b','2027-01-03');
 CREATE TABLE verification_decision(issue,pr,round,at,actor,verdict,failed_checks);
 INSERT INTO verification_decision VALUES(1,11,1,1,'x','FAIL','["検査"]'),(1,11,2,2,'y','PASS','[]'),
 (1,19,1,3,'z','PASS','[]'),(3,13,1,1,'u',NULL,NULL),(4,14,1,1,NULL,'PASS','[]');
 ALTER TABLE stg_github_issue ADD COLUMN found_by;
 ALTER TABLE stg_github_comment_block ADD COLUMN found_by;
 ALTER TABLE issue_classification ADD COLUMN kind_source;
 CREATE TABLE stg_classification_backfill(issue,kind,cause,found_at,plan_change,found_by);
 INSERT INTO stg_classification_backfill VALUES(28,'開発の仕組みの不具合','#27','マージの後',NULL,'担当');
 INSERT INTO issue_classification(issue,kind_source) VALUES(28,'backfill');
 UPDATE stg_github_issue SET cause=NULL WHERE number=28;
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
  assert.deepEqual(rows("SELECT found_by FROM quality_discovery WHERE report_issue=28"), [
    ["担当"],
  ]);
  assert.deepEqual(
    rows("SELECT reworks,escapes,completed FROM mart_quality WHERE area='development'"),
    [[1, 2, 2]],
  );
  assert.deepEqual(rows("SELECT disposition FROM quality_discovery ORDER BY report_issue").flat(), [
    "within_window",
    "不明",
    "plan_change",
    "deferred",
    "late",
    "もとからあった",
    "within_window",
    "within_window",
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
      "SELECT first_pass,legacy_comment,missing_verifier FROM mart_quality_issue WHERE issue BETWEEN 5 AND 6 ORDER BY issue",
    ),
    [
      [1, 1, 0],
      [null, 1, 0],
    ],
  );
  assert.deepEqual(
    rows(
      "SELECT first_pass,missing_verifier FROM mart_quality_issue WHERE area='window' ORDER BY issue",
    ),
    [
      [1, 0],
      [0, 1],
    ],
  );
  assert.deepEqual(
    rows(
      "SELECT completed,first_denominator,pre_verification,missing_verifiers,missing_first_verdicts FROM mart_quality WHERE area='history'",
    ),
    [[2, 1, 1, 1, 0]],
  );
  assert.deepEqual(rows("SELECT issue,reason FROM mart_record_gap WHERE issue IN (7,8)"), []);
});

void test("compares equal active windows around clustered improvements, samples approval waits and counts distinct CI catches", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
 CREATE VIEW record_policy AS SELECT '1970-01-01' effective; CREATE TABLE settings(window_minutes); INSERT INTO settings VALUES(3);
 CREATE TABLE issue_classification(issue,pr,merged_at,kind);
 CREATE TABLE stg_github_issue(number,target,type);
 INSERT INTO stg_github_issue(number,target) VALUES(1,'activity.ci'),(2,'activity.ci'),(3,'slot.resource_limit'),(4,'absent'),(5,'操作できる'),(6,'prevention.r2_create_only'),
 (9,'approval.wait'),(10,'quality.first_pass'),(11,'slot.awaiting_dispatch');
 INSERT INTO issue_classification SELECT number,number+10,datetime(CASE number WHEN 2 THEN 600 WHEN 3 THEN 0 ELSE 540 END,'unixepoch'),'開発の仕組みの改善' FROM stg_github_issue;
 INSERT INTO stg_github_issue VALUES(7,'activity.ci','開発の仕組みの改善'),(8,'activity.ci','開発の仕組みの改善');
 INSERT INTO issue_classification VALUES(7,17,NULL,NULL),(8,18,NULL,'開発の仕組みの不具合');
 CREATE TABLE mart_active_minute(minute); INSERT INTO mart_active_minute VALUES(0),(60),(420),(480),(540),(600),(660),(720),(780),(840),(900);
 CREATE TABLE mart_minute(issue,minute,at,state); INSERT INTO mart_minute SELECT 20,minute,minute+10,iif(minute<540,'ci','owner_turn') FROM mart_active_minute;
 INSERT INTO mart_minute VALUES(21,420,430,'ci'),(21,900,910,'owner_turn');
 CREATE TABLE owner_capacity_minute(minute,owners,slots); INSERT INTO owner_capacity_minute SELECT minute,iif(minute IN (420,900),2,1),iif(minute<540,2,NULL) FROM mart_active_minute;
 CREATE TABLE owner_interval(issue,id,start,end);
 INSERT INTO owner_interval VALUES(20,'o',0,960),(21,'other',0,960),
 (22,'owner-a',1200,1380),(22,'owner-b',1380,1560),(22,'owner-c',1620,1680);
 CREATE TABLE actor(id,role,created_at);
 INSERT INTO actor VALUES('o','owner',0),('v','verifier',0),('i','implementer',0),('a','advisor',0),('other','owner',0),
 ('owner-a','owner',1200),('verifier-a','verifier',1210),('owner-b','owner',1380),('verifier-b','verifier',1390),('owner-c','owner',1620);
 CREATE TABLE span(actor,kind,start,end);
 INSERT INTO span VALUES('o','owner_turn',0,20),('v','verifier_run',0,20),
 ('o','owner_turn',420,490),('o','owner_turn',540,560),('o','owner_turn',670,680),('o','owner_turn',705,710),('o','owner_turn',840,NULL);
 CREATE TABLE mart_turn_detail(issue,actor,kind,start,end);
 INSERT INTO mart_turn_detail VALUES
 (20,'o','approval',10,20),(20,'v','approval',5,15),
 (20,'o','approval',61,68),
 (20,'o','approval',430,NULL),(20,'o','approval',605,NULL),
 (20,'o','approval',700,760),
 (20,'i','approval',780,800),(20,'a','approval',780,800),(20,'o','tool',780,800),
 (21,'other','approval',780,NULL),(20,'o','approval',850,NULL);
 INSERT INTO span VALUES('owner-a','owner_turn',1200,NULL);
 INSERT INTO mart_turn_detail VALUES
 (22,'owner-a','approval',1205,NULL),(22,'verifier-a','approval',1215,NULL),(22,'owner-a','approval',1225,1420),
 (22,'owner-a','approval',1380,NULL),(22,'verifier-a','approval',1385,1500),(22,'verifier-b','approval',1445,1460),
 (22,'owner-b','approval',1570,NULL);
 INSERT INTO mart_minute VALUES(22,1260,1270,'owner_turn'),(22,1380,1390,'owner_turn'),(22,1440,1450,'owner_turn'),
 (22,1500,1510,'owner_turn'),(22,1620,1630,'owner_turn');
 CREATE TABLE mart_empty_slot(minute,reason,slots);CREATE TABLE mart_record_gap(issue,reason);
 CREATE TABLE mart_quality_issue(merged_at,first_pass,escaped,rework,observed);
 INSERT INTO mart_quality_issue VALUES(datetime(480,'unixepoch'),1,0,0,1),(datetime(600,'unixepoch'),0,0,0,1);
 INSERT INTO mart_empty_slot VALUES(420,'awaiting_dispatch',2);
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
  const hits = (minute: number) =>
    db
      .prepare("SELECT hits FROM target_sample WHERE target='approval.wait' AND minute=?")
      .get(minute)?.hits ?? 0;
  assert.deepEqual(
    rows("SELECT start,end FROM approval_wait WHERE issue=22 ORDER BY start"),
    [
      [1205, 1380],
      [1215, 1380],
      [1225, 1380],
      [1445, 1460],
    ],
    "waits stop at the requester's owner interval end and requests raised outside it are dropped",
  );
  assert.equal(hits(1260), 1, "an open request counts inside its owner's interval");
  assert.equal(
    hits(1380),
    0,
    "requests from a replaced owner's era do not count in the next owner's minutes",
  );
  assert.equal(
    hits(1440),
    1,
    "a verifier created during the next owner counts in that owner's minutes",
  );
  assert.equal(
    hits(1500),
    0,
    "a replaced owner's verifier request raised after the handover does not count",
  );
  assert.equal(hits(1620), 0, "a request raised between owner intervals does not count");
  assert.equal(hits(0), 1, "overlapping owner and verifier requests count once at the sample");
  assert.equal(hits(60), 0, "a request between samples does not count");
  assert.equal(hits(420), 1, "an interrupted request counts during its turn");
  assert.equal(hits(480), 0, "an interrupted request ends at the containing turn end");
  assert.equal(hits(540), 0, "an interrupted request does not resume in a later turn");
  assert.equal(hits(600), 1, "an unanswered background request waits for the next turn");
  assert.equal(hits(660), 0, "an unanswered background request ends at the next turn start");
  assert.equal(hits(720), 1, "an answered background request counts outside turns");
  assert.equal(hits(780), 0, "child roles, tools and issues without a sample do not count");
  assert.equal(hits(840), 1, "an unanswered request in a running turn stays open");
  assert.equal(hits(900), 2, "both waiting issues count when neither has a later boundary");
  assert.deepEqual(rows("SELECT mode FROM improvement WHERE issue=9"), [["compare"]]);
  assert.deepEqual(rows("SELECT issue FROM mart_record_gap WHERE issue=9"), []);
  assert.deepEqual(
    rows(
      "SELECT before,after,before_denominator,after_denominator FROM mart_improvement_effect WHERE target='approval.wait'",
    ),
    [[1 / 4, 1 / 3, 4, 3]],
  );
  assert.deepEqual(
    rows("SELECT before,after FROM mart_improvement_effect WHERE target='quality.first_pass'"),
    [[1, 0]],
  );
  assert.deepEqual(
    rows(
      "SELECT before,before_denominator FROM mart_improvement_effect WHERE target='slot.awaiting_dispatch'",
    ),
    [[2 / 10, 10]],
  );
  assert.deepEqual(
    rows(
      "SELECT hits,total FROM improvement_observation WHERE target='slot.awaiting_dispatch' AND side='after'",
    ),
    [[null, null]],
  );
  assert.deepEqual(rows("SELECT issue FROM improvement WHERE issue IN (7,8)"), []);
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
