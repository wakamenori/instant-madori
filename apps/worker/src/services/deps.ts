import { geometryClient } from "../geometry/geometry-client.ts";
import type { GeometryApi, GeometryInstance } from "../geometry/geometry-client.ts";
/**
 * What services need from the outside world. Services never read the clock or generate IDs
 * themselves, so tests and replays can control both.
 */
export interface Runtime {
  /** Current time as an ISO 8601 UTC string. */
  now(): string;
  /** A new random UUID for a stored entity (user, project, pattern). */
  newId(): string;
  /**
   * A new random ID for one request's log line and `x-trace-id` header. Separate from
   * `newId` so that requests never consume entity IDs from a controlled sequence.
   */
  newTraceId(): string;
}

export interface ServiceDeps {
  db: D1Database;
  bucket: R2Bucket;
  geometry: (key: GeometryInstance) => GeometryApi;
  runtime: Runtime;
}

export const systemRuntime: Runtime = {
  now: () => new Date().toISOString(),
  newId: () => crypto.randomUUID(),
  newTraceId: () => crypto.randomUUID(),
};

export function serviceDeps(
  env: Pick<Env, "DB" | "BLOBS" | "GEOMETRY">,
  runtime: Runtime,
): ServiceDeps {
  return {
    db: env.DB,
    bucket: env.BLOBS,
    runtime,
    geometry: geometryClient((name) => env.GEOMETRY.getByName(name)),
  };
}
