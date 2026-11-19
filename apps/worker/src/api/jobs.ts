import { stopJobRequestSchema } from "@madori/contracts";
import type { StopJobResponse } from "@madori/contracts";
import { stopJob } from "../services/jobs.ts";
import { ApiFailure, readJsonBody } from "./http.ts";
import { param } from "./router.ts";
import type { Route } from "./router.ts";

export const jobRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/jobs/:jobId/stop",
    async handle(context) {
      const { request, deps, user, log } = context;
      const input = await readJsonBody(request, stopJobRequestSchema);
      const jobId = param(context, "jobId");
      log["requestId"] = input.requestId;
      log["jobId"] = jobId;
      const outcome = await stopJob(deps, { ownerId: user.id, jobId, ...input });
      switch (outcome.kind) {
        case "stop": {
          const { patternId, ...body } = outcome.result;
          const result = outcome.result;
          log["patternId"] = patternId;
          log["stop"] = outcome.record;
          log["outcome"] = result.outcome;
          log["jobState"] = result.job.state;
          if (result.job.state === "completed") log["revisionId"] = result.job.revision.id;
          return Response.json(body satisfies StopJobResponse);
        }
        case "not_found":
        case "request_id_reused":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
];
