import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { issueFacts, commentFacts } from "../ingest/github-yaml.ts";

void test("coordinator CLI and ingestion recognize the same record shapes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "record-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const head = "a".repeat(40);
  const verdict =
    "attempt: 1\nhead: " +
    head +
    "\ndecided_at: 2026-11-20T00:00:00Z\nverdict: PASS\nfailed_checks: []";
  const start = "started_at: 2026-11-20T00:00:00Z";
  const label = "機能：利用者に見える振る舞いを足す・変える";
  for (const [kind, yaml, valid] of [
    ["issue", "type: 機能", true],
    ["issue", "type: 機能\nextra: x", false],
    ["addition", "type: 機能", true],
    ["verdict", verdict, true],
    ["verdict", verdict.replace("PASS", "FAIL"), false],
    ["verdict", verdict.replace("00Z", "00+00:00"), false],
    ["staging-start", start, true],
    ["staging-end", start + "\nended_at: 2026-11-21T00:00:00Z", true],
    ["staging-end", start + "\nended_at: 2026-11-19T00:00:00Z", false],
  ] as const) {
    const body = "```yaml\n" + yaml + "\n```";
    const file = join(dir, "record.md");
    writeFileSync(file, body);
    const labelArgs = kind === "issue" || kind === "addition" ? [label] : [];
    const result = spawnSync(process.execPath, [
      resolve(import.meta.dirname, "../../.claude/skills/madori-coordinator/scripts/records.mjs"),
      kind,
      file,
      ...labelArgs,
    ]);
    assert.equal(result.status === 0, valid, kind);
    assert.equal(
      (kind === "issue" ? issueFacts(body).fields : commentFacts(body)[0]) != null,
      valid,
      kind,
    );
  }
});
