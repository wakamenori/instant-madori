import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { metricsHome } from "../home.ts";
import { startReceiver } from "./receiver.ts";
void test("listener ownership, durable hold, spool replay and expiration", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "receiver-"));
  const home = metricsHome({ INSTANT_MADORI_METRICS_HOME: dir });
  let now = new Date();
  const options = {
    home,
    port: 0,
    identity: "/fake/.git",
    clock: () => now,
    t3File: join(dir, "t3"),
  };
  let receiver = await startReceiver(options);
  t.after(async () => {
    await receiver.close();
  });
  const post = (bytes: Buffer | string) =>
    fetch(receiver.url + "/v1/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bytes.toString(),
    });
  const fixture = (name: string) =>
    readFileSync(join(import.meta.dirname, "../ingest/fixtures", name), "utf8");
  const body = fixture("claude-code-Logs.json");
  const other = metricsHome({ INSTANT_MADORI_METRICS_HOME: join(dir, "other") });
  await assert.rejects(
    startReceiver({ ...options, home: other, port: Number(new URL(receiver.url).port) }),
    { code: "EADDRINUSE" },
  );
  assert.equal(existsSync(other.root), false);
  const db = new DatabaseSync(home.database, { readOnly: true });
  t.after(() => db.close());
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const count = (table: string, filter = "1") =>
    db.prepare("SELECT count(*) AS n FROM " + table + " WHERE " + filter).get()?.n;
  assert.equal((await post(body)).status, 200);
  assert.equal(count("held_record"), 1);
  const file = join(home.ready, "1.json"),
    spooled = JSON.stringify({
      v: 1,
      id: randomUUID(),
      at: now.toISOString(),
      project: { dir: "/fake", git: { kind: "directory" } },
      env: {},
      stdin: fixture("hook.json"),
    });
  writeFileSync(file, spooled);
  receiver.flush();
  assert.equal(count("held_record"), 0);
  assert.equal(count("l1_record", "source='claude.otel.log'"), 1);
  assert.equal((await post(body)).status, 200);
  await receiver.close();
  // Restore the ready file to the on-disk state of a crash immediately after commit.
  writeFileSync(file, spooled);
  receiver = await startReceiver(options);
  assert.equal(existsSync(file), false);
  assert.equal(count("l1_record", "source='claude.hook'"), 1);
  await post(body.replaceAll("fake-session-id", "fake-foreign"));
  assert.equal(count("held_record"), 1);
  now = new Date(+now + 86400_001);
  receiver.flush();
  assert.equal(count("held_record"), 0);
  assert.equal((await post("secret non-json")).status, 400);
  assert.equal((await post('{"secret":"private"}')).status, 200);
  assert.equal(count("l1_quarantine"), 2);
  assert.equal(count("l1_quarantine", "content LIKE '%secret%' OR reason LIKE '%private%'"), 0);
  assert.equal((await post(fixture("codex_exec-Logs.json"))).status, 200);
  assert.equal(count("held_record"), 1);
  const t3 = new DatabaseSync(options.t3File);
  t3.exec(`CREATE TABLE orchestration_v2_projection_provider_threads(provider_thread_id,thread_id,provider,payload_json);
CREATE TABLE orchestration_v2_projection_threads(thread_id,project_id);
CREATE TABLE projection_projects(project_id,workspace_root);
CREATE TABLE projection_threads(thread_id,worktree_path);
INSERT INTO projection_projects VALUES ('project','/fake');
INSERT INTO orchestration_v2_projection_threads VALUES ('thread','project');
INSERT INTO orchestration_v2_projection_provider_threads VALUES ('provider','thread','codex','{"nativeThreadRef":{"nativeId":"fake-value"}}');`);
  t3.close();
  receiver.flush();
  assert.equal(count("held_record"), 0);
  assert.equal(count("l1_record", "source='t3.codex_link'"), 1);
  assert.equal(count("l1_record", "source='codex.otel.log'"), 1);
});
