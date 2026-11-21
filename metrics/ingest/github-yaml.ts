import { parseDocument } from "yaml";
import { z } from "zod";

const text = z.string().trim().min(1);
const discovery = {
  found_at: z.enum(["マージの前の検証", "マージの後"]),
  found_by: text,
  cause: z.string().regex(/^(?:#[1-9]\d*|PR #[1-9]\d*|外の変化|もとからあった|不明)$/u),
};
const issueFields = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["機能", "外部への追従", "確かめと判断"]) }),
  z.object({ type: z.literal("開発の改善"), target: text }),
  z.object({ type: z.literal("不具合"), ...discovery }),
  z.object({
    type: z.literal("作りの見直し"),
    ...discovery,
    plan_change: z.enum(["はい", "いいえ"]),
  }),
]);
const time = z.iso.datetime({ offset: true }).transform((v) => new Date(v).toISOString());
export const verificationFields = z
  .object({
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
  .object({ started_at: time, ended_at: time.optional() })
  .refine((v) => !v.ended_at || v.started_at <= v.ended_at);
const commentFields = z.union([
  issueFields,
  verificationFields.safeExtend({ attempt: z.int().positive() }),
  staging,
]);

// Only a leading fence is a record. Later examples in the report describe other work.
export function leadingRecord<T>(markdown: string, schema: z.ZodType<T>) {
  const body = markdown.trimStart();
  const fence = /^```ya?ml[ \t]*\r?\n/iu.exec(body);
  if (!fence) return undefined;
  const rest = body.slice(fence[0].length);
  const end = /^```[ \t]*\r?$/mu.exec(rest);
  if (!end) return null;
  try {
    const doc = parseDocument(rest.slice(0, end.index));
    if (doc.errors.length) return null;
    const result = schema.safeParse(doc.toJS({ maxAliasCount: 0 }));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
export function issueFacts(body: string) {
  const section =
    body
      .replaceAll(/<!--[\s\S]*?(?:-->|$)/gu, "")
      .split(/^##[ \t]+使う共有資源[ \t]*\r?$/mu)[1]
      ?.split(/^#/mu)[0] ?? "";
  return {
    fields: leadingRecord(body, issueFields) ?? null,
    shared_resources: [
      "staging を占有する",
      "staging を読むだけ",
      "pnpm dev",
      "pnpm check --full",
      "なし",
    ].filter((item) => section.includes(item)),
  };
}
export function commentFacts(body: string) {
  const fields = leadingRecord(body, commentFields);
  return fields === undefined ? [] : [z.json().parse(fields)];
}
