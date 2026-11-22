import { DatabaseSync } from "node:sqlite";
import { normalize } from "node:path";
import { z } from "zod";
import type { RecordInput } from "../l1/sources.ts";
const link = z.object({
  provider_thread_id: z.string(),
  thread_id: z.string(),
  project_id: z.string(),
  workspace_root: z.string(),
  worktree_path: z.string().nullable(),
});
export function codexProof(file: string, root: string, id: string): RecordInput | "foreign" | null {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 50 });
  try {
    const row = db.prepare(codexLinkSql).get({ id });
    if (!row) return null;
    const info = link.parse(row);
    if (normalize(info.workspace_root).replace(/\/$/u, "") !== normalize(root).replace(/\/$/u, ""))
      return "foreign";
    return {
      source: "t3.codex_link",
      naturalKey: id,
      occurredAt: null,
      sourceVersion: "1",
      scope: { kind: "proof", subject: "codex.conversation:" + id },
      payload: { ...info, conversation_id: id },
    };
  } finally {
    db.close();
  }
}
const codexLinkSql = /* sql */ `
  SELECT pt.provider_thread_id, pt.thread_id, t.project_id, p.workspace_root, lt.worktree_path
  FROM orchestration_v2_projection_provider_threads AS pt
  JOIN orchestration_v2_projection_threads AS t ON t.thread_id = pt.thread_id
  JOIN projection_projects AS p ON p.project_id = t.project_id
  LEFT JOIN projection_threads AS lt ON lt.thread_id = pt.thread_id
  WHERE pt.provider = 'codex'
    AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = :id
`;
