import { z } from "zod";
import { acceptedJobSchema, cancelledJobSchema } from "@madori/contracts";
import type { OwnerId } from "../owner.ts";
import { rows } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { activeJobStates } from "./job-states.ts";
import { runOnce, updateOnceStatements } from "./requests.ts";
import type { OnceCompanion, RequestKey } from "./requests.ts";

/** Answers pass a queue hold. Other queued jobs wait until it is released. */
export function claimable(q: string, m: string) {
  return `(${m}.kind = 'answer' OR NOT EXISTS (SELECT 1 FROM jobs h WHERE h.pattern_id = ${q}.pattern_id AND h.holds_queue = 1))`;
}
export function inputKey(alias: string, direction: "" | " DESC" = "") {
  return `${alias}.turn${direction}, ${alias}.number${direction}`;
}

export function holdsQueueOnEnd(t: string) {
  return `holds_queue = CASE WHEN ${t}.state IN (${activeJobStates})
    AND EXISTS (SELECT 1 FROM jobs q WHERE q.pattern_id = ${t}.pattern_id AND q.state = 'queued')
    AND NOT EXISTS (SELECT 1 FROM jobs h WHERE h.pattern_id = ${t}.pattern_id AND h.holds_queue = 1)
    THEN 1 ELSE ${t}.holds_queue END`;
}

const clearHold = { sql: "holds_queue = 0", bindings: [] };
export function releaseWhenLastQueuedJobStops(jobId: string, ownerId: OwnerId): OnceCompanion {
  return {
    table: "jobs",
    set: clearHold,
    where: {
      sql: `holds_queue = 1 AND pattern_id = (SELECT s.pattern_id FROM jobs s
      WHERE s.id = ? AND s.owner_id = ? AND s.state = 'queued')
      AND NOT (jobs.state = 'awaiting_answer' AND EXISTS (SELECT 1 FROM messages question
        WHERE question.job_id = jobs.id AND question.kind = 'question'
        AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.question_id = question.id)))
      AND NOT EXISTS (SELECT 1 FROM jobs q WHERE q.pattern_id = jobs.pattern_id AND q.state = 'queued' AND q.id <> ?)`,
      bindings: [jobId, ownerId, jobId],
    },
  };
}

export function releaseEmptyQueue(patternId: string, ownerId: OwnerId, messageId: string) {
  return {
    sql: `UPDATE jobs SET holds_queue = 0 WHERE pattern_id = ? AND owner_id = ? AND holds_queue = 1
    AND EXISTS (SELECT 1 FROM messages m WHERE m.id = ? AND m.pattern_id = jobs.pattern_id AND m.owner_id = jobs.owner_id)
    AND NOT EXISTS (SELECT 1 FROM jobs q WHERE q.pattern_id = jobs.pattern_id AND q.state = 'queued')`,
    bindings: [patternId, ownerId, messageId],
  };
}

export const queueHoldSql = `SELECT json_object('job', json_object('jobId', j.id, 'messageId', m.id,
  'number', m.number, 'state', j.state,
  'question', CASE WHEN q.id IS NOT NULL THEN json_object('messageId', q.id, 'number', q.number, 'body', q.body, 'choices', json(q.choices)) END,
  'answer', CASE WHEN aj.id IS NOT NULL THEN json_object('jobId', aj.id, 'messageId', a.id, 'number', a.number) END)) AS json
  FROM jobs j INDEXED BY jobs_one_queue_hold_per_pattern
  CROSS JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
  LEFT JOIN messages q ON q.job_id = j.id AND q.kind = 'question'
  LEFT JOIN messages a ON a.question_id = q.id
  LEFT JOIN jobs aj ON aj.message_id = a.id AND aj.pattern_id = a.pattern_id
  WHERE j.pattern_id = ? AND j.owner_id = ? AND j.holds_queue = 1`;
export const holdingJobIdSql =
  "SELECT id AS heldBy FROM jobs WHERE pattern_id = ? AND holds_queue = 1";
export function readHoldingJob(db: D1, patternId: string) {
  return db.first(
    rows(
      { sql: holdingJobIdSql, bindings: [patternId] },
      z.object({ heldBy: z.uuid() }),
      "holding job",
    ),
  );
}

export function readStalledPatterns(db: D1, input: { unchangedSince: string; limit: number }) {
  return db.all(
    rows(
      {
        sql: `SELECT p.id AS patternId FROM patterns p
      WHERE EXISTS (SELECT 1 FROM jobs a WHERE a.pattern_id = p.id
        AND a.state IN (${activeJobStates}) AND a.updated_at < ?1)
      OR EXISTS (SELECT 1 FROM jobs q JOIN messages m ON m.id = q.message_id
        WHERE q.pattern_id = p.id AND q.state = 'queued' AND q.updated_at < ?1 AND ${claimable("q", "m")})
      ORDER BY random() LIMIT ?2`,
        bindings: [input.unchangedSince, input.limit],
      },
      z.object({ patternId: z.uuid() }).transform((row) => row.patternId),
      "stalled patterns",
    ),
  );
}

interface QueueRelease {
  patternId: string;
  heldBy: string;
  now: string;
}
function releaseBatch(key: RequestKey, input: QueueRelease, action: "resume" | "cancel") {
  const scope = [input.patternId, key.ownerId];
  return updateOnceStatements(key, input.now, {
    table: "jobs",
    set: clearHold,
    where: {
      sql: "id = ? AND pattern_id = ? AND owner_id = ? AND holds_queue = 1",
      bindings: [input.heldBy, ...scope],
    },
    result: {
      sql: `SELECT json_object('jobs', json_group_array(json_object('jobId', j.id, 'messageId', m.id,
      'number', m.number${action === "cancel" ? ", 'state', 'cancelled'" : ""}) ORDER BY ${inputKey("m")}))
      FROM jobs j CROSS JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
      WHERE j.pattern_id = ? AND j.owner_id = ? AND j.state = 'queued'`,
      bindings: scope,
    },
    companions:
      action === "cancel"
        ? [
            {
              table: "jobs",
              set: { sql: "state = 'cancelled', updated_at = ?", bindings: [input.now] },
              where: {
                sql: "pattern_id = ? AND owner_id = ? AND state = 'queued'",
                bindings: scope,
              },
            },
          ]
        : [],
  });
}
export function resumeQueueOnce(db: D1, key: RequestKey, input: QueueRelease) {
  return runOnce(
    db,
    z.object({ jobs: z.array(acceptedJobSchema) }),
    releaseBatch(key, input, "resume"),
  );
}
export function cancelQueueOnce(db: D1, key: RequestKey, input: QueueRelease) {
  return runOnce(
    db,
    z.object({ jobs: z.array(cancelledJobSchema) }),
    releaseBatch(key, input, "cancel"),
  );
}
