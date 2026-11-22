import { z } from "zod";
import { limits, type MicroUsd } from "../limits.ts";
import { foundSchema, rows, write, type D1, type SqlPart } from "./d1.ts";
import {
  readJobExecutionRight,
  type JobExecutionReference,
  type JobExecutionRight,
} from "./job-execution.ts";

interface Reservation {
  attemptId: string;
  reserve: MicroUsd;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  now: string;
}

interface AttemptUsage {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export async function reserveAiAttempt(
  db: D1,
  right: JobExecutionRight,
  input: Reservation,
): Promise<
  | { kind: "reserved" }
  | { kind: "execution_lost" }
  | { kind: "limited"; limit: keyof typeof limits.aiCost }
> {
  const { jobId, patternId, generation } = readJobExecutionRight(right);
  const { attemptId, reserve, estimatedInputTokens, estimatedOutputTokens, now } = input;
  const running: SqlPart = {
    sql: "j.id = ? AND j.pattern_id = ? AND j.generation = ? AND j.state = 'running'",
    bindings: [jobId, patternId, generation],
  };
  const jobFits: SqlPart = {
    sql: "(SELECT coalesce(sum(a.counted), 0) FROM ai_attempts a WHERE a.job_id = ?) + ? <= ?",
    bindings: [jobId, reserve, limits.aiCost.perInstruction],
  };
  const monthFits: SqlPart = {
    sql: "(SELECT coalesce(sum(a.counted), 0) FROM ai_attempts a WHERE a.month = substr(?, 1, 7)) + ? <= ?",
    bindings: [now, reserve, limits.aiCost.monthly],
  };
  const [, classified] = await db.batch([
    write({
      sql: `INSERT INTO ai_attempts (id, job_id, generation, reserved, estimated_input_tokens, estimated_output_tokens, reserved_at)
        SELECT ?, j.id, j.generation, ?, ?, ?, ? FROM jobs j WHERE ${running.sql}
          AND NOT EXISTS (SELECT 1 FROM ai_attempts a WHERE a.id = ?)
          AND ${jobFits.sql} AND ${monthFits.sql}`,
      bindings: [
        attemptId,
        reserve,
        estimatedInputTokens,
        estimatedOutputTokens,
        now,
        ...running.bindings,
        attemptId,
        ...jobFits.bindings,
        ...monthFits.bindings,
      ],
    }),
    rows(
      {
        sql: `SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM jobs j WHERE ${running.sql}) THEN 'execution_lost'
        WHEN EXISTS (SELECT 1 FROM ai_attempts a WHERE a.id = ? AND a.job_id = ? AND a.generation = ?
          AND a.reserved = ? AND a.estimated_input_tokens = ? AND a.estimated_output_tokens = ?) THEN 'reserved'
        WHEN EXISTS (SELECT 1 FROM ai_attempts a WHERE a.id = ?) THEN 'id_reused'
        WHEN NOT (${jobFits.sql}) THEN 'perInstruction'
        WHEN NOT (${monthFits.sql}) THEN 'monthly'
        ELSE 'none' END AS outcome`,
        bindings: [
          ...running.bindings,
          attemptId,
          jobId,
          generation,
          reserve,
          estimatedInputTokens,
          estimatedOutputTokens,
          attemptId,
          ...jobFits.bindings,
          ...monthFits.bindings,
        ],
      },
      z.object({
        outcome: z.enum([
          "execution_lost",
          "reserved",
          "id_reused",
          "perInstruction",
          "monthly",
          "none",
        ]),
      }),
      "AI reservation outcome",
    ),
  ]);
  const outcome = classified[0]?.outcome;
  if (outcome === "monthly" || outcome === "perInstruction")
    return { kind: "limited", limit: outcome };
  if (outcome === "reserved" || outcome === "execution_lost") return { kind: outcome };
  throw new Error(`Invalid AI reservation outcome: ${outcome}`);
}

export async function settleAiAttempt(
  db: D1,
  job: JobExecutionReference,
  input: {
    attemptId: string;
    charge: MicroUsd;
    usage: AttemptUsage;
    now: string;
  },
): Promise<void> {
  const { usage, charge, attemptId, now } = input;
  const amounts = [
    charge,
    usage.uncachedInputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWrite5mTokens,
    usage.cacheWrite1hTokens,
  ];
  const key: SqlPart = {
    sql: "id = ? AND job_id = ? AND generation = ?",
    bindings: [attemptId, job.jobId, job.generation],
  };
  const [, matched] = await db.batch([
    write({
      sql: `UPDATE ai_attempts SET charged = ?, uncached_input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_5m_tokens = ?, cache_write_1h_tokens = ?, settled_at = ?
        WHERE ${key.sql} AND charged IS NULL`,
      bindings: [...amounts, now, ...key.bindings],
    }),
    rows(
      {
        sql: `SELECT 1 AS found FROM ai_attempts WHERE ${key.sql} AND charged = ? AND uncached_input_tokens = ? AND output_tokens = ? AND cache_read_tokens = ? AND cache_write_5m_tokens = ? AND cache_write_1h_tokens = ?`,
        bindings: [...key.bindings, ...amounts],
      },
      foundSchema,
      "AI settlement",
    ),
  ]);
  if (!matched.length)
    throw new Error("AI attempt missing or settlement conflicts with recorded usage");
}
