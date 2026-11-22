import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { parse, stringify } from "yaml";
import { checkRecord, labels as typeLabels, renderDraft } from "./records.mjs";

const block = (record) => "```yaml\n" + stringify(record) + "```\n";
const findings = { found_at: "マージの後", found_by: "担当", cause: "#123" };
const fields = {
  機能: {},
  開発の仕組みの不具合: findings,
  製品の不具合: findings,
  開発の仕組みの作りの見直し: { ...findings, plan_change: "いいえ" },
  製品の作りの見直し: { ...findings, plan_change: "いいえ" },
  外の変化への追従: {},
  開発の仕組みの改善: { target: "検査で古い形式を検出できる" },
  確かめと判断: {},
};

test("every template supplies exactly the fields of its label and the same work sections", () => {
  const dir = new URL("../../../../.github/ISSUE_TEMPLATE/", import.meta.url);
  const types = [];
  for (const file of readdirSync(dir).filter((file) => file.endsWith(".md"))) {
    const [, metadata, body] = readFileSync(new URL(file, dir), "utf8").split(/^---\r?$/m);
    const { labels } = parse(metadata);
    const type = Object.keys(typeLabels).find((type) => typeLabels[type] === labels);
    types.push(type);
    const yaml = body.match(/^\s*```yaml\n([\s\S]*?)\n```/);
    assert.equal(Boolean(yaml), Object.keys(fields[type]).length > 0);
    if (yaml)
      assert.deepEqual(Object.keys(parse(yaml[1])).sort(), Object.keys(fields[type]).sort());
    assert.deepEqual(body.match(/^## .+$/gm), [
      "## 目的",
      "## 計画の該当節",
      "## 範囲",
      "## 終わった証拠",
      "## 使う共有資源",
      "## 依存",
      "## 人の判断",
    ]);
    checkRecord("issue", yaml ? block(fields[type]) : body, labels);
  }
  assert.deepEqual(types.sort(), Object.keys(fields).sort());
});

test("draft copies only record fields and preserves the filled body", () => {
  const body = "## 目的\n\n原因の調査\n\n## 依存\n\n- #12\n";
  const draft =
    '---\nid: sample\ntitle: 調査\nmilestone: 開発基盤\nblockedBy: "#12"\ntype: 製品の不具合\nfound_at: マージの後\nfound_by: 担当\ncause: "#34"\n---\n' +
    body;
  const rendered = renderDraft(draft.replaceAll("\n", "\r\n"));
  checkRecord("issue", rendered, typeLabels["製品の不具合"]);
  assert.doesNotMatch(rendered, /^type:/m);
  assert.equal(
    renderDraft(draft.replace(/type: 製品の不具合[\s\S]*?\n---/, "type: 機能\n---")),
    body,
  );
  assert.ok(rendered.endsWith(body.replaceAll("\n", "\r\n")));
  assert.doesNotMatch(rendered, /sample|blockedBy|milestone/);
  assert.equal(parse(rendered.split("```")[1].slice(4)).cause, "#34");
  checkRecord(
    "issue",
    renderDraft(
      draft.replace("id: sample", "id: 12").replace("milestone: 開発基盤", "milestone: 2"),
    ),
    typeLabels["製品の不具合"],
  );
  for (const invalid of [
    draft.replace('"#34"', "#34"),
    draft.replace("## 依存", "## 未定"),
    draft + "## 依存\n",
    draft.replace("type:", "unknown: x\ntype:"),
  ])
    assert.throws(() => renderDraft(invalid));
});

test("issue and addition enforce label, first block, discovery and type-specific fields", () => {
  for (const kind of ["issue", "addition"]) {
    for (const cause of ["#1", "PR #123", "外の変化", "もとからあった", "不明"])
      checkRecord(kind, block({ ...findings, cause }), typeLabels["製品の不具合"]);
    for (const { type, ...record } of [
      { type: "製品の不具合" },
      { type: "製品の作りの見直し", ...findings },
      { type: "製品の不具合", ...findings, found_at: "作業中" },
      { type: "製品の不具合", ...findings, cause: "PR 3" },
      { type: "製品の不具合", ...findings, found_by: " " },
      { type: "機能", target: "値" },
      { type: "開発の仕組みの改善", target: "" },
      { type: "その他" },
    ])
      assert.throws(() => checkRecord(kind, block(record), typeLabels[type]));
    assert.throws(() => checkRecord(kind, block({ type: "機能" }), typeLabels["製品の不具合"]));
    assert.throws(() =>
      checkRecord(kind, "本文\n" + block({ type: "機能" }), typeLabels["製品の不具合"]),
    );
    assert.throws(() =>
      checkRecord(kind, "```yaml\ntype: 機能\ntype: 機能\n```", typeLabels["機能"]),
    );
  }
});

test("verdict binds an attempt and event time to one head and its failed checks", () => {
  const record = {
    attempt: 1,
    head: "1".repeat(40),
    decided_at: "2026-11-22T00:00:00Z",
    verdict: "PASS",
    failed_checks: [],
  };
  checkRecord("verdict", block(record));
  checkRecord("verdict", block({ ...record, verdict: "FAIL", failed_checks: ["地図", "検査"] }));
  for (const change of [
    { attempt: 0 },
    { head: "abc" },
    { decided_at: "昨日" },
    { verdict: "FAIL" },
    { failed_checks: ["地図"] },
    { verdict: "FAIL", failed_checks: ["別の項目"] },
    { verdict: "FAIL", failed_checks: ["検査", "検査"] },
  ])
    assert.throws(() => checkRecord("verdict", block({ ...record, ...change })));
});

test("staging records the start immediately and the same start with the release time", () => {
  const started_at = "2026-11-22T01:00:00Z";
  checkRecord("staging-start", block({ started_at }));
  checkRecord("staging-end", block({ started_at, ended_at: "2026-11-22T02:00:00Z" }));
  assert.throws(() => checkRecord("staging-start", block({ started_at, ended_at: started_at })));
  for (const record of [
    { started_at },
    { ended_at: started_at },
    { started_at, ended_at: "2026-11-21T01:00:00Z" },
    { started_at: "昨日" },
  ])
    assert.throws(() => checkRecord("staging-end", block(record)));
});
