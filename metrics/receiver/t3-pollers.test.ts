import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { t3Pollers } from "./t3-pollers.ts";

void test("T3 message checkpoints persist only after commit and exclude foreign and streaming messages", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "metrics-t3-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "t3.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE projection_projects(project_id,workspace_root);
 CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title,created_at,updated_at,archived_at,default_provider,payload_json);
 CREATE TABLE orchestration_v2_projection_messages(thread_id,message_id,created_at,updated_at,role,streaming,payload_json);
 INSERT INTO projection_projects VALUES ('repo','/repo'),('other','/other');
 INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title) VALUES ('v','repo','検証 #391 @ abcd'),('v2','repo','PR #416（#381）の検証（2回目）'),('v1','repo','PR #416（#381）の検証'),('f','other','検証 #1 @ ef01');`);
  const insert = db.prepare(
    "INSERT INTO orchestration_v2_projection_messages VALUES(?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','assistant',?,?)",
  );
  for (const [thread, id, streaming] of [
    ["v", "message", 0],
    ["v", "stream", 1],
    ["f", "foreign", 0],
  ] as const)
    insert.run(thread, id, streaming, JSON.stringify({ text: "PASS #391" }));
  insert.run("v2", "new-format", 0, JSON.stringify({ text: "判定：FAIL。前回は PASS" }));
  insert.run("v1", "first-round", 0, JSON.stringify({ text: "FAIL" }));
  db.exec("UPDATE orchestration_v2_projection_threads SET updated_at='2026-01-01T00:00:00Z'");
  db.close();
  for (const source of ["t3.thread", "t3.message"])
    writeFileSync(join(home, source + ".verifier-2.cursor"), "2026-01-02T00:00:00.000Z");
  const threads = t3Pollers(file, "/repo", home).find((p) => p.name === "t3.thread");
  assert.ok(threads);
  const first = (await threads.poll(new AbortController().signal)).find(
    (r) => r.naturalKey === "v1",
  );
  assert.equal(first?.payload.title_kind, "verifier");
  assert.equal(first.payload.issue, 381);
  assert.equal(first.payload.pr, 416);
  const poller = () => {
    const p = t3Pollers(file, "/repo", home).find((p) => p.name === "t3.message");
    assert.ok(p);
    return p;
  };
  const signal = new AbortController().signal;
  const p = poller();
  const rows = await p.poll(signal);
  assert.deepEqual(
    [...rows]
      .sort((a, b) => a.naturalKey.localeCompare(b.naturalKey))
      .map((r) => [r.naturalKey, r.payload.verdict, r.payload.text_length]),
    [
      ["first-round", "FAIL", 4],
      ["message", "PASS", 9],
      ["new-format", "FAIL", "判定：FAIL。前回は PASS".length],
    ],
  );
  assert.ok(!JSON.stringify(rows).includes("PASS #391"));
  assert.equal((await poller().poll(signal)).length, 3);
  p.committed?.();
  assert.equal((await poller().poll(signal)).length, 0);
});

void test("Codex approval requests retain resolution updates and exclude other prompts and projects", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "approval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "t3.sqlite");
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  db.exec(`CREATE TABLE projection_projects(project_id, workspace_root);
 CREATE TABLE orchestration_v2_projection_threads(thread_id, project_id);
 CREATE TABLE orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,provider_turn_id,kind,status,created_at,resolved_at,payload_json);
 INSERT INTO projection_projects VALUES ('repo','/repo'),('foreign','/elsewhere');
 INSERT INTO orchestration_v2_projection_threads VALUES ('local','repo'),('other','foreign');`);
  const at = new Date().toISOString();
  const input = db.prepare(
    "INSERT INTO orchestration_v2_projection_runtime_requests VALUES(?,?,'turn',?,'pending',?,NULL,?)",
  );
  for (const [id, thread, kind, driver] of [
    ["a", "local", "command", "codex"],
    ["b", "local", "user_input", "codex"],
    ["c", "other", "command", "codex"],
    ["d", "local", "command", "claudeAgent"],
  ] as const)
    input.run(
      id,
      thread,
      kind,
      at,
      JSON.stringify({ nativeRequestRef: { driver }, instructions: "secret" }),
    );
  const poller = t3Pollers(file, "/repo", root).find((p) => p.name === "t3.approval");
  assert.ok(poller);
  const signal = new AbortController().signal;
  const pending = await poller.poll(signal);
  assert.deepEqual(
    pending.map((r) => [r.naturalKey, r.payload.status, r.payload.resolved_at]),
    [["a", "pending", null]],
  );
  poller.committed?.();
  db.prepare(
    "UPDATE orchestration_v2_projection_runtime_requests SET status='resolved',resolved_at=?,payload_json=json_set(payload_json,'$.decision','accept') WHERE runtime_request_id='a'",
  ).run(at);
  const resolved = await poller.poll(signal);
  assert.deepEqual(
    resolved.map((r) => [r.naturalKey, r.payload.decision, r.payload.resolved_at]),
    [["a", "accept", at]],
  );
  assert.doesNotMatch(JSON.stringify(resolved), /secret/u);
});
