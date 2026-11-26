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

const userAreas = ["apps/web", "apps/worker/src"];
const mapArea = ".claude/skills/verify-madori/features";

function scopeSection(markdown) {
  const visible = markdown
    .replace(/<!--[\s\S]*?(?:-->|(?![\s\S]))/g, "")
    .replace(/^[ \t]*((`|~)\2{2,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1\2*[ \t]*\r?$|(?![\s\S]))/gm, "");
  const heading = /^## 範囲[ \t]*\r?$/m.exec(visible);
  if (!heading) return "";
  return visible.slice(heading.index + heading[0].length).split(/^##[ \t]/m, 1)[0];
}

function scopePathField(section) {
  const label =
    /^[ \t]*(?:[-*][ \t]+|(#{3,6})[ \t]+)(?:\*\*)?触ってよいパス(?:\*\*)?[ \t]*[：:]?/m.exec(
      section,
    );
  if (!label) return "";
  const rest = section.slice(label.index + label[0].length);
  // A heading owns its list, including bullets at column zero.
  const sibling = label[1] ? /\n#{1,6}[ \t]/ : /\n(?:[-*]|#{1,6})[ \t]/;
  return rest.split(sibling, 1)[0];
}

function readScopePaths(field) {
  const paths = [];
  const tokens = field.replaceAll("`", " ").matchAll(/[\w.@-]+(?:\/[\w.@*-]+)+\/?|[\w.@-]+\//g);
  for (const [path] of tokens)
    paths.push(
      path
        .replace(/^\.\//, "")
        .replace(/\/$/, "")
        .replace(/(?:\/\*\*?)+$/, ""),
    );
  return paths;
}

function overlaps(path, area) {
  return path === area || path.startsWith(area + "/") || area.startsWith(path + "/");
}

function checkMapScope(markdown) {
  const section = scopeSection(markdown);
  const paths = readScopePaths(scopePathField(section));
  const userPath = paths.find((path) => userAreas.some((area) => overlaps(path, area)));
  if (!userPath || paths.some((path) => overlaps(path, mapArea))) return;

  const reason = /^[ \t]*[-*][ \t]+地図を変えない理由[ \t]*[：:](.*)$/m.exec(section);
  if (reason) {
    if (reason[1].trim()) return;
    throw new Error("- 地図を変えない理由： needs a reason");
  }
  throw new Error(
    `「触ってよいパス」 lists ${userPath} but no path under ${mapArea}/. ` +
      "Add the map file the owner must update, or add - 地図を変えない理由：<理由> to 範囲 if the user-facing behavior does not change.",
  );
}

export function checkRecord(kind, markdown, label) {
  if (kind !== "issue" && kind !== "addition") throw new Error("unknown record kind");
  if (!labeledKind([label]) || readIssueFields(markdown, [label]) === null)
    throw new Error("expected the fields required by the Issue label");
  if (kind === "issue") checkMapScope(markdown);
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
  checkMapScope(body);
  if (!schema) return body;
  return "```yaml\n" + stringify(record) + "```\n\n" + body;
}

if (import.meta.main) {
  try {
    const [kind, file, label, ...rest] = process.argv.slice(2);
    if (!file || rest.length || ["issue", "addition"].includes(kind) !== Boolean(label))
      throw new Error("usage: records.mjs draft <file> OR issue|addition <file> <Issue label>");
    const markdown = readFileSync(file, "utf8");
    if (kind === "draft") process.stdout.write(renderDraft(markdown));
    else checkRecord(kind, markdown, label);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
