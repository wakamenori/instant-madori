import { releaseQueueRequestSchema } from "@madori/contracts";
import { releaseQueue } from "../services/jobs.ts";
import { ApiFailure, readJsonBody } from "./http.ts";
import { param } from "./router.ts";
import type { Route } from "./router.ts";

function queueRoute(action: "resume" | "cancel"): Route {
  return {
    method: "POST",
    path: `/api/patterns/:patternId/queue/${action}`,
    async handle(context) {
      const { deps, user, request, log } = context;
      const patternId = param(context, "patternId");
      const { requestId, heldBy } = await readJsonBody(request, releaseQueueRequestSchema);
      Object.assign(log, { requestId, patternId, heldBy });
      const outcome = await releaseQueue(
        deps,
        { ownerId: user.id, requestId, patternId, heldBy },
        action,
      );
      if (outcome.kind !== "released") throw new ApiFailure(outcome.kind);
      log.queue = outcome.record;
      log.outcome = action === "resume" ? "resumed" : "cancelled";
      return Response.json(outcome.result);
    },
  };
}
export const queueRoutes = [queueRoute("resume"), queueRoute("cancel")];
