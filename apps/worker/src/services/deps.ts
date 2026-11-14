import type { Store } from "../storage/store.ts";
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
  store: Store;
  geometry: (key: GeometryInstance) => GeometryApi;
  runtime: Runtime;
}

export type StoreDeps<K extends keyof Store, O extends keyof Store[K]> = {
  store: { [P in K]: Pick<Store[P], O> };
};
