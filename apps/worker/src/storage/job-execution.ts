import { claimable, inputKey } from "./job-queue.ts";
import { activeJobStates } from "./job-states.ts";
import { z } from "zod";
import { revisionSchema } from "@madori/contracts";
import { jsonRows, rows } from "./d1.ts";
import type { D1 } from "./d1.ts";
import { revisionJson } from "./revisions.ts";

export const queueHeadSql = `SELECT q.id FROM jobs q CROSS JOIN messages m
            ON m.id = q.message_id AND m.pattern_id = q.pattern_id
            WHERE q.pattern_id = ? AND q.state = 'queued' AND ${claimable("q", "m")} ORDER BY ${inputKey("m")} LIMIT 1`;

const executionSchema = z.object({
  jobId: z.uuid(),
  patternId: z.uuid(),
  ownerId: z.uuid(),
  generation: z.int().positive(),
  baseRevisionId: z.uuid().nullable(),
});
const referenceSchema = executionSchema.pick({ patternId: true, jobId: true, generation: true });
export type JobExecutionReference = z.infer<typeof referenceSchema>;
const token = Symbol("JobExecutionRight");

class JobExecutionRight {
  readonly #scope: Readonly<z.infer<typeof executionSchema>>;

  private constructor(key: typeof token, scope: z.infer<typeof executionSchema>) {
    if (key !== token) throw new TypeError("Execution rights require the private token");
    this.#scope = Object.freeze(scope);
    Object.freeze(this);
  }

  get reference(): JobExecutionReference {
    const { patternId, jobId, generation } = this.#scope;
    return { patternId, jobId, generation };
  }

  static read(this: void, right: JobExecutionRight) {
    if (typeof right !== "object" || right === null || !(#scope in right)) {
      throw new TypeError("Expected an execution right acquired from D1");
    }
    return right.#scope;
  }

  static async claim(this: void, db: D1, input: { patternId: string; now: string }) {
    const { patternId, now } = input;
    const row = await db.first(
      rows(
        {
          sql: `UPDATE jobs SET state = 'running', generation = generation + 1,
        base_revision_id = (SELECT r.id FROM revisions r
          WHERE r.pattern_id = jobs.pattern_id ORDER BY r.number DESC LIMIT 1), updated_at = ?
        WHERE pattern_id = ? AND state = 'queued'
          AND id = (${queueHeadSql})
          AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.pattern_id = ?
            AND a.state IN (${activeJobStates}))
        RETURNING id AS jobId, pattern_id AS patternId, owner_id AS ownerId,
          generation, base_revision_id AS baseRevisionId`,
          bindings: [now, patternId, patternId, patternId],
        },
        executionSchema,
        "job execution",
      ),
    );
    return row === null
      ? { kind: "not_claimed" as const }
      : { kind: "claimed" as const, right: new JobExecutionRight(token, row) };
  }

  static async restore(this: void, db: D1, reference: JobExecutionReference) {
    const { jobId, patternId, generation } = reference;
    const row = await db.first(
      jsonRows(
        {
          sql: `SELECT json_object('jobId', j.id, 'patternId', j.pattern_id,
        'ownerId', j.owner_id, 'generation', j.generation,
        'baseRevisionId', j.base_revision_id, 'state', j.state,
        'revision', CASE WHEN r.id IS NULL THEN NULL ELSE ${revisionJson("r")} END) AS json
        FROM jobs j LEFT JOIN revisions r ON r.job_id = j.id AND r.pattern_id = j.pattern_id
        WHERE j.id = ? AND j.pattern_id = ? AND j.generation = ?
          AND j.state IN ('running', 'completed', 'cancelled', 'awaiting_answer')`,
          bindings: [jobId, patternId, generation],
        },
        executionSchema.extend({
          state: z.enum(["running", "completed", "cancelled", "awaiting_answer"]),
          revision: revisionSchema.nullable(),
        }),
        "current job execution",
      ),
    );
    if (row === null) return { kind: "invalid" as const };
    if (row.state === "awaiting_answer") return { kind: "asked" as const };
    if (row.state === "cancelled") return { kind: "cancelled" as const };
    if (row.state === "completed") {
      if (row.revision === null) return { kind: "invalid" as const };
      return { kind: "committed" as const, revision: row.revision };
    }
    return {
      kind: "active" as const,
      right: new JobExecutionRight(token, executionSchema.parse(row)),
    };
  }
}

Object.freeze(JobExecutionRight);
Object.freeze(JobExecutionRight.prototype);

export type { JobExecutionRight };
export const readJobExecutionRight = JobExecutionRight.read;
export const claimNextJob = JobExecutionRight.claim;
export const readCurrentJobExecution = JobExecutionRight.restore;

export async function readActiveJob(db: D1, input: { patternId: string }) {
  return db.first(
    rows(
      {
        sql: `SELECT pattern_id AS patternId, id AS jobId, generation, updated_at AS claimedAt FROM jobs
      WHERE pattern_id = ? AND state IN (${activeJobStates})`,
        bindings: [input.patternId],
      },
      referenceSchema
        .extend({ claimedAt: z.iso.datetime() })
        .transform(({ claimedAt, ...reference }) => ({ reference, claimedAt })),
      "active job reference",
    ),
  );
}
