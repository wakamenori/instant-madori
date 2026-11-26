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

const projectScope =
  "## 範囲\n- 触ってよいパス：`apps/worker/src/api/projects.ts`、`apps/worker/tests/projects.test.ts`、`docs/plan.md` の 4.7";
const mapError = /\.claude\/skills\/verify-madori\/features\//;
const checkIssue = (body) => checkRecord("issue", body, typeLabels["機能"]);

test("issues and drafts require the verification map for project API changes", () => {
  const body = projectScope + "\n## 依存\n";
  const draft = "---\nid: sample\ntitle: 案件\nmilestone: 2\nblockedBy: null\ntype: 機能\n---\n";
  assert.throws(() => checkIssue(body), mapError);
  assert.throws(() => renderDraft(draft + body), mapError);
  const covered = body.replace(
    " の 4.7",
    " の 4.7、`.claude/skills/verify-madori/features/projects.md`",
  );
  checkIssue(covered);
  assert.equal(renderDraft(draft + covered), covered);
  checkRecord("addition", body, typeLabels["機能"]);
});

test("issues can give a reason for leaving the verification map unchanged", () => {
  checkIssue(projectScope + "\n- 地図を変えない理由：作りの見直しで画面の振る舞いは変えない");
  assert.throws(() => checkIssue(projectScope + "\n- 地図を変えない理由:  "), /needs a reason/);
});

test("scope paths include parent directories and stop at component boundaries", () => {
  for (const path of ["apps/worker", "apps/web/", "apps/", "./apps/web/**"])
    assert.throws(() => checkIssue("## 範囲\n- 触ってよいパス: " + path), mapError);
  for (const path of [
    "apps/worker/tests/x.ts",
    "apps/webapp/x",
    ".claude/skills/madori-coordinator/scripts/records.mjs",
  ])
    checkIssue("## 範囲\n- 触ってよいパス: " + path);
  checkIssue(projectScope + "\r\n  .claude/skills/verify-madori\r\n");
  assert.throws(
    () => checkIssue(projectScope + "\n- 目的：.claude/skills/verify-madori"),
    mapError,
  );
});

test("only a visible reason in the scope section exempts a user path", () => {
  const reason = "- 地図を変えない理由：テストだけ";
  for (const example of [
    "## 人の判断\n" + reason,
    "<!--\n" + reason + "\n-->",
    "```markdown\n" + reason + "\n```",
    "~~~md\n" + reason + "\n~~~",
  ]) {
    assert.throws(() => checkIssue(projectScope + "\n" + example), mapError);
  }
  checkIssue(projectScope + "\n- やらないこと：\n  " + reason);
});

test("examples do not add paths to the scope", () => {
  const docs = "- 触ってよいパス：`docs/plan.md`";
  const example = "- 触ってよいパス：`apps/web/src/x.ts`";
  checkIssue("## 目的\n```md\n## 範囲\n" + example + "\n```\n## 範囲\n" + docs);
  checkIssue("## 範囲\n<!--\n" + example + "\n-->\n" + docs);
  checkIssue("## 範囲\n" + docs + "\n- 地図を変えない理由：");
  checkIssue("## 目的\n" + example);
});

test("heading fields, nested bullets and continuation lines include user paths", () => {
  for (const field of [
    "### 触ってよいパス\n\n- `apps/worker/src/storage/jobs.ts`",
    "- 触ってよいパス：\n\n  - `apps/web/src/projects.tsx`",
    "- 触ってよいパス：\n`apps/web/src/projects.tsx`",
    "- 触ってよいパス ：`apps/web/src/projects.tsx`",
    "* **触ってよいパス**: `apps/web/src/projects.tsx`",
  ]) {
    assert.throws(() => checkIssue("## 範囲\n" + field), mapError);
  }
});
