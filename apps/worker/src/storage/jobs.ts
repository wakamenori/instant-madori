import { ownsAllAttachments, insertAttachments } from "./attachments.ts";
import { activeJobStates, stoppableJobStates, finishedJobStates } from "./job-states.ts";
import {
  inputKey,
  holdsQueueOnEnd,
  releaseWhenLastQueuedJobStops,
  releaseEmptyQueue,
} from "./job-queue.ts";
import { z } from "zod";
import { foundSchema, jsonRows, rows, write } from "./d1.ts";
import type { D1 } from "./d1.ts";
import {
  conversationMessageSchema,
  acceptedJobSchema,
  revisionSchema,
  cancelledJobSchema,
  finishedJobSchema,
} from "@madori/contracts";
import { readJobExecutionRight } from "./job-execution.ts";
import type { JobExecutionRight } from "./job-execution.ts";
import { revisionJson, finishedJobJson } from "./revisions.ts";
import { snapshotJson, snapshotSchema, verifyJobSnapshot } from "./snapshots.ts";
import type { Snapshot } from "./snapshots.ts";
import type { R2 } from "./r2.ts";
import { createOnceStatements, updateOnceStatements, runOnce } from "./requests.ts";
import type { RequestKey } from "./requests.ts";

// Rows written by the previous Worker contain the full message and job.
const acceptanceSchema = acceptedJobSchema.or(
  z
    .object({
      message: z.object({ id: z.uuid(), number: z.int().positive() }),
      job: z.object({ id: z.uuid() }),
    })
    .transform(({ message, job }) => ({
      jobId: job.id,
      messageId: message.id,
      number: message.number,
    })),
);

export interface NewInstruction {
  id: string;
  messageId: string;
  patternId: string;
  body: string;
  questionId?: string;
  attachmentIds: readonly string[];
  now: string;
}

export const insertInputJobSql = `INSERT INTO jobs
  (id, pattern_id, owner_id, message_id, state, generation, base_revision_id, created_at, updated_at)
  SELECT ?, m.pattern_id, m.owner_id, m.id, 'queued', 0, NULL, ?, ?
  FROM messages m WHERE m.id = ? AND m.pattern_id = ? AND m.owner_id = ? AND m.kind IN ('instruction', 'answer')`;

export async function acceptInstructionOnce(db: D1, key: RequestKey, input: NewInstruction) {
  const owned = ownsAllAttachments(input.attachmentIds);
  const questionId = input.questionId ?? null;
  const questionJoin = `LEFT JOIN messages question ON question.pattern_id = p.id AND question.kind = 'question' AND question.id = ?
    LEFT JOIN jobs asking ON asking.id = question.job_id
    LEFT JOIN messages root ON root.id = asking.message_id`;
  const open = `asking.state = 'awaiting_answer' AND asking.holds_queue = 1 AND NOT EXISTS
    (SELECT 1 FROM messages a WHERE a.question_id = question.id)`;
  const batch = createOnceStatements(key, input.now, {
    table: "jobs",
    id: input.id,
    statements: [
      {
        sql: `INSERT INTO messages (id, pattern_id, owner_id, number, body, created_at, kind, question_id, answer_turn)
          SELECT ?, p.id, p.owner_id,
            (SELECT coalesce(max(m.number), 0) + 1 FROM messages m WHERE m.pattern_id = p.id),
            ?, ?, ?, question.id, root.turn FROM patterns p ${questionJoin}
            WHERE p.id = ? AND p.owner_id = ? AND ${owned.sql} AND (? IS NULL OR (${open}))`,
        bindings: [
          input.messageId,
          input.body,
          input.now,
          input.questionId ? "answer" : "instruction",
          questionId,
          input.patternId,
          key.ownerId,
          ...owned.bindings,
          questionId,
        ],
      },
      insertAttachments({
        messageId: input.messageId,
        patternId: input.patternId,
        ownerId: key.ownerId,
        attachmentIds: input.attachmentIds,
      }),
      releaseEmptyQueue(input.patternId, key.ownerId, input.messageId),
      {
        sql: insertInputJobSql,
        bindings: [input.id, input.now, input.now, input.messageId, input.patternId, key.ownerId],
      },
    ],
    result: {
      sql: `SELECT json_object('jobId', j.id, 'messageId', m.id, 'number', m.number)
        FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.owner_id = ?`,
      bindings: [input.id, key.ownerId],
    },
  });
  const once = await runOnce(db, acceptanceSchema, batch);
  if (once.kind !== "not_applied" || !input.questionId) return once;
  const question = await db.first(
    rows(
      {
        sql: `SELECT CASE WHEN ${open} THEN 1 ELSE 0 END AS available FROM patterns p ${questionJoin}
      WHERE p.id = ? AND p.owner_id = ? AND question.id IS NOT NULL`,
        bindings: [input.questionId, input.patternId, key.ownerId],
      },
      z.object({ available: z.literal([0, 1]) }),
      "question availability",
    ),
  );
  if (!question) return { kind: "not_found" as const };
  return question.available ? once : { kind: "version_conflict" as const };
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

export async function askQuestion(
  db: D1,
  right: JobExecutionRight,
  input: { id: string; body: string; choices: string[]; now: string },
) {
  const active = activeCondition(right);
  const choices = z.array(z.string()).parse(input.choices);
  await db.batch([
    write({
      sql: `UPDATE jobs SET holds_queue = 0 WHERE holds_queue = 1 AND pattern_id IN
      (SELECT j.pattern_id FROM jobs j WHERE ${active.sql})`,
      bindings: active.bindings,
    }),
    write({
      sql: `INSERT INTO messages (id, pattern_id, owner_id, number, body, created_at, kind, job_id, choices)
      SELECT ?, j.pattern_id, j.owner_id, (SELECT coalesce(max(m.number), 0) + 1 FROM messages m WHERE m.pattern_id = j.pattern_id),
      ?, ?, 'question', j.id, ? FROM jobs j WHERE ${active.sql}`,
      bindings: [input.id, input.body, input.now, JSON.stringify(choices), ...active.bindings],
    }),
    write({
      sql: `UPDATE jobs AS j SET state = 'awaiting_answer', holds_queue = 1, updated_at = ? WHERE ${active.sql}`,
      bindings: [input.now, ...active.bindings],
    }),
  ]);
}

export async function startContext(
  db: D1,
  right: JobExecutionRight,
  window: { budgetBytes: number; entryOverheadBytes: number },
) {
  const active = activeCondition(right);
  return db.first(
    jsonRows(
      {
        sql: `WITH context AS (
          SELECT j.pattern_id, j.owner_id, m.id, m.number, m.turn, m.body, j.updated_at,
            CASE WHEN s.id IS NULL THEN NULL ELSE ${snapshotJson("s")} END AS base
          FROM jobs j JOIN messages m ON m.id = j.message_id AND m.pattern_id = j.pattern_id
          LEFT JOIN revisions r ON r.id = j.base_revision_id AND r.pattern_id = j.pattern_id
          LEFT JOIN snapshots s ON s.id = r.snapshot_id AND s.owner_id = j.owner_id
          WHERE ${active.sql}
        ), earlier AS (
          SELECT m.number, m.kind, m.body, m.choices,
            sum(length(CAST(m.body AS BLOB)) + coalesce(length(CAST(m.choices AS BLOB)), 0) + ?) OVER (ORDER BY m.number DESC) AS cost
          FROM messages m JOIN context c ON m.pattern_id = c.pattern_id AND m.owner_id = c.owner_id
          WHERE m.id <> c.id AND ((${inputKey("m")}) < (${inputKey("c")}) OR m.kind NOT IN ('instruction', 'answer'))
        ), recent AS (
          SELECT number, kind, body, choices FROM earlier WHERE cost <= ?
        )
        SELECT json_object(
          'instruction', body, 'claimedAt', updated_at, 'base', json(base),
          'total', (SELECT count(*) FROM earlier),
          'messages', (SELECT json_group_array(json_object(
            'number', number, 'kind', kind, 'body', body, 'choices', json(choices)) ORDER BY number) FROM recent)
        ) AS json FROM context`,
        bindings: [...active.bindings, window.entryOverheadBytes, window.budgetBytes],
      },
      z.object({
        total: z.int().nonnegative(),
        messages: z.array(
          z.object({
            number: z.int().positive(),
            kind: z.union(conversationMessageSchema.options.map((s) => s.shape.kind)),
            body: z.string(),
            choices: z.array(z.string()).nullable(),
          }),
        ),
        instruction: z.string(),
        claimedAt: z.iso.datetime(),
        base: snapshotSchema.nullable(),
      }),
      "job start",
    ),
  );
}

export async function recordAi(
  db: D1,
  right: JobExecutionRight,
  versions: { model: string; promptVersion: string; toolSchemaVersion: string },
) {
  const active = activeCondition(right);
  const result = await db.first(
    rows(
      {
        sql: `UPDATE jobs AS j SET ai_model = ?, ai_prompt_version = ?, ai_tool_schema_version = ?
          WHERE ${active.sql} RETURNING 1 AS found`,
        bindings: [
          versions.model,
          versions.promptVersion,
          versions.toolSchemaVersion,
          ...active.bindings,
        ],
      },
      foundSchema,
      "active job",
    ),
  );
  return result !== null;
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
  input: {
    id: string;
    name: string;
    snapshot: Snapshot;
    now: string;
    explanation: { id: string; body: string };
    notice: { id: string; body: string } | null;
  },
) {
  const { jobId, patternId, generation, baseRevisionId, ownerId } = readJobExecutionRight(right);
  const { id, name, snapshot: suppliedSnapshot, now } = input;
  const status = await checkJobExecution(db, right);
  if (status.kind !== "active") return status;
  const snapshot = await verifyJobSnapshot(bucket, right, suppliedSnapshot);
  if (snapshot === null) return { kind: "invalid_snapshot" as const };
  const active = activeCondition(right);
  function message(kind: "notice" | "explanation", entry: { id: string; body: string } | null) {
    return write({
      sql: `INSERT INTO messages (id, pattern_id, owner_id, number, body, created_at, kind, job_id)
        SELECT ?, j.pattern_id, j.owner_id,
          (SELECT coalesce(max(m.number), 0) + 1 FROM messages m WHERE m.pattern_id = j.pattern_id),
          ?, ?, ?, j.id
        FROM jobs j WHERE ${active.sql} AND ? IS NOT NULL`,
      bindings: [
        entry?.id ?? null,
        entry?.body ?? null,
        now,
        kind,
        ...active.bindings,
        entry?.id ?? null,
      ],
    });
  }
  const [, , , , , results] = await db.batch([
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
    message("notice", input.notice),
    message("explanation", input.explanation),
    write({
      sql: `INSERT INTO revisions
        (id, pattern_id, owner_id, number, name, snapshot_id, base_revision_id, created_at, job_id, conversation_number)
        SELECT ?, j.pattern_id, j.owner_id,
          (SELECT coalesce(max(r.number), 0) + 1 FROM revisions r WHERE r.pattern_id = j.pattern_id),
          ?, s.id, j.base_revision_id, ?, j.id, m.number
        FROM jobs j JOIN snapshots s ON s.id = ? AND s.owner_id = j.owner_id
          JOIN messages m ON m.id = ? AND m.pattern_id = j.pattern_id
        WHERE ${active.sql}`,
      bindings: [id, name, now, snapshot.id, input.explanation.id, ...active.bindings],
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

export async function failJobAndHoldQueue(db: D1, right: JobExecutionRight, now: string) {
  const { jobId, patternId, generation, baseRevisionId, ownerId } = readJobExecutionRight(right);
  const result = await db.first(
    rows(
      {
        sql: `UPDATE jobs SET state = 'failed', updated_at = ?, ${holdsQueueOnEnd("jobs")}
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
        updated_at = CASE WHEN state IN (${stoppableJobStates}) THEN ? ELSE updated_at END, ${holdsQueueOnEnd("jobs")}`,
      bindings: [input.now],
    },
    companions: [releaseWhenLastQueuedJobStops(input.jobId, key.ownerId)],
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
