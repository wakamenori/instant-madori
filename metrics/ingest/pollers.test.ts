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
