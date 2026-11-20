import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { registry, type RecordInput } from "../l1/sources.ts";
import { openL1Writer } from "../l1/store.ts";

void test("staging occupancy comes from Issue comments, not the merge comment on the PR", (t) => {
  const root = mkdtempSync(join(tmpdir(), "metrics-spans-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const begin = "2026-11-20T15:08:17.000Z";
  const issueBegin = "2026-11-20T15:08:35.000Z";
  const finish = "2026-11-20T16:30:49.000Z";
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
    const comment = (id: string, on: number, at: string, markers: string[]) =>
      add("github.comment", id, {
        issue_or_pr: on,
        created_at: at,
        author: "coordinator",
        markers,
        body_length: 100,
      });
    comment("1", 391, begin, ["staging_occupy_start"]);
    comment("2", 313, issueBegin, ["staging_occupy_start"]);
    comment("3", 313, finish, ["staging_occupy_end"]);
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
    assert.deepEqual(spans, [{ issue: 313, start: issueBegin, end: finish }]);
  } finally {
    derived.close();
  }
});
