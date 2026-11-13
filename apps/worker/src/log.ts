type LogValue = string | number | boolean | undefined;

/** Fields attached to a request's log line. Never put request bodies, names or tokens here. */
export type LogFields = Record<string, LogValue>;

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
export function describeError(error: unknown, depth = 0): string {
  if (!(error instanceof Error)) return typeof error;
  const parts = [`${error.name}: ${error.message}`];
  if (depth < 3) {
    if (error instanceof AggregateError) {
      for (const inner of error.errors) parts.push(describeError(inner, depth + 1));
    } else if (error.cause !== undefined) {
      parts.push(describeError(error.cause, depth + 1));
    }
  }
  return parts.join(" <- ");
}
