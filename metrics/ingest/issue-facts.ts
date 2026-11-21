import { parseDocument } from "yaml";
import { z } from "zod";

export const labels = {
  機能: "機能：利用者に見える振る舞いを足す・変える",
  製品の不具合: "製品の不具合：約束どおりに動かない製品を直す",
  製品の作りの見直し: "製品の作りの見直し：振る舞いを変えずに作りを変える",
  開発の仕組みの改善: "開発の仕組みの改善：作る・確かめる・届ける・動かす仕組みを良くする",
  開発の仕組みの不具合: "開発の仕組みの不具合：約束どおりに動かない仕組みを直す",
  開発の仕組みの作りの見直し: "開発の仕組みの作りの見直し：振る舞いを変えずに作りを変える",
  外の変化への追従: "外の変化への追従：依存・脆弱性・外のツールの変化に合わせる",
  確かめと判断: "確かめと判断：試作・計測・受け入れ・計画づくりで知る・決める",
} as const;

const text = z.string().trim().min(1);
const discovery = {
  found_at: z.enum(["マージの前の検証", "マージの後"]),
  found_by: text,
  cause: z.string().regex(/^(?:#[1-9]\d*|PR #[1-9]\d*|外の変化|もとからあった|不明)$/u),
};

export const bug = z.strictObject(discovery);
export const restructuring = bug.extend({ plan_change: z.enum(["はい", "いいえ"]) });
const target = z.strictObject({ target: text });
export const additionFields = z.union([bug, restructuring, target]);
export const factsByKind = {
  機能: null,
  製品の不具合: bug,
  開発の仕組みの不具合: bug,
  製品の作りの見直し: restructuring,
  開発の仕組みの作りの見直し: restructuring,
  開発の仕組みの改善: target,
  外の変化への追従: null,
  確かめと判断: null,
} satisfies Record<keyof typeof labels, z.ZodType | null>;

export function labeledKind(names: readonly string[]) {
  const matches = (Object.keys(labels) as (keyof typeof labels)[]).filter((kind) =>
    names.includes(labels[kind]),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

// Only a leading fence is a record. Later examples in the report describe other work.
export function leadingRecord<T>(markdown: string, schema: z.ZodType<T>) {
  const body = markdown.trimStart();
  const fence = /^```yaml[ \t]*\r?\n/u.exec(body);
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

export function readIssueFields(body: string, names: readonly string[]) {
  const kind = labeledKind(names);
  const schema = kind && factsByKind[kind];
  const fields = leadingRecord<z.infer<typeof additionFields>>(body, schema ?? z.never());
  if (fields === undefined) return schema ? null : undefined;
  return fields && kind ? { ...fields, type: kind } : null;
}
