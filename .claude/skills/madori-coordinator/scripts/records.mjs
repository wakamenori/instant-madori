import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";

export const labels = {
  機能: "機能：利用者に見える振る舞いを足す・変える",
  不具合: "不具合：約束どおりに動かないものを直す",
  作りの見直し: "作りの見直し：振る舞いを変えずにコードや計画の作りを変える",
  外部への追従: "外部への追従：依存・脆弱性・ツールの変化に合わせる",
  開発の改善: "開発の改善：担当・検証・CI・道具・手順を良くする",
  確かめと判断:
    "確かめと判断：試作・計測・確かめ・受け入れ・計画づくりで、知ることや決めることを得る",
};

const text = z.string().trim().min(1);
const discovery = {
  found_at: z.enum(["マージの前の検証", "マージの後"]),
  found_by: text,
  cause: z.string().regex(/^(?:#[1-9]\d*|PR #[1-9]\d*|外の変化|もとからあった|不明)$/),
};

const issue = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("機能") }),
  z.strictObject({ type: z.literal("不具合"), ...discovery }),
  z.strictObject({
    type: z.literal("作りの見直し"),
    ...discovery,
    plan_change: z.enum(["はい", "いいえ"]),
  }),
  z.strictObject({ type: z.literal("外部への追従") }),
  z.strictObject({ type: z.literal("開発の改善"), target: text }),
  z.strictObject({ type: z.literal("確かめと判断") }),
]);

const check = z.enum(["検査", "振る舞い", "地図", "差分", "終わった証拠"]);
const time = z.iso.datetime();
const verdict = z
  .strictObject({
    attempt: z.int().positive(),
    head: z.string().regex(/^[a-f0-9]{40}$/),
    verdict: z.enum(["PASS", "FAIL"]),
    decided_at: time,
    failed_checks: z.array(check),
  })
  .refine(
    ({ verdict, failed_checks }) =>
      (verdict === "PASS") === (failed_checks.length === 0) &&
      new Set(failed_checks).size === failed_checks.length,
    "PASS requires no failed checks; FAIL requires distinct failed checks",
  );
const stagingStart = z.strictObject({ started_at: time });
const stagingEnd = stagingStart
  .extend({ ended_at: time })
  .refine(
    ({ started_at, ended_at }) => Date.parse(started_at) <= Date.parse(ended_at),
    "ended_at precedes started_at",
  );

function leadingBlock(markdown) {
  const match = /^\s*```yaml[ \t]*\r?\n([\s\S]*?)^```[ \t]*\r?$/m.exec(markdown);
  if (!match || match.index !== 0) throw new Error("expected a leading fenced yaml record");
  return parse(match[1]);
}

export function checkRecord(kind, markdown, label) {
  const raw = leadingBlock(markdown);
  if (kind === "issue" || kind === "addition") {
    const record = issue.parse(raw);
    if (labels[record.type] !== label) throw new Error("type must match the Issue label");
    return;
  }
  if (kind === "verdict") verdict.parse(raw);
  else if (kind === "staging-start") stagingStart.parse(raw);
  else if (kind === "staging-end") stagingEnd.parse(raw);
  else throw new Error("unknown record kind");
}

export function renderDraft(markdown) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("expected draft frontmatter");
  const { id, title, milestone, blockedBy, ...fields } = z
    .looseObject({
      id: z.union([text, z.int()]),
      title: text,
      milestone: z.union([text, z.int()]),
      blockedBy: z.string().nullable(),
    })
    .parse(parse(match[1]));
  const record = issue.parse(fields);
  const body = markdown.slice(match[0].length).trimStart();
  if (!body.startsWith("## ") || [...body.matchAll(/^## 依存\r?$/gm)].length !== 1)
    throw new Error("expected draft headings including exactly one ## 依存");
  return "```yaml\n" + stringify(record) + "```\n\n" + body;
}

if (import.meta.main) {
  try {
    const [kind, file, label, ...rest] = process.argv.slice(2);
    if (!file || rest.length || ["issue", "addition"].includes(kind) !== Boolean(label))
      throw new Error(
        "usage: records.mjs draft|verdict|staging-start|staging-end <file> OR issue|addition <file> <Issue label>",
      );
    const markdown = readFileSync(file, "utf8");
    if (kind === "draft") process.stdout.write(renderDraft(markdown));
    else checkRecord(kind, markdown, label);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
