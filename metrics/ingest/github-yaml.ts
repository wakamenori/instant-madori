import { z } from "zod";
import { leadingRecord, readIssueFields } from "./issue-facts.ts";
const time = z.iso.datetime().transform((v) => new Date(v).toISOString());
export const verificationFields = z
  .strictObject({
    head: z.string().regex(/^[a-f\d]{40}$/u),
    verdict: z.enum(["PASS", "FAIL"]),
    decided_at: time,
    failed_checks: z.array(z.enum(["検査", "振る舞い", "地図", "差分", "終わった証拠"])),
  })
  .refine(
    (v) =>
      (v.verdict === "PASS") === !v.failed_checks.length &&
      new Set(v.failed_checks).size === v.failed_checks.length,
  );
const staging = z
  .strictObject({ started_at: time, ended_at: time.optional() })
  .refine((v) => !v.ended_at || v.started_at <= v.ended_at);
const commentFields = z.union([
  verificationFields.safeExtend({ attempt: z.int().positive() }),
  staging,
]);

export function issueFacts(body: string, labels: string[]) {
  const section =
    body
      .replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, "")
      .split(/^##[ \t]+使う共有資源[ \t]*\r?$/mu)[1]
      ?.split(/^#/mu)[0] ?? "";
  const fields = readIssueFields(body, labels);
  return {
    fields: fields ?? null,
    invalid_yaml_record: fields === null,
    shared_resources: [
      "staging を占有する",
      "staging を読むだけ",
      "pnpm dev",
      "pnpm check --full",
      "なし",
    ].filter((item) => section.includes(item)),
  };
}
export function commentFacts(body: string, labels: string[]) {
  const event = leadingRecord(body, commentFields);
  const fields = event === null ? readIssueFields(body, labels) : event;
  return fields === undefined ? [] : [z.json().parse(fields)];
}
