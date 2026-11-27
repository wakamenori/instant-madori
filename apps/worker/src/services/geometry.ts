import type {
  ApplyOperationsRequest,
  SummarizeHouseRequest,
} from "@madori/contracts/geometry-internal";
import type { ServiceDeps } from "./deps.ts";
import type { UnavailableReason } from "../geometry/container-gateway.ts";
import type { GeometryResult } from "../geometry/geometry-protocol.ts";

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
  PermanentUnavailable | Extract<GeometryResult<unknown>, { kind: "failed" }>["reason"];
function permanentUnavailable(reason: UnavailableReason): reason is PermanentUnavailable {
  return afterUnavailable[reason] === "fail";
}

export async function applyHouseOperations(
  { geometry }: Pick<ServiceDeps, "geometry">,
  patternId: string,
  request: ApplyOperationsRequest,
) {
  const response = await geometry({ kind: "pattern", patternId }).applyOperations(
    { traceId: request.job_id },
    request,
  );
  return geometryOutcome(response);
}
export async function summarizeHouse(
  { geometry }: Pick<ServiceDeps, "geometry">,
  patternId: string,
  traceId: string,
  request: SummarizeHouseRequest,
) {
  return geometryOutcome(
    await geometry({ kind: "pattern", patternId }).summarizeHouse({ traceId }, request),
  );
}
function geometryOutcome<T>(response: GeometryResult<T>) {
  if (response.kind !== "unavailable") return response;
  const reason = response.reason;
  return permanentUnavailable(reason)
    ? { kind: "failed" as const, reason }
    : { kind: "retry" as const, reason };
}
