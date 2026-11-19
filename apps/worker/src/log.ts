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

const logKeys = {
  traceId: true,
  rayId: true,
  method: true,
  route: true,
  userId: true,
  status: true,
  ms: true,
  error: true,
  requestId: true,
  patternId: true,
  jobId: true,
  messageId: true,
  messageNumber: true,
  stop: true,
  jobState: true,
  acceptance: true,
  generation: true,
  step: true,
  attempt: true,
  outcome: true,
  revisionId: true,
  instance: true,
  bytes: true,
  geometryStart: true,
  geometryMs: true,
  geometryFailure: true,
  geometryStatus: true,
  geometryViolation: true,
  reason: true,
  why: true,
  image: true,
  mode: true,
} satisfies Record<keyof LogFields, true>;

/** Writes one structured log line; Workers Logs indexes the JSON fields. */
export function logEvent(level: "info" | "error", event: string, fields: LogFields) {
  const allowed = Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) =>
        Object.hasOwn(logKeys, key) && (typeof value === "string" || typeof value === "number"),
    ),
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
