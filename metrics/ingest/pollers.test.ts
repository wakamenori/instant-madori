import assert from "node:assert/strict";
import { test } from "node:test";
import { commentRecord, prRecord } from "./github.ts";
import { messageVerdict, threadTitle } from "./polled.ts";
void test("pollers retain issue references, notification markers and verifier decisions", () => {
  const at = "2026-11-20T15:08:20Z";
  const pr = prRecord({
    number: 391,
    created_at: at,
    closed_at: at,
    state: "closed",
    merged_at: at,
    head: { ref: "t3/issue-313", sha: "abcd" },
    base: { ref: "main" },
    merge_commit_sha: "ef01",
    additions: 1,
    deletions: 0,
    changed_files: 1,
    labels: [],
    body: "Closes #313",
  });
  assert.deepEqual(pr.payload.closes, [313]);
  assert.ok(!("body" in pr.payload));
  const comment = commentRecord({
    id: 1,
    body: "PASS",
    user: { login: "actor" },
    issue_url: "issues/391",
    created_at: at,
  });
  assert.deepEqual(comment.payload.markers, ["verdict_pass"]);
  assert.ok(!("body" in comment.payload));
  assert.deepEqual(threadTitle("#313 implementation"), {
    title_kind: "owner",
    issue: 313,
    pr: null,
    sha: null,
  });
  assert.equal(messageVerdict("検証 #391 @ abcd", "assistant", "PASS"), "PASS");
  assert.equal(messageVerdict("#313 implementation", "assistant", "PASS"), null);
});
void test("comment markers follow the coordinator's staging occupancy wording", () => {
  const markersOf = (body: string) =>
    commentRecord({
      id: 1,
      body,
      user: { login: "actor" },
      issue_url: "issues/41",
      created_at: "2026-11-20T14:10:44Z",
    }).payload.markers;
  assert.deepEqual(
    markersOf("PR #393 をマージした。この Issue の担当の staging の占有を、今から始める。"),
    ["staging_occupy_start"],
  );
  assert.deepEqual(
    markersOf("担当が staging の確認を終えたので、この Issue の担当の staging の占有を終える"),
    ["staging_occupy_end"],
  );
  assert.deepEqual(
    markersOf("指揮役：#313 の担当の staging の占有が終わり、終わっていない deploy-staging は無い"),
    ["staging_occupy_end"],
  );
  assert.deepEqual(
    markersOf("#313 の担当が staging を占有しているので、その占有が終わってからマージする。"),
    [],
  );
});
