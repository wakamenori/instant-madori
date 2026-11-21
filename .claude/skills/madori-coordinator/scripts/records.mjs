import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { z } from "zod";

import {
  factsByKind,
  labels,
  labeledKind,
  readIssueFields,
} from "../../../../metrics/ingest/issue-facts.ts";
export { labels };
const text = z.string().trim().min(1);

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
  if (kind === "issue" || kind === "addition") {
    if (!labeledKind([label]) || readIssueFields(markdown, [label]) === null)
      throw new Error("expected the fields required by the Issue label");
    return;
  }
  const raw = leadingBlock(markdown);
  if (kind === "verdict") verdict.parse(raw);
  else if (kind === "staging-start") stagingStart.parse(raw);
  else if (kind === "staging-end") stagingEnd.parse(raw);
  else throw new Error("unknown record kind");
}

export function renderDraft(markdown) {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
  if (!match) throw new Error("expected draft frontmatter");
  const { id, title, milestone, blockedBy, type, ...fields } = z
    .looseObject({
      type: z.enum(Object.keys(labels)),
      id: z.union([text, z.int()]),
      title: text,
      milestone: z.union([text, z.int()]),
      blockedBy: z.string().nullable(),
    })
    .parse(parse(match[1]));
  const schema = factsByKind[type];
  const record = (schema ?? z.strictObject({})).parse(fields);
  const body = markdown.slice(match[0].length).trimStart();
  if (!body.startsWith("## ") || [...body.matchAll(/^## 依存\r?$/gm)].length !== 1)
    throw new Error("expected draft headings including exactly one ## 依存");
  if (!schema) return body;
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
