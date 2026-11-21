import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

void test("local staging preserves missing decisions, approval history and runner wait correlation", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(
    "ATTACH ':memory:' AS raw; CREATE TABLE raw.l1_record(source,natural_key,ingest_id INTEGER PRIMARY KEY,payload,observed_at,occurred_at)",
  );
  const start = "2026-01-01T00:00:00.000Z",
    end = "2026-01-01T00:01:00.000Z";
  const add = (source: string, id: string, at: string, payload: object) =>
    db
      .prepare("INSERT INTO raw.l1_record VALUES(?,?,NULL,?,?,?)")
      .run(source, id, JSON.stringify(payload), at, at);
  const approval = { thread_id: "t", created_at: start };
  add("t3.approval", "a", start, { ...approval, status: "pending" });
  add("t3.approval", "a", end, {
    ...approval,
    status: "resolved",
    decision: "accept",
    resolved_at: end,
  });
  add("claude.hook", "p", start, {
    at: start,
    input: { hook_event_name: "PermissionRequest", session_id: "s", tool_name: "Bash" },
  });
  add("claude.otel.log", "d", end, {
    log_record: {
      attributes: Object.entries({
        "session.id": "s",
        "event.name": "tool_decision",
        tool_name: "Bash",
        decision: "accept",
      }).map(([key, stringValue]) => ({ key, value: { stringValue } })),
    },
  });
  for (const [phase, at] of [
    ["started", start],
    ["cancelled", end],
  ] as const)
    add("docker.slot", "w/" + phase, at, {
      wait_id: "w",
      pool: "runner",
      run_id: "9",
      run_attempt: "2",
      phase,
      at,
    });
  for (const file of ["00-history", "approval", "docker_slot"])
    db.exec(readFileSync(join(import.meta.dirname, "../models/staging", file + ".sql"), "utf8"));
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT session_id,tool_name,requested_at FROM stg_claude_permission_request")
        .get(),
    },
    { session_id: "s", tool_name: "Bash", requested_at: start },
  );
  assert.deepEqual(
    {
      ...db.prepare("SELECT session_id,tool_use_id,decided_at FROM stg_claude_tool_decision").get(),
    },
    { session_id: "s", tool_use_id: null, decided_at: end },
  );
  assert.deepEqual(
    { ...db.prepare("SELECT decision,resolved_at FROM stg_t3_approval").get() },
    { decision: "accept", resolved_at: end },
  );
  assert.equal(
    db.prepare("SELECT valid_to FROM stg_t3_approval_history WHERE status='pending'").get()
      ?.valid_to,
    end,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT phase,at FROM stg_docker_slot WHERE wait_id='w' AND run_id='9' AND run_attempt='2' ORDER BY at",
      )
      .all()
      .map((r) => [r.phase, r.at]),
    [
      ["started", start],
      ["cancelled", end],
    ],
  );
});
