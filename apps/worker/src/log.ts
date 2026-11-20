import { z } from "zod";

const errorDescription: unique symbol = Symbol("ErrorDescription");
const errorDescriptionSchema = z.string().brand(errorDescription);

export interface LogFields {
  traceId?: string;
  rayId?: string | undefined;
  method?: string;
  route?: string;
  userId?: string;
  status?: number;
  ms?: number;
  error?: ReturnType<typeof describeError>;
  requestId?: string;
  patternId?: string;
  jobId?: string;
  messageId?: string;
  messageNumber?: number;
  stop?: "applied" | "replayed";
  jobState?: "cancelled" | "completed" | "failed";
  acceptance?: "applied" | "replayed";
  generation?: number;
  step?: string;
  attempt?: number;
  outcome?: string;
  revisionId?: string;
  instance?: "created" | "existing";
  bytes?: number;
  geometryStart?: "cold" | "warm";
  geometryMs?: number;
  geometryFailure?: string;
  geometryStatus?: number;
  geometryViolation?: string;
  reason?: string;
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
  jobId: "string",
  messageId: "string",
  messageNumber: "number",
  stop: "string",
  jobState: "string",
  acceptance: "string",
  generation: "number",
  step: "string",
  attempt: "number",
  outcome: "string",
  revisionId: "string",
  instance: "string",
  bytes: "number",
  geometryStart: "string",
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
