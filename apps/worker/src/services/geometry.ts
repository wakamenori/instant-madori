import type { ServiceDeps } from "./deps.ts";
import type { UnavailableReason } from "../geometry/container-gateway.ts";
import type { GeometryCall } from "../geometry/geometry-protocol.ts";
import type { DisplayArtifact, GeometryResult } from "../geometry/geometry-protocol.ts";
export function getSampleDisplay(
  { geometry }: Pick<ServiceDeps, "geometry">,
  call: GeometryCall,
): Promise<GeometryResult<DisplayArtifact>> {
  return geometry({ kind: "sample" }).sampleDisplay(call);
}

const afterUnavailable = {
  containers_disabled: "fail",
  protocol_mismatch: "fail",
  start_failed: "retry",
  exited: "retry",
  not_ready: "retry",
  token_rejected: "retry",
  unreachable: "retry",
} as const satisfies Record<UnavailableReason, "retry" | "fail">;

type PermanentUnavailable = {
  [R in UnavailableReason]: (typeof afterUnavailable)[R] extends "fail" ? R : never;
}[UnavailableReason];
export type GeometryFailure =
  PermanentUnavailable | Extract<GeometryResult<DisplayArtifact>, { kind: "failed" }>["reason"];
export type PatternSample =
  | { kind: "rendered"; display: Uint8Array<ArrayBuffer> }
  | { kind: "retry"; reason: UnavailableReason }
  | { kind: "failed"; reason: GeometryFailure };

function permanentUnavailable(reason: UnavailableReason): reason is PermanentUnavailable {
  return afterUnavailable[reason] === "fail";
}

export async function renderPatternSample(
  { geometry }: Pick<ServiceDeps, "geometry">,
  input: { patternId: string; traceId: string },
): Promise<PatternSample> {
  const result = await geometry({ kind: "pattern", patternId: input.patternId }).sampleDisplay({
    traceId: input.traceId,
  });
  switch (result.kind) {
    case "ok":
      return { kind: "rendered", display: new Uint8Array(result.value.bytes) };
    case "failed":
      return { kind: "failed", reason: result.reason };
    case "unavailable": {
      const reason = result.reason;
      return permanentUnavailable(reason) ? { kind: "failed", reason } : { kind: "retry", reason };
    }
  }
}
