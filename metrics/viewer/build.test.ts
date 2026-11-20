import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { registry, type RecordInput } from "../l1/sources.ts";
import { openL1Writer } from "../l1/store.ts";

void test("the viewer CLI publishes the derived snapshot and preserves it on schema drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-viewer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const start = "2026-11-01T08:00:00.000Z";
  const end = "2026-11-01T08:12:00.000Z";
  const l1 = openL1Writer(join(root, "metrics.sqlite"), registry);
  function add(source: RecordInput["source"], key: string, payload: RecordInput["payload"]) {
    l1.ingest(
      [
        {
          source,
          naturalKey: key,
          sourceVersion: "1",
          occurredAt: start,
          scope: { kind: "repo" },
          payload,
        },
      ],
      end,
    );
  }
  try {
    add("github.issue", "41", { number: 41, title: "Fixture issue", created_at: start });
    for (const issue of [41, 42])
      add("t3.thread", "owner-" + issue, { issue, title_kind: "owner", created_at: start });
    add("github.pr", "52", { number: 52, closes: [41], created_at: start, merged_at: end });
    add("github.actions.job", "99", {
      workflow: "check",
      pr_numbers: [52],
      created_at: start,
      started_at: start,
      completed_at: end,
      steps: [{ name: "verify", started_at: start, completed_at: end }],
    });
    add("github.actions.job", "100", {
      workflow: "check",
      pr_numbers: [],
      created_at: start,
      steps: [],
    });
  } finally {
    l1.close();
  }
  const options = { env: { ...process.env, INSTANT_MADORI_METRICS_HOME: root } };
  const viewer = join(import.meta.dirname, "build.ts");
  execFileSync(process.execPath, [join(import.meta.dirname, "../build/build.ts")], options);
  execFileSync(process.execPath, [viewer], options);
  const output = join(root, "dashboard.html");
  const html = readFileSync(output, "utf8");
  for (const panel of [
    "主要指標",
    "Issueごとの待ち時間",
    "checkの順番待ちと実行時間",
    "runnerの時間別稼働率",
    "マージ待ちの推定理由",
    "活動中の担当数",
    "Issueと活動履歴",
    "計測元の状態",
  ])
    assert.ok(html.includes("<h2>" + panel + "</h2>"), panel);
  for (const issue of [41, 42]) assert.ok(html.includes("#" + issue + "</button>"));
  assert.ok(html.includes('"steps":[{"name":"verify","minutes":'));
  assert.ok(html.includes('"range_start":"' + start + '"'));
  assert.ok(html.includes('"range_end":"' + end + '"'));
  const custom = join(root, "morning.html");
  execFileSync(process.execPath, [viewer, "--out", custom], options);
  assert.match(readFileSync(custom, "utf8"), /Fixture issue/u);

  const derived = new DatabaseSync(join(root, "metrics-derived.sqlite"));
  try {
    derived.exec("UPDATE mart_ci_job SET steps='broken'");
  } finally {
    derived.close();
  }
  const failed = spawnSync(process.execPath, [viewer], { ...options, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /mart_ci_job[\s\S]*steps/u);
  assert.equal(readFileSync(output, "utf8"), html);
});
