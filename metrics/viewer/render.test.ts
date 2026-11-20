import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboard, type DashboardData } from "./render.ts";

const empty: DashboardData = {
  generated_at: "2026-11-20T18:00Z",
  range_start: null,
  range_end: null,
  mart_issue_flow: [],
  mart_issue_wait: [],
  mart_ci_job: [],
  mart_runner_hour: [],
  mart_merge_wait: [],
  mart_wip: [],
  mart_health: [],
  span: [],
};
void test("eight panels in order and one explicit empty state per panel", () => {
  const html = renderDashboard(empty);
  assert.deepEqual(
    Array.from(html.matchAll(/<h2>(.*?)<\/h2>/g), (m) => m[1]),
    [
      "主要指標",
      "Issueごとの待ち時間",
      "checkの順番待ちと実行時間",
      "runnerの時間別稼働率",
      "マージ待ちの推定理由",
      "活動中の担当数",
      "Issueと活動履歴",
      "計測元の状態",
    ],
  );
  assert.equal(html.match(/この期間の記録はありません/g)?.length, 8);
  assert.doesNotMatch(html, /data-marks="/);
});
void test("untrusted text remains text in tables and JSON round-trips", () => {
  const value = '</script><img src=x onerror="x"> & 日本語';
  const data: DashboardData = {
    ...empty,
    mart_health: [
      {
        source: value,
        last_append: null,
        last_poll: null,
        lag_minutes: null,
        held: 0,
        quarantined: 0,
        failed_cycles: 0,
      },
    ],
  };
  const html = renderDashboard(data);
  assert.ok(!html.includes(value));
  assert.ok(html.includes("&lt;/script&gt;&lt;img"));
  const json = html.match(/id="dashboard-data" type="application\/json">(.*?)<\/script>/s)?.[1];
  assert.ok(json);
  assert.deepEqual(JSON.parse(json), data);
});
void test("check chart excludes deploy jobs and shows per-series percentile times", () => {
  const job = {
    created_at: empty.generated_at,
    job_id: 1,
    workflow: "check",
    queue_minutes: 2,
    run_minutes: 10,
    mode: null,
    conclusion: null,
    steps: [],
  };
  const html = renderDashboard({
    ...empty,
    mart_ci_job: [
      job,
      { ...job, job_id: 2, queue_minutes: 4 },
      { ...job, workflow: "deploy-staging", job_id: 3, queue_minutes: 100 },
    ],
  });
  assert.ok(html.includes("順番待ち p50 3分"));
  assert.ok(html.includes("順番待ち p90 3.8分"));
  assert.ok(html.includes("実行 p90 10分"));
});
void test("issue drill-down preserves span times and wait grouping", () => {
  const launch = "2026-11-20T15:00Z",
    merged = "2026-11-20T17:00Z";
  const issue = {
    issue: 42,
    pr: 43,
    title: "<section>活動",
    ready_at: null,
    launch,
    pr_opened: null,
    first_report: null,
    merged,
    deployed: null,
    last_owner_activity: merged,
    verifier_rounds: 1,
    fails: 0,
    check_jobs: 1,
    coordinator_messages: 1,
    owner_wakes: 2,
  };
  const html = renderDashboard({
    ...empty,
    mart_issue_flow: [issue],
    mart_issue_wait: [
      { issue: 42, state: "gap:pr_watch", minutes: 3 },
      { issue: 42, state: "ci_run", minutes: 5 },
    ],
    span: [{ issue: 42, kind: "verifier_run", start: launch, end: merged }],
  });
  assert.ok(html.includes("#42 CIの実行 8分"));
  assert.ok(html.includes('aria-controls="issue-42"'));
  assert.ok(html.includes('id="issue-42" hidden'));
  assert.ok(html.includes("検証役 2026-11-20 15:00 〜 2026-11-20 17:00"));
  assert.ok(html.includes("&lt;section&gt;活動"));
});
