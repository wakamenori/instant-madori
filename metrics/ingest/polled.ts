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
  return {
    title_kind: owner ? "owner" : verifier ? "verifier" : "other",
    issue: owner ? Number(owner[1]) : null,
    pr: verifier ? Number(verifier[1]) : null,
    sha: verifier?.[2] ?? null,
  };
}

export function messageVerdict(title: string, role: string, head: string) {
  return role === "assistant" && threadTitle(title).title_kind === "verifier"
    ? (/\b(PASS|FAIL)\b/u.exec(head)?.[1] ?? null)
    : null;
}
