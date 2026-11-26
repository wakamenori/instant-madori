import type { OwnerId } from "../owner.ts";
import type { SqlPart } from "./d1.ts";

/** A condition on the pattern aliased `p`: every listed asset is its owner's. IDs must be distinct. */
export function ownsAllAttachments(attachmentIds: readonly string[]): SqlPart {
  const ids = JSON.stringify(attachmentIds);
  return {
    sql: `(SELECT count(*) FROM assets
      WHERE owner_id = p.owner_id AND id IN (SELECT value FROM json_each(?))) = json_array_length(?)`,
    bindings: [ids, ids],
  };
}

export function insertAttachments(input: {
  messageId: string;
  patternId: string;
  ownerId: OwnerId;
  attachmentIds: readonly string[];
}): SqlPart {
  return {
    sql: `INSERT INTO message_attachments (message_id, position, pattern_id, owner_id, asset_id)
      SELECT m.id, e.key, m.pattern_id, m.owner_id, e.value FROM messages m, json_each(?) e
      WHERE m.id = ? AND m.pattern_id = ? AND m.owner_id = ?`,
    bindings: [
      JSON.stringify(input.attachmentIds),
      input.messageId,
      input.patternId,
      input.ownerId,
    ],
  };
}

export function attachmentIdsJson(m: string) {
  return `json((SELECT json_group_array(a.asset_id ORDER BY a.position) FROM message_attachments a
    WHERE a.message_id = ${m}.id AND a.pattern_id = ${m}.pattern_id AND a.owner_id = ${m}.owner_id))`;
}
