import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { classifications } from "../ingest/classification.ts";
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
  const discovery = "\nfound_at: マージの後\nfound_by: 担当\ncause: 不明";
  const records: [string, string, boolean, string?][] = [];
  for (const [label, fields, invalidFields] of [
    ["機能：利用者に見える振る舞いを足す・変える", "", discovery],
    ["製品の不具合：約束どおりに動かない製品を直す", discovery, discovery + "\nplan_change: はい"],
    [
      "製品の作りの見直し：振る舞いを変えずに作りを変える",
      discovery + "\nplan_change: いいえ",
      discovery,
    ],
    [
      "開発の仕組みの改善：作る・確かめる・届ける・動かす仕組みを良くする",
      "\ntarget: activity.ci",
      "",
    ],
    ["開発の仕組みの不具合：約束どおりに動かない仕組みを直す", discovery, ""],
    [
      "開発の仕組みの作りの見直し：振る舞いを変えずに作りを変える",
      discovery + "\nplan_change: はい",
      discovery,
    ],
    ["外の変化への追従：依存・脆弱性・外のツールの変化に合わせる", "", discovery],
    ["確かめと判断：試作・計測・受け入れ・計画づくりで知る・決める", "", "\ntarget: activity.ci"],
  ] as const) {
    const type = label.split("：")[0];
    assert.ok(classifications.safeParse([{ issue: 1, kind: type }]).success, label);
    const prefix = "type: " + type;
    for (const kind of ["issue", "addition"]) {
      records.push(
        [kind, prefix + fields, true, label],
        [kind, prefix + invalidFields, false, label],
      );
    }
  }
  records.push(
    ["verdict", verdict, true],
    ["verdict", verdict.replace("PASS", "FAIL"), false],
    ["verdict", verdict.replace("00Z", "00+00:00"), false],
    ["staging-start", start, true],
    ["staging-end", start + "\nended_at: 2026-11-21T00:00:00Z", true],
    ["staging-end", start + "\nended_at: 2026-11-19T00:00:00Z", false],
  );
  for (const [kind, yaml, valid, label] of records) {
    const body = "```yaml\n" + yaml + "\n```";
    const file = join(dir, "record.md");
    writeFileSync(file, body);
    const labelArgs = label ? [label] : [];
    const result = spawnSync(process.execPath, [
      resolve(import.meta.dirname, "../../.claude/skills/madori-coordinator/scripts/records.mjs"),
      kind,
      file,
      ...labelArgs,
    ]);
    assert.equal(result.status === 0, valid, kind + " " + yaml);
    assert.equal(
      (kind === "issue" ? issueFacts(body).fields : commentFacts(body)[0]) != null,
      valid,
      kind,
    );
  }
});
