import type { GeometryResult } from "../geometry/geometry-protocol.ts";
import type { LogFields } from "../log.ts";
import { ApiFailure } from "./http.ts";
export function geometryValue<T>(result: GeometryResult<T>, log: LogFields): T {
  switch (result.kind) {
    case "ok":
      log["geometryStart"] = result.start;
      log["geometryMs"] = result.ms;
      return result.value;
    case "unavailable":
      log["geometryFailure"] = result.reason;
      throw new ApiFailure("service_unavailable", { "retry-after": "5" });
    case "failed":
      log["geometryStatus"] = result.status;
      if (result.reason === "protocol_violation") log["geometryViolation"] = result.violation;
      log["geometryFailure"] = result.reason;
      throw new ApiFailure("internal_error");
  }
}
