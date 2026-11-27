import { z } from "zod";
import type { JobLimit } from "./limits.ts";
import type { HttpMethod, RoutePath } from "./api/http.ts";
import type { GeometryResult } from "./geometry/geometry-protocol.ts";

const errorDescription: unique symbol = Symbol("ErrorDescription");
const errorDescriptionSchema = z.string().brand(errorDescription);

type FailedGeometry = Exclude<GeometryResult<unknown>, { kind: "ok" }>;

export type JobStepName =
  | "start job"
  | `round ${number} ai`
  | `round ${number} call ${number} ${"edit_house" | "read_house"}`
  | `round ${number} ask`
  | `round ${number} finish`
  | "commit revision"
  | "record failure"
  | "record limit"
  | "wake pattern";

export interface LogFields {
  traceId?: string;
  rayId?: string | undefined;
  method?: HttpMethod | undefined;
  route?: `${HttpMethod} ${RoutePath}` | "/api/health";
  userId?: string;
  status?: number;
  ms?: number;
  error?: ReturnType<typeof describeError>;
  requestId?: string;
  patternId?: string;
  heldBy?: string;
  jobId?: string;
  questionId?: string;
  messageId?: string;
  messageNumber?: number;
  queue?: "applied" | "replayed";
  stop?: "applied" | "replayed";
  jobState?: "awaiting_answer" | "cancelled" | "completed" | "failed" | "limited";
  limit?: JobLimit;
  acceptance?: "applied" | "replayed";
  generation?: number;
  step?: JobStepName;
  attempt?: number;
  attemptId?: string;
  outcome?:
    | "started"
    | "edited"
    | "accepted"
    | "answered"
    | "blocked"
    | "read"
    | "refused"
    | "saved"
    | "asked"
    | "committed"
    | "cancelled"
    | "hold"
    | "skip"
    | "stopped"
    | "already_finished"
    | "not_committed"
    | "limited"
    | "failed"
    | "not_running"
    | "woken"
    | "error"
    | "resumed"
    | "queue_held"
    | "idle"
    | "claimed"
    | "stalled"
    | "running"
    | "settled"
    | "unsettled"
    | "execution_lost";
  revisionId?: string;
  instanceStatus?: string;
  found?: number;
  woken?: number;
  wakeFailed?: number;
  truncated?: number;
  instance?: "created" | "existing";
  bytes?: number;
  geometryStart?: Extract<GeometryResult<unknown>, { kind: "ok" }>["start"];
  aiMs?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  chargedMicroUsd?: number;
  reservedMicroUsd?: number;
  saveMs?: number;
  checkMs?: number;
  geometryMs?: number;
  geometryFailure?: FailedGeometry["reason"];
  geometryStatus?: number;
  geometryViolation?: Extract<FailedGeometry, { reason: "protocol_violation" }>["violation"];
  reason?:
    | FailedGeometry["reason"]
    | "ai_rejected"
    | "ai_script_ended"
    | "ai_unavailable"
    | "ai_output_limit"
    | "ai_refused"
    | "execution_lost"
    | "invalid_snapshot"
    | "invalid_name"
    | "retries_exhausted"
    | "idle_timeout";
  why?: "stale_image" | "no_record";
  image?: string;
  mode?: "cold" | "adopted" | "reprobe";
}

type TypeofName<T> = [Exclude<T, undefined>] extends [number]
  ? "number"
  : [Exclude<T, undefined>] extends [string]
    ? "string"
    : never;

const logKeys = {
  traceId: "string",
  rayId: "string",
  method: "string",
  route: "string",
  userId: "string",
  status: "number",
  ms: "number",
  error: "string",
  requestId: "string",
  patternId: "string",
  heldBy: "string",
  jobId: "string",
  questionId: "string",
  messageId: "string",
  messageNumber: "number",
  queue: "string",
  stop: "string",
  jobState: "string",
  limit: "string",
  acceptance: "string",
  generation: "number",
  step: "string",
  attempt: "number",
  attemptId: "string",
  outcome: "string",
  revisionId: "string",
  instanceStatus: "string",
  found: "number",
  woken: "number",
  wakeFailed: "number",
  truncated: "number",
  instance: "string",
  bytes: "number",
  geometryStart: "string",
  aiMs: "number",
  uncachedInputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  cacheWrite5mTokens: "number",
  cacheWrite1hTokens: "number",
  chargedMicroUsd: "number",
  reservedMicroUsd: "number",
  saveMs: "number",
  checkMs: "number",
  geometryMs: "number",
  geometryFailure: "string",
  geometryStatus: "number",
  geometryViolation: "string",
  reason: "string",
  why: "string",
  image: "string",
  mode: "string",
} satisfies { [K in keyof LogFields]-?: TypeofName<LogFields[K]> };
const typeofByKey = new Map(Object.entries(logKeys));

/** Writes one structured log line; Workers Logs indexes the JSON fields. */
export function logEvent(level: "info" | "error", event: string, fields: LogFields) {
  const allowed = Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => typeof value === typeofByKey.get(key)),
  );
  const line = JSON.stringify({ level, event, ...allowed });
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * Names and messages of an error and everything it wraps (`errors` of an AggregateError,
 * `cause`). Messages come from code and the runtime, never from request bodies.
 */
export function describeError(error: unknown, depth = 0): z.infer<typeof errorDescriptionSchema> {
  if (!(error instanceof Error)) return errorDescriptionSchema.parse(typeof error);
  const parts = [`${error.name}: ${error.message}`];
  if (depth < 3) {
    if (error instanceof AggregateError) {
      for (const inner of error.errors) parts.push(describeError(inner, depth + 1));
    } else if (error.cause !== undefined) {
      parts.push(describeError(error.cause, depth + 1));
    }
  }
  return errorDescriptionSchema.parse(parts.join(" <- "));
}
