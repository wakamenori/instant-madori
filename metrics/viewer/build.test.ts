import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { registry, type RecordInput } from "../l1/sources.ts";
import { readViewerData } from "./data.ts";
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
    for (const [source, observed] of [
      ["claude.hook", "2026-10-31T00:00:00.000Z"],
      ["otlp", start],
    ] as const) {
      l1.ingest([], observed, [
        { source, unitHash: "a".repeat(64), reason: "fixture", content: null },
      ]);
    }
    add("t3.thread", "previous-owner", {
      issue: 40,
      title_kind: "owner",
      created_at: "2026-10-30T00:00:00.000Z",
    });
    add("t3.run", "previous-run", {
      thread_id: "previous-owner",
      started_at: "2026-10-30T00:00:00.000Z",
      completed_at: "2026-10-30T00:01:00.000Z",
    });
    add("metrics.receiver", "first", { sources: { "t3.thread": { last_poll: start } } });
    add("metrics.receiver", "second", {
      sources: { "t3.thread": { last_poll: end, failed_cycles: 1 } },
    });
    add("t3.run", "run", { thread_id: "owner-41", started_at: start, completed_at: end });
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
  assert.match(html, /スループットとその分解/u);
  assert.match(html, /<option value="8" selected>/u);
  const custom = join(root, "morning.html");
  execFileSync(process.execPath, [viewer, "--out", custom], options);
  assert.match(readFileSync(custom, "utf8"), /機能のデリバリー/u);

  const derived = new DatabaseSync(join(root, "metrics-derived.sqlite"));
  try {
    const initial = readViewerData(derived);
    assert.equal(initial.generatedAt, end);
    assert.deepEqual(
      initial.health.filter((h) => h.quarantined).map((h) => [h.source, h.recent_quarantined]),
      [
        ["claude.hook", 0],
        ["otlp", 1],
      ],
    );
    assert.equal(initial.health.find((h) => h.source === "t3.thread")?.stopped, false);
    assert.equal(initial.windows.find((w) => w.length === 8)?.points.length, 0);
    derived.prepare("UPDATE mart_health SET last_append=NULL WHERE source='t3.thread'").run();
    assert.equal(
      readViewerData(derived).health.find((h) => h.source === "t3.thread")?.stopped,
      true,
    );
    derived.exec("UPDATE mart_health SET quarantined='broken'");
  } finally {
    derived.close();
  }
  const failed = spawnSync(process.execPath, [viewer], { ...options, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /quarantined/u);
  assert.equal(readFileSync(output, "utf8"), html);
});
