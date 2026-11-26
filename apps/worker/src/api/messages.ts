import { acceptInstructionRequestSchema } from "@madori/contracts";
import type { AcceptInstructionResponse } from "@madori/contracts";
import { acceptInstruction } from "../services/jobs.ts";
import { ApiFailure, readJsonBody } from "./http.ts";
import { param } from "./router.ts";
import type { Route } from "./router.ts";

export const messageRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/patterns/:patternId/messages",
    async handle(context) {
      const { request, deps, user, log } = context;
      const input = await readJsonBody(request, acceptInstructionRequestSchema, {
        maxBytes: 128 * 1024,
      });
      const patternId = param(context, "patternId");
      log["requestId"] = input.requestId;
      log["patternId"] = patternId;
      const outcome = await acceptInstruction(deps, { ownerId: user.id, patternId, ...input });
      switch (outcome.kind) {
        case "accepted":
          log["jobId"] = outcome.job.jobId;
          log["messageId"] = outcome.job.messageId;
          log["messageNumber"] = outcome.job.number;
          log["acceptance"] = outcome.acceptance;
          return Response.json({ job: outcome.job } satisfies AcceptInstructionResponse, {
            status: 202,
          });
        case "invalid_message":
          throw new ApiFailure("invalid_request");
        case "attachment_unavailable":
        case "not_found":
        case "request_id_reused":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
];
