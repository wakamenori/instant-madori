import { z } from "zod";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { classifications } from "../ingest/classification.ts";
import { issueFacts, commentFacts } from "../ingest/github-yaml.ts";
import { messageDecision } from "../ingest/polled.ts";

void test("coordinator CLI and ingestion recognize the same record shapes", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "record-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const head = "a".repeat(40);
  const report = join(dir, "report.md");
  writeFileSync(report, "Commands and results");
  for (const [sha, flags, valid] of [
    [head, ["--pass"], true],
    [head, ["--fail", "地図"], true],
    [head, ["--fail"], false],
    [head, ["--fail", "unknown"], false],
    [head, ["--pass", "--fail", "地図"], false],
    [head.slice(1), ["--pass"], false],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../scripts/dev/verdict.ts"),
        "--dry-run",
        "--pr",
        "1",
        "--head",
        sha,
        "--attempt",
        "1",
        "--report",
        report,
        ...flags,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status === 0, valid, result.stderr);
    if (valid) {
      const { comment, message } = z
        .object({ comment: z.string(), message: z.string() })
        .parse(JSON.parse(result.stdout));
      assert.ok(commentFacts(comment, [])[0] != null);
      assert.ok(messageDecision("検証 #1 @ " + sha, "assistant", message).verification);
    }
  }
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
    const history = fields.includes("found_at")
      ? z.record(z.string(), z.string()).parse(parse(fields))
      : {};
    assert.ok(classifications.safeParse([{ issue: 1, kind: type, ...history }]).success, label);
    if (fields.includes("found_at"))
      assert.equal(classifications.safeParse([{ issue: 1, kind: type }]).success, false);
    for (const kind of ["issue", "addition"]) {
      records.push(
        [kind, fields, true, label],
        [kind, invalidFields, false, label],
        [kind, "type: " + type + fields, false, label],
        [kind, "{}", false, label],
      );
    }
  }
  for (const [kind, yaml, valid, label] of records) {
    const body = !yaml ? "## 目的" : "```yaml\n" + yaml + "\n```";
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
    if (kind === "issue")
      assert.equal(!issueFacts(body, labelArgs).invalid_yaml_record, valid, kind);
    else if (yaml) assert.equal(commentFacts(body, labelArgs)[0] != null, valid, kind);
    else assert.deepEqual(commentFacts(body, labelArgs), []);
  }
});
