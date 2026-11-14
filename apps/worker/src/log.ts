import { z } from "zod";

const errorDescriptionSchema = z.string().brand<"ErrorDescription">();

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

/** Writes one structured log line; Workers Logs indexes the JSON fields. */
export function logEvent(level: "info" | "error", event: string, fields: LogFields) {
  const line = JSON.stringify({ level, event, ...fields });
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
