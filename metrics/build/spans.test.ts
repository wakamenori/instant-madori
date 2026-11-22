import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { commentRecord } from "../ingest/github.ts";
import { registry, type RecordInput } from "../l1/sources.ts";
import { openL1Writer } from "../l1/store.ts";

void test("derives measured execution, CI queues and staging occupancy from source records", (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-spans-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const begin = "2026-11-20T15:08:17.000Z";
  const issueBegin = "2026-11-20T15:08:35.000Z";
  const finish = "2026-11-20T16:30:49.000Z";
  const start = "2026-11-22T02:00:00.000Z";
  const end = "2026-11-22T02:15:00.000Z";
  const l1 = openL1Writer(join(root, "metrics.sqlite"), registry);
  function add(source: RecordInput["source"], key: string, payload: RecordInput["payload"]) {
    l1.ingest(
      [
        {
          source,
          naturalKey: key,
          sourceVersion: "1",
          occurredAt: begin,
          scope: { kind: "repo" },
          payload,
        },
      ],
      finish,
    );
  }
  try {
    add("github.issue", "313", { number: 313, title: "Fixture issue", created_at: begin });
    add("github.pr", "391", { number: 391, closes: [313], created_at: begin, merged_at: begin });
    add("t3.thread", "owner", { issue: 313, title_kind: "owner", created_at: begin });
    add("claude.hook", "link", {
      input: { session_id: "claude" },
      env: { T3CODE_THREAD_ID: "owner" },
    });
    add("t3.codex_link", "link", { conversation_id: "codex", thread_id: "owner" });
    let seq = 0;
    function event(
      provider: "claude" | "codex",
      name: string,
      fields: Record<string, string> = {},
    ) {
      const attributes = Object.entries({
        "session.id": provider,
        "event.name": name,
        "event.timestamp": new Date(Date.parse(begin) + ++seq * 1000).toISOString(),
        ...fields,
      }).map(([key, stringValue]) => ({ key, value: { stringValue } }));
      add(provider === "codex" ? "codex.otel.log" : "claude.otel.log", String(seq), {
        log_record: { attributes },
      });
    }
    for (const kind of ["request", "completed", "request", "request", "completed"]) {
      event("codex", kind === "request" ? "codex.websocket_request" : "codex.sse_event", {
        "event.kind": "response.completed",
      });
    }
    for (const name of ["exec", "write_stdin"])
      event("codex", "codex.tool_result", { tool_name: name, duration_ms: "100" });
    for (const command of [
      "until ready; do sleep 5; done",
      "pnpm check",
      "build && sleep 1",
      "git commit -m 'wait until ready'",
    ])
      event("claude", "tool_result", {
        tool_name: "Bash",
        tool_parameters: JSON.stringify({ full_command: command }),
        duration_ms: "100",
      });
    event("claude", "tool_result", { tool_name: "Agent", duration_ms: "100" });
    for (const name of ["t3_background_wait", "request_secret"])
      event("claude", "tool_result", {
        tool_name: "mcp_tool",
        tool_parameters: JSON.stringify({ mcp_server_name: "t3-code", mcp_tool_name: name }),
        duration_ms: "100",
      });
    event("claude", "hook_execution_complete", { duration_ms: "999", total_duration_ms: "250" });
    for (const [id, name, queued, started, completed] of [
      [1, "mode", begin, issueBegin, finish],
      [2, "check", issueBegin, finish, end],
    ] as const)
      add("github.actions.job", String(id), {
        name,
        workflow: "check",
        pr_numbers: [391],
        run_id: 1,
        run_attempt: 1,
        created_at: queued,
        started_at: started,
        completed_at: completed,
      });
    const comment = (id: number, issue: number, at: string, body: string) => {
      const record = commentRecord({
        id,
        issue_url: "issues/" + issue,
        created_at: at,
        body,
        user: { login: "coordinator" },
      });
      add("github.comment", record.naturalKey, record.payload);
    };
    comment(1, 391, begin, "指揮役：staging の占有を始めた。");
    comment(2, 313, issueBegin, "指揮役：staging の占有を始めた。");
    comment(3, 313, finish, "指揮役：staging の占有を終えた。");
    comment(
      7052314562,
      103,
      "2026-11-20T22:37:28Z",
      "使う前に指揮役に占有を頼むこと。指揮役が staging が空いていることを確かめて占有を始めてから使う。",
    );
    comment(4, 41, "2026-11-22T01:04:44Z", "指揮役：staging の占有を始めた。");
    comment(5, 41, start, "```yaml\nstarted_at: " + start + "\n```");
    comment(6, 41, end, "```yaml\nstarted_at: " + start + "\nended_at: " + end + "\n```");
  } finally {
    l1.close();
  }
  execFileSync(process.execPath, [join(import.meta.dirname, "build.ts")], {
    env: { ...process.env, INSTANT_MADORI_METRICS_HOME: root },
  });
  const derived = new DatabaseSync(join(root, "metrics-derived.sqlite"), { readOnly: true });
  try {
    const rows = (sql: string) => derived.prepare(sql).all().map(Object.values);
    assert.deepEqual(
      rows("SELECT kind,start,end FROM span WHERE kind LIKE 'ci_%' ORDER BY kind,start"),
      [
        ["ci_queue", begin, issueBegin],
        ["ci_queue", issueBegin, finish],
        ["ci_run", issueBegin, end],
      ],
    );
    assert.deepEqual(
      rows(
        "SELECT kind,detail FROM span WHERE kind IN ('generation','local_run','decision') ORDER BY end",
      ),
      [
        ["generation", null],
        ["generation", null],
        ["local_run", "waited:write_stdin"],
        ["local_run", "Bash"],
        ["local_run", "Bash"],
        ["local_run", "Bash"],
        ["decision", "t3-code/request_secret"],
        ["local_run", "hook"],
      ],
    );
    assert.deepEqual(
      rows(
        "SELECT round((unixepoch(end,'subsec')-unixepoch(start,'subsec'))*1000) FROM span WHERE detail='hook'",
      ),
      [[250]],
    );
    const spans = derived
      .prepare("SELECT issue, start, end FROM span WHERE kind = 'staging_occupancy' ORDER BY start")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(spans, [
      { issue: 313, start: issueBegin, end: finish },
      { issue: 41, start, end },
    ]);
  } finally {
    derived.close();
  }
});
