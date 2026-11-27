import type {
  HouseSummary,
  SummarizeHouseRequest,
  ApplyOperationsOutcome,
  ApplyOperationsRequest,
} from "@madori/contracts/geometry-internal";
import type {
  WithPartBytes,
  GeometryCall,
  GeometryResult,
  DisplayArtifact,
} from "./geometry-protocol.ts";
export interface GeometryApi {
  summarizeHouse(
    call: GeometryCall,
    request: SummarizeHouseRequest,
  ): Promise<GeometryResult<HouseSummary>>;
  applyOperations(
    call: GeometryCall,
    request: ApplyOperationsRequest,
  ): Promise<GeometryResult<WithPartBytes<ApplyOperationsOutcome>>>;
  sampleDisplay(call: GeometryCall): Promise<GeometryResult<DisplayArtifact>>;
}
export type GeometryInstance = { kind: "pattern"; patternId: string };
export function geometryClient(
  getByName: (name: string) => GeometryApi,
): (key: GeometryInstance) => GeometryApi {
  return (key) => ({
    summarizeHouse: (call, request) =>
      rpcGeometry(() => getByName(`pattern:${key.patternId}`).summarizeHouse(call, request)),
    applyOperations: (call, request) =>
      rpcGeometry(() => getByName(`pattern:${key.patternId}`).applyOperations(call, request)),
    sampleDisplay: (call) =>
      rpcGeometry(() => getByName(`pattern:${key.patternId}`).sampleDisplay(call)),
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
