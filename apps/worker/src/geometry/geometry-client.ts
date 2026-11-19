import type { GeometryCall, GeometryResult, DisplayArtifact } from "./geometry-protocol.ts";
export interface GeometryApi {
  sampleDisplay(call: GeometryCall): Promise<GeometryResult<DisplayArtifact>>;
}
export type GeometryInstance = { kind: "sample" } | { kind: "pattern"; patternId: string };
function geometryInstanceName(key: GeometryInstance): string {
  switch (key.kind) {
    case "sample":
      return "sample";
    case "pattern":
      return `pattern:${key.patternId}`;
  }
}
export function geometryClient(
  getByName: (name: string) => GeometryApi,
): (key: GeometryInstance) => GeometryApi {
  return (key) => ({
    sampleDisplay: (call) =>
      rpcGeometry(() => getByName(geometryInstanceName(key)).sampleDisplay(call)),
  });
}
async function rpcGeometry<T>(call: () => Promise<GeometryResult<T>>): Promise<GeometryResult<T>> {
  try {
    return await call();
  } catch (error) {
    // RPC errors may cross realms and need not inherit Error.
    try {
      if (
        typeof error === "object" &&
        error !== null &&
        (("retryable" in error && error.retryable === true) ||
          ("overloaded" in error && error.overloaded === true))
      )
        return { kind: "unavailable", reason: "unreachable" };
    } catch {
      /* A foreign error may expose throwing getters. */
    }
    throw error;
  }
}
