import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
 CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id,title);
 CREATE TABLE orchestration_v2_projection_messages(thread_id,message_id,created_at,updated_at,role,streaming,payload_json);
 INSERT INTO projection_projects VALUES ('repo','/repo'),('other','/other');
 INSERT INTO orchestration_v2_projection_threads VALUES ('v','repo','検証 #391 @ abcd'),('f','other','検証 #1 @ ef01');`);
  const insert = db.prepare(
    "INSERT INTO orchestration_v2_projection_messages VALUES(?,?,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','assistant',?,?)",
  );
  for (const [thread, id, streaming] of [
    ["v", "message", 0],
    ["v", "stream", 1],
    ["f", "foreign", 0],
  ] as const)
    insert.run(thread, id, streaming, JSON.stringify({ text: "PASS #391" }));
  db.close();
  const poller = () => {
    const p = t3Pollers(file, "/repo", home).find((p) => p.name === "t3.message");
    assert.ok(p);
    return p;
  };
  const signal = new AbortController().signal;
  const p = poller();
  const rows = await p.poll(signal);
  assert.deepEqual(
    rows.map((r) => [r.naturalKey, r.payload.verdict, r.payload.text_length]),
    [["message", "PASS", 9]],
  );
  assert.ok(!JSON.stringify(rows).includes("PASS #391"));
  assert.equal((await poller().poll(signal)).length, 1);
  p.committed?.();
  assert.equal((await poller().poll(signal)).length, 0);
});
