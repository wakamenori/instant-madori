import {
  activeJobStates,
  jobStateSchema,
  stoppableJobStates,
  finishedJobStates,
} from "./job-states.ts";
import { z } from "zod";
import { foundSchema, jsonRows, rows, write } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { revisionSchema, cancelledJobSchema, finishedJobSchema } from "@madori/contracts";
import { readJobExecutionRight } from "./job-execution.ts";
import type { JobExecutionRight } from "./job-execution.ts";
import { revisionJson, finishedJobJson } from "./revisions.ts";
import { verifyJobSnapshot } from "./snapshots.ts";
import type { Snapshot } from "./snapshots.ts";
import type { R2 } from "./r2.ts";
import { messageJson, messageSchema } from "./messages.ts";
import { createOnceStatements, updateOnceStatements, runOnce } from "./requests.ts";
import type { RequestKey } from "./requests.ts";

const jobSchema = z.object({
  id: z.uuid(),
  patternId: z.uuid(),
  messageId: z.uuid(),
  state: jobStateSchema,
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

function executionCondition(right: JobExecutionRight) {
  const scope = readJobExecutionRight(right);
  return {
    sql: `j.id = ? AND j.pattern_id = ? AND j.generation = ?
      AND j.base_revision_id IS ? AND j.owner_id = ?`,
    bindings: [scope.jobId, scope.patternId, scope.generation, scope.baseRevisionId, scope.ownerId],
  };
}

function activeCondition(right: JobExecutionRight) {
  const scope = executionCondition(right);
  return {
    sql: `${scope.sql} AND j.state = 'running'
      AND j.base_revision_id IS (SELECT r.id FROM revisions r
        WHERE r.pattern_id = j.pattern_id ORDER BY r.number DESC LIMIT 1)`,
    bindings: scope.bindings,
  };
}

function resultStatement(right: JobExecutionRight) {
  const scope = executionCondition(right);
  return jsonRows(
    {
      sql: `SELECT ${revisionJson("r")} AS json FROM jobs j JOIN revisions r
      ON r.job_id = j.id AND r.pattern_id = j.pattern_id
      WHERE ${scope.sql} AND j.state = 'completed'`,
      bindings: scope.bindings,
    },
    revisionSchema,
    "job result",
  );
}

export async function checkJobExecution(db: D1, right: JobExecutionRight) {
  const active = activeCondition(right);
  const [results, live] = await db.batch([
    resultStatement(right),
    rows(
      { sql: `SELECT 1 AS found FROM jobs j WHERE ${active.sql}`, bindings: active.bindings },
      foundSchema,
      "job execution",
    ),
  ]);
  const revision = results[0];
  if (revision) return { kind: "committed" as const, revision };
  return live.length ? { kind: "active" as const } : { kind: "execution_lost" as const };
}

export async function completeJob(
  db: D1,
  bucket: R2,
  right: JobExecutionRight,
  input: { id: string; name: string; snapshot: Snapshot; now: string },
) {
  const { jobId, patternId, generation, baseRevisionId, ownerId } = readJobExecutionRight(right);
  const { id, name, snapshot: suppliedSnapshot, now } = input;
  const status = await checkJobExecution(db, right);
  if (status.kind !== "active") return status;
  const snapshot = await verifyJobSnapshot(bucket, right, suppliedSnapshot);
  if (snapshot === null) return { kind: "invalid_snapshot" as const };
  const active = activeCondition(right);
  const [, , , results] = await db.batch([
    write({
      sql: `INSERT INTO snapshots
        (id, owner_id, format_version, manifest_key, manifest_sha256, created_at)
        SELECT ?, j.owner_id, ?, 'owners/' || j.owner_id || '/snapshots/' || ? || '/manifest.json', ?, ?
        FROM jobs j WHERE ${active.sql}`,
      bindings: [
        snapshot.id,
        snapshot.formatVersion,
        snapshot.id,
        snapshot.manifestSha256,
        snapshot.createdAt,
        ...active.bindings,
      ],
    }),
    write({
      sql: `INSERT INTO revisions
        (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at, job_id, conversation_number)
        SELECT ?, j.pattern_id, j.owner_id,
          (SELECT coalesce(max(r.number), 0) + 1 FROM revisions r WHERE r.pattern_id = j.pattern_id),
          ?, s.id, j.base_revision_id, ?, j.id, m.number
        FROM jobs j JOIN snapshots s ON s.id = ? AND s.owner_id = j.owner_id
          JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        WHERE ${active.sql}`,
      bindings: [id, name, now, snapshot.id, ...active.bindings],
    }),
    write({
      sql: `UPDATE jobs SET state = 'completed', updated_at = ?
        WHERE id = ? AND pattern_id = ? AND generation = ? AND state = 'running'
          AND base_revision_id IS ? AND owner_id = ?
          AND EXISTS (SELECT 1 FROM revisions r WHERE r.id = ?
            AND r.job_id = jobs.id AND r.base_revision_id IS jobs.base_revision_id)`,
      bindings: [now, jobId, patternId, generation, baseRevisionId, ownerId, id],
    }),
    resultStatement(right),
  ]);
  const revision = results[0];
  return revision ? { kind: "committed" as const, revision } : { kind: "execution_lost" as const };
}

export async function recordJobFailure(db: D1, right: JobExecutionRight, now: string) {
  const { jobId, patternId, generation, baseRevisionId, ownerId } = readJobExecutionRight(right);
  const result = await db.first(
    rows(
      {
        sql: `UPDATE jobs SET state = 'failed', updated_at = ?
      WHERE id = ? AND pattern_id = ? AND generation = ? AND base_revision_id IS ? AND owner_id = ?
        AND state IN (${activeJobStates}) RETURNING 1 AS found`,
        bindings: [now, jobId, patternId, generation, baseRevisionId, ownerId],
      },
      foundSchema,
      "job failure",
    ),
  );
  return { kind: result === null ? ("not_recorded" as const) : ("recorded" as const) };
}

const stopResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("stopped"), patternId: z.uuid(), job: cancelledJobSchema }),
  z.object({ outcome: z.literal("already_finished"), patternId: z.uuid(), job: finishedJobSchema }),
]);
export type JobStop =
  | { kind: "applied" | "replayed"; result: z.infer<typeof stopResultSchema> }
  | { kind: "not_found" }
  | { kind: "request_id_reused" };

export async function stopJobOnce(
  db: D1,
  key: RequestKey,
  input: { jobId: string; now: string },
): Promise<JobStop> {
  const batch = updateOnceStatements(key, input.now, {
    table: "jobs",
    set: {
      sql: `state = CASE WHEN state IN (${stoppableJobStates}) THEN 'cancelled' ELSE state END,
        updated_at = CASE WHEN state IN (${stoppableJobStates}) THEN ? ELSE updated_at END`,
      bindings: [input.now],
    },
    where: {
      sql: `id = ? AND owner_id = ? AND state IN (${stoppableJobStates}, ${finishedJobStates})`,
      bindings: [input.jobId, key.ownerId],
    },
    result: {
      sql: `SELECT json_object('outcome', CASE WHEN j.state IN (${stoppableJobStates})
          THEN 'stopped' ELSE 'already_finished' END,
        'patternId', j.pattern_id, 'job', ${finishedJobJson("j", "m", "r", {
          state: `CASE WHEN j.state IN (${stoppableJobStates}) THEN 'cancelled' ELSE j.state END`,
        })})
        FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        LEFT JOIN revisions r ON r.job_id = j.id AND r.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.owner_id = ?`,
      bindings: [input.jobId, key.ownerId],
    },
  });
  const once = await runOnce(db, stopResultSchema, batch);
  return once.kind === "not_applied" ? { kind: "not_found" } : once;
}

export async function isJobOwnedBySubject(db: D1, right: JobExecutionRight, subject: string) {
  const { jobId, patternId, generation, ownerId } = readJobExecutionRight(right);
  const row = await db.first(
    rows(
      {
        sql: `SELECT 1 AS found FROM jobs j JOIN users u ON u.id = j.owner_id
      WHERE j.id = ? AND j.pattern_id = ? AND j.generation = ? AND j.owner_id = ?
        AND u.access_subject = ?`,
        bindings: [jobId, patternId, generation, ownerId, subject],
      },
      foundSchema,
      "job owner subject",
    ),
  );
  return row !== null;
}
