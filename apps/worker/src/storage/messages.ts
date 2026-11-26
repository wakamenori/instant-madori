import { conversationMessageSchema } from "@madori/contracts";
import type { ConversationMessage } from "@madori/contracts";
import type { OwnerId } from "../owner.ts";
import { foundSchema, rows, jsonRows } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { attachmentIdsJson } from "./attachments.ts";
import { revisionJson } from "./revisions.ts";

export const messagePageSql = `SELECT json_object('id', m.id, 'kind', m.kind, 'number', m.number, 'body', m.body,
    'createdAt', m.created_at, 'jobId', coalesce(m.job_id, j.id),
    'attachmentIds', ${attachmentIdsJson("m")}, 'choices', json(m.choices),
    'revision', CASE WHEN r.id IS NULL THEN NULL ELSE ${revisionJson("r")} END) AS json
  FROM messages m
  LEFT JOIN jobs j ON j.message_id = m.id AND j.pattern_id = m.pattern_id
  LEFT JOIN revisions r ON r.job_id = coalesce(m.job_id, j.id) AND r.pattern_id = m.pattern_id
  WHERE m.pattern_id = ? AND m.owner_id = ? AND m.number < coalesce(?, 9223372036854775807)
  ORDER BY m.number DESC LIMIT ?`;

export interface MessagePage {
  messages: ConversationMessage[];
  next: number | null;
}

export async function listMessages(
  db: D1,
  query: { ownerId: OwnerId; patternId: string; before: number | null; limit: number },
): Promise<MessagePage | null> {
  const [patterns, messageRows] = await db.batch([
    rows(
      {
        sql: "SELECT 1 AS found FROM patterns WHERE id = ? AND owner_id = ?",
        bindings: [query.patternId, query.ownerId],
      },
      foundSchema,
      "existence",
    ),
    jsonRows(
      {
        sql: messagePageSql,
        bindings: [query.patternId, query.ownerId, query.before, query.limit + 1],
      },
      conversationMessageSchema,
      "conversation message",
    ),
  ]);
  if (patterns.length === 0) return null;
  const messages = messageRows.slice(0, query.limit);
  return {
    messages,
    next: messageRows.length > query.limit ? (messages.at(-1)?.number ?? null) : null,
  };
}
