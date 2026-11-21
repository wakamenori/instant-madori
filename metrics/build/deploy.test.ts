import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

void test("matches the first successful rollout by ancestry, including a retry and an exempt PR", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
 CREATE TABLE main_commit(sha,position);
 INSERT INTO main_commit VALUES('a',1),('b',2),('c',3),('d',4);
 CREATE TABLE change(pr,merge_commit_sha,merged_at);
 INSERT INTO change VALUES(1,'a',1),(2,'b',2),(3,'c',3),(4,'d',4),(5,'unknown',5);
 CREATE TABLE stg_github_pr(number,files_complete);
 INSERT INTO stg_github_pr VALUES(1,1),(2,1),(3,1),(4,1),(5,0);
 CREATE TABLE stg_github_pr_file(pr,filename,previous_filename);
 INSERT INTO stg_github_pr_file VALUES(1,'apps/a',NULL),(2,'docs/b',NULL),(3,'docs/c','apps/c'),(4,'apps/d',NULL);
 CREATE TABLE stg_actions_attempt(workflow,run_id,run_attempt,head_sha,started_at,updated_at,status,conclusion);
 INSERT INTO stg_actions_attempt VALUES
 ('deploy-staging',1,1,'a',3,4,'completed','cancelled'),
 ('deploy-staging',2,1,'c',5,6,'completed','failure'),
 ('deploy-staging',2,2,'c',7,8,'completed','success'),
 ('deploy-staging',3,1,'d',9,10,'completed','skipped'),
 ('deploy-staging',4,1,'foreign',11,12,'completed','success');
 `);
  db.exec(readFileSync(join(import.meta.dirname, "../models/core/02-deploy.sql"), "utf8"));
  const rows = db
    .prepare("SELECT pr,run_attempt,method,delivered FROM deployment_delivery ORDER BY pr")
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { pr: 1, run_attempt: 2, method: "later_commit", delivered: 8 },
    { pr: 3, run_attempt: 2, method: "direct", delivered: 8 },
  ]);
  assert.deepEqual(
    db
      .prepare("SELECT deployable FROM deploy_scope ORDER BY pr")
      .all()
      .map((r) => r.deployable),
    [1, 0, 1, 1, null],
  );
});
