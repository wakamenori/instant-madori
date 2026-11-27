import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { candidate } from "../ingest/polled.ts";
import { registry } from "../l1/sources.ts";
import { openL1Writer } from "../l1/store.ts";
import { t3Pollers } from "../receiver/t3-pollers.ts";

function approvalFixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "metrics-approval-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "t3.sqlite");
  const t3 = new DatabaseSync(file);
  t.after(() => t3.close());
  t3.exec(`CREATE TABLE projection_projects(project_id,workspace_root);
    CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id);
    CREATE TABLE orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,provider_turn_id,kind,status,created_at,resolved_at,payload_json);
    INSERT INTO projection_projects VALUES ('repo','/repo');
    INSERT INTO orchestration_v2_projection_threads VALUES ('owner','repo');`);
  const at = (seconds: number) =>
    new Date(Date.UTC(2026, 10, 23) + Math.round(seconds * 1000)).toISOString();
  const card = t3.prepare(
    "INSERT INTO orchestration_v2_projection_runtime_requests VALUES(?,'owner','turn',?,'resolved',?,?,?)",
  );
  const poller = t3Pollers(file, "/repo", home).find((p) => p.name === "t3.approval");
  assert.ok(poller);
  return { home, at, card, poller };
}

void test("Claude approval detail follows each T3 card through resolution", async (t) => {
  const { home, at, card, poller } = approvalFixture(t);
  for (const [id, kind, start, end] of [
    ["delegate", "command", 10, 130],
    ["first", "command", 150, 210],
    ["second", "command", 155, 200],
    ["parent", "command", 240, 300],
  ] as const) {
    card.run(
      id,
      kind,
      at(start),
      at(end),
      JSON.stringify({
        nativeRequestRef: { driver: "claudeAgent", nativeId: id },
        decision: "accept",
      }),
    );
  }

  const records = [
    candidate("t3.thread", "owner", at(0), {
      issue: 500,
      title_kind: "owner",
      provider: "claudeAgent",
      created_at: at(0),
    }),
    candidate("t3.run", "turn", at(0), {
      thread_id: "owner",
      started_at: at(0),
      completed_at: at(360),
    }),
    ...(await poller.poll(new AbortController().signal)),
  ];
  function hook(seconds: number, prompt: string, tool: string) {
    records.push(
      candidate("claude.hook", String(seconds), at(seconds), {
        at: at(seconds),
        env: { T3CODE_THREAD_ID: "owner" },
        input: {
          hook_event_name: "PermissionRequest",
          session_id: "session",
          prompt_id: prompt,
          tool_name: tool,
        },
      }),
    );
  }
  function decision(seconds: number, prompt: string, tool: string, id: string, source: string) {
    const attributes = Object.entries({
      "event.name": "tool_decision",
      "session.id": "session",
      "prompt.id": prompt,
      tool_name: tool,
      tool_use_id: id,
      decision: source === "user_reject" ? "reject" : "accept",
      source,
    }).map(([key, stringValue]) => ({ key, value: { stringValue } }));
    records.push(candidate("claude.otel.log", id, at(seconds), { log_record: { attributes } }));
  }
  hook(10, "mcp", "mcp__t3-code__delegate_task");
  decision(130, "mcp", "mcp_tool", "delegate", "user");
  hook(150, "overlap", "Bash");
  hook(155, "overlap", "Bash");
  decision(200, "overlap", "Bash", "second", "user");
  decision(210, "overlap", "Bash", "first", "user");
  hook(240, "subagent", "Bash");
  decision(243, "subagent", "Bash", "child", "config");
  decision(300, "subagent", "Bash", "parent", "user");
  decision(329.92, "self-rejected", "Bash", "rejected", "user_reject");
  hook(330, "self-rejected", "Bash");

  const writer = openL1Writer(join(home, "metrics.sqlite"), registry);
  try {
    writer.ingest(records, at(360));
  } finally {
    writer.close();
  }
  execFileSync(process.execPath, [join(import.meta.dirname, "build.ts")], {
    env: { ...process.env, INSTANT_MADORI_METRICS_HOME: home },
  });
  const db = new DatabaseSync(join(home, "metrics-derived.sqlite"), { readOnly: true });
  t.after(() => db.close());
  const rows = db
    .prepare(
      "SELECT detail,start,end FROM mart_turn_detail WHERE issue=500 AND actor='owner' AND kind='approval' ORDER BY start",
    )
    .all();
  assert.deepEqual(
    rows.map((row) => Object.values(row)),
    [
      ["command", at(10), at(130)],
      ["command", at(150), at(210)],
      ["command", at(155), at(200)],
      ["command", at(240), at(300)],
    ],
    "MCP, overlapping and subagent cards end at their own answers; a self-rejected check has no card",
  );
});

void test("Codex owner approval cards become human waits and hook-only permission requests do not", async (t) => {
  const { home, at, card, poller } = approvalFixture(t);
  const start = at(30);
  const end = at(150);
  const hookAt = at(240);
  card.run(
    "request",
    "command",
    start,
    end,
    JSON.stringify({
      nativeRequestRef: { driver: "codex", nativeId: "request" },
      decision: "accept",
    }),
  );
  const records = [
    candidate("t3.thread", "owner", at(0), {
      provider: "codex",
      title_kind: "owner",
      issue: 560,
      created_at: at(0),
    }),
    candidate("t3.run", "turn", at(0), {
      thread_id: "owner",
      started_at: at(0),
      completed_at: at(300),
    }),
    candidate("t3.codex_link", "session", at(0), {
      conversation_id: "session",
      thread_id: "owner",
    }),
    ...(await poller.poll(new AbortController().signal)),
    candidate("codex.otel.log", "tool-result", at(151), {
      log_record: {
        attributes: Object.entries({
          "session.id": "session",
          "event.name": "codex.tool_result",
          "event.timestamp": at(151),
          tool_name: "exec_command",
          duration_ms: "122000",
        }).map(([key, stringValue]) => ({ key, value: { stringValue } })),
      },
    }),
    candidate("codex.hook", "session/PermissionRequest/request-2", hookAt, {
      at: hookAt,
      input: {
        session_id: "session",
        turn_id: "turn",
        hook_event_name: "PermissionRequest",
        tool_name: "mcp__t3_code__task_status",
      },
    }),
  ];
  const writer = openL1Writer(join(home, "metrics.sqlite"), registry);
  try {
    const counts = writer.ingest(records, at(300));
    assert.equal(counts["codex.hook"]?.appended, 1, "L1 stores the hook-only permission request");
  } finally {
    writer.close();
  }
  execFileSync(process.execPath, [join(import.meta.dirname, "build.ts")], {
    env: { ...process.env, INSTANT_MADORI_METRICS_HOME: home },
  });
  const db = new DatabaseSync(join(home, "metrics-derived.sqlite"), { readOnly: true });
  t.after(() => db.close());
  assert.deepEqual(
    db
      .prepare(
        `SELECT tier,wait_target,wait_detail,sum(ms) FROM mart_effort_interval
      WHERE issue=560 AND start<? AND end>? GROUP BY tier,wait_target,wait_detail`,
      )
      .all(end, start)
      .map(Object.values),
    [["wait", "human", "approval", 120_000]],
    "The full two minutes the owner spends blocked on the T3 card count as human approval wait",
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT start,end FROM span WHERE actor='owner' AND kind='local_run' AND detail='exec_command'",
      )
      .all()
      .map(Object.values),
    [[end, at(151)]],
    "The owner's command runs from the approval answer to the tool result",
  );
  const duringHook = db
    .prepare("SELECT wait_target FROM mart_effort_interval WHERE issue=560 AND start<=? AND end>?")
    .all(hookAt, hookAt);
  assert.ok(duringHook.length > 0, "The owner effort frame covers the hook-only request");
  assert.ok(
    duringHook.every((row) => row.wait_target !== "human"),
    "A hook-only request adds no human wait",
  );
  assert.deepEqual(
    db
      .prepare("SELECT actor,start,end FROM approval_wait WHERE issue=560")
      .all()
      .map(Object.values),
    [["owner", start, end]],
    "The resolved T3 card is the owner's only approval wait",
  );
});
