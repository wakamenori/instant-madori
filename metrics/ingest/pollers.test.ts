import assert from "node:assert/strict";
import { test } from "node:test";
import { commentRecord, issueRecord, prRecord } from "./github.ts";
import { messageDecision, threadTitle } from "./polled.ts";
void test("pollers retain issue references, notification markers and verifier decisions", () => {
  const at = "2026-11-20T15:08:20Z";
  const pr = prRecord(
    {
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
    },
    [],
  );
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
  assert.equal(messageDecision("検証 #391 @ abcd", "assistant", "PASS").verdict, "PASS");
  assert.equal(messageDecision("#313 implementation", "assistant", "PASS").verdict, null);
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

void test("GitHub fields come only from the leading YAML and the shared resources section", () => {
  const yaml = (lines: string) => "```yaml\n" + lines + "\n```";
  const findings =
    "type: 作りの見直し\nfound_at: マージの後\nfound_by: 担当\ncause: '#123'\nplan_change: いいえ";
  const body =
    yaml(findings) + "\n## 使う共有資源\n<!-- pnpm dev -->\nstaging を占有する\n## 依存\nなし";
  const issue = issueRecord(
    {
      number: 1,
      title: "fixture",
      created_at: "2026-11-20",
      closed_at: null,
      state: "open",
      milestone: null,
      labels: [],
      body,
    },
    [],
  );
  assert.deepEqual(issue.payload.shared_resources, ["staging を占有する"]);
  assert.deepEqual(issue.payload.fields, {
    type: "作りの見直し",
    found_at: "マージの後",
    found_by: "担当",
    cause: "#123",
    plan_change: "いいえ",
  });
  const input = {
    id: 11,
    created_at: "2026-11-20",
    updated_at: "2026-11-21",
    issue_url: "issues/1",
    user: { login: "fixture" },
  };
  const comment = (body: string) => commentRecord({ ...input, body });
  assert.deepEqual(comment(yaml(findings)).payload.fields, [issue.payload.fields]);
  assert.deepEqual(comment("## 検証役の判定：PASS\n前回の FAIL").payload.markers, ["verdict_pass"]);
  const fields =
    "head: " +
    "a".repeat(40) +
    "\nverdict: FAIL\ndecided_at: 2026-11-20T02:00:00Z\nfailed_checks: [地図]";
  const c = comment(yaml("attempt: 2\n" + fields) + "\nPASS SECRET");
  assert.deepEqual(c.payload.markers, []);
  assert.equal(c.naturalKey, "11");
  assert.deepEqual(c.payload.fields, [
    {
      attempt: 2,
      head: "a".repeat(40),
      verdict: "FAIL",
      decided_at: "2026-11-20T02:00:00.000Z",
      failed_checks: ["地図"],
    },
  ]);
  assert.deepEqual(
    comment(yaml("started_at: 2026-11-20T01:00:00Z\nended_at: 2026-11-20T03:00:00Z")).payload
      .fields,
    [{ started_at: "2026-11-20T01:00:00.000Z", ended_at: "2026-11-20T03:00:00.000Z" }],
  );
  assert.deepEqual(comment(yaml("verdict: [") + "\nPASS").payload.fields, [null]);
  assert.doesNotMatch(JSON.stringify([issue, c]), /PRIVATE|SECRET/u);
  const title = "PR #416（#381）の検証（2回目）";
  assert.deepEqual(threadTitle(title), {
    title_kind: "verifier",
    issue: 381,
    pr: 416,
    sha: null,
    attempt: 2,
  });
  assert.equal(messageDecision(title, "assistant", yaml(fields)).verdict, "FAIL");
});
