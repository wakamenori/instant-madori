import { z } from "zod";
import type { D1 } from "./d1.ts";
import { messageJson, messageSchema } from "./messages.ts";
import { createOnceStatements, runOnce } from "./requests.ts";
import type { RequestKey } from "./requests.ts";

const jobSchema = z.object({
  id: z.uuid(),
  patternId: z.uuid(),
  messageId: z.uuid(),
  state: z.enum([
    "queued",
    "running",
    "validating",
    "committing",
    "completed",
    "awaiting_answer",
    "cancelled",
    "failed",
    "limited",
  ]),
  generation: z.number().int().nonnegative(),
  baseRevisionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const acceptanceSchema = z.object({ message: messageSchema, job: jobSchema });
export type Acceptance = z.infer<typeof acceptanceSchema>;

export interface NewInstruction {
  id: string;
  messageId: string;
  patternId: string;
  body: string;
  now: string;
}

export async function acceptInstructionOnce(db: D1, key: RequestKey, input: NewInstruction) {
  const batch = createOnceStatements(key, input.now, {
    table: "jobs",
    id: input.id,
    statements: [
      {
        sql: `INSERT INTO messages (id, pattern_id, owner_id, number, body, created_at)
          SELECT ?, p.id, p.owner_id,
            (SELECT coalesce(max(m.number), 0) + 1 FROM messages m WHERE m.pattern_id = p.id),
            ?, ? FROM patterns p WHERE p.id = ? AND p.owner_id = ?`,
        bindings: [input.messageId, input.body, input.now, input.patternId, key.ownerId],
      },
      {
        sql: `INSERT INTO jobs
          (id, pattern_id, owner_id, message_id, state, generation, base_revision_id, created_at, updated_at)
          SELECT ?, m.pattern_id, m.owner_id, m.id, 'queued', 0, NULL, ?, ?
          FROM messages m WHERE m.id = ? AND m.pattern_id = ? AND m.owner_id = ?`,
        bindings: [input.id, input.now, input.now, input.messageId, input.patternId, key.ownerId],
      },
    ],
    result: {
      sql: `SELECT json_object('message', ${messageJson("m")},
        'job', json_object('id', j.id, 'patternId', j.pattern_id, 'messageId', j.message_id,
          'state', j.state, 'generation', j.generation, 'baseRevisionId', j.base_revision_id,
          'createdAt', j.created_at, 'updatedAt', j.updated_at))
        FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.owner_id = ?`,
      bindings: [input.id, key.ownerId],
    },
  });
  return runOnce(db, acceptanceSchema, batch);
}
