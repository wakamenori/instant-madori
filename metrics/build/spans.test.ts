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

void test("staging occupancy uses historical Issue announcements and then timestamped YAML records", (t) => {
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
