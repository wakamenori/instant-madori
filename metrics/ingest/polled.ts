import { leadingRecord, verificationFields } from "./github-yaml.ts";
import { z } from "zod";
import type { Obj } from "../l1/envelope.ts";
import type { RecordInput } from "../l1/sources.ts";

export function candidate(
  source: RecordInput["source"],
  id: string | number,
  at: string | null,
  payload: Obj,
): RecordInput {
  return {
    source,
    naturalKey: String(id),
    occurredAt: at ? new Date(at).toISOString() : null,
    sourceVersion: "1",
    scope: { kind: "repo" },
    payload,
  };
}

export function threadTitle(title: string) {
  const owner = /^#(\d+) /u.exec(title),
    verifier = /^検証 #(\d+) @ (\w+)/u.exec(title);
  const round = /^PR #(\d+)\s*[（(]#(\d+)[）)]の検証[（(](\d+)回目[）)]/u.exec(title);
  return {
    ...(round ? { attempt: Number(round[3]) } : {}),
    title_kind: owner ? "owner" : verifier || round ? "verifier" : "other",
    issue: owner ? Number(owner[1]) : round ? Number(round[2]) : null,
    pr: verifier ? Number(verifier[1]) : round ? Number(round[1]) : null,
    sha: verifier?.[2] ?? null,
  };
}

export function verdict(text: string) {
  const declared = /(?:判定|verdict)\s*[:：]\s*[*`]*(PASS|FAIL)\b/iu.exec(text);
  if (declared) return declared[1]?.toUpperCase() ?? null;
  const words = [...new Set(text.match(/\b(?:PASS|FAIL)\b/gu))];
  return words.length === 1
    ? (words[0] ?? null)
    : (/^\s*[#*` ]*(PASS|FAIL)\b/u.exec(text)?.[1] ?? null);
}
export function messageDecision(title: string, role: string, head: string) {
  if (role !== "assistant" || threadTitle(title).title_kind !== "verifier")
    return { verdict: null };
  const fields = leadingRecord(head, verificationFields);
  return {
    ...(fields ? { verification: fields } : {}),
    verdict: fields === undefined ? verdict(head.slice(0, 400)) : (fields?.verdict ?? null),
  };
}

const scalarRow = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
export function t3Record(
  name: "t3.thread" | "t3.run" | "t3.subagent" | "t3.message",
  raw: unknown,
) {
  const { id, title, prs, head, ...fields } = scalarRow.parse(raw);
  const extras =
    name === "t3.thread"
      ? {
          ...threadTitle(String(title)),
          project_match: true,
          pr_numbers: z.array(z.number()).parse(JSON.parse(String(prs))),
        }
      : name === "t3.message"
        ? messageDecision(String(title), String(fields.role), String(head ?? ""))
        : {};
  return candidate(
    name,
    String(id),
    String(fields.created_at ?? fields.requested_at ?? fields.started_at ?? "") || null,
    { ...fields, ...extras },
  );
}
