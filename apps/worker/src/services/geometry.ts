import type { ServiceDeps } from "./deps.ts";
import type { GeometryCall } from "../geometry/geometry-protocol.ts";
import type { DisplayArtifact, GeometryResult } from "../geometry/geometry-protocol.ts";
export function getSampleDisplay(
  { geometry }: Pick<ServiceDeps, "geometry">,
  call: GeometryCall,
): Promise<GeometryResult<DisplayArtifact>> {
  return geometry({ kind: "sample" }).sampleDisplay(call);
}
