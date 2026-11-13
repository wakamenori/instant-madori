import { createPatternRequestSchema, renameRequestSchema } from "@madori/contracts";
import type { PatternListResponse, PatternResponse } from "@madori/contracts";
import { createPattern, listPatterns, renamePattern } from "../services/patterns.ts";
import { ApiFailure, readJsonBody } from "./http.ts";
import { param } from "./router.ts";
import type { Route } from "./router.ts";

export const patternRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/projects/:projectId/patterns",
    async handle(context) {
      const outcome = await listPatterns(context.deps, {
        ownerId: context.user.id,
        projectId: param(context, "projectId"),
      });
      switch (outcome.kind) {
        case "listed":
          return Response.json({ patterns: outcome.patterns } satisfies PatternListResponse);
        case "not_found":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
  {
    method: "POST",
    path: "/api/projects/:projectId/patterns",
    async handle(context) {
      const { request, deps, user, log } = context;
      const input = await readJsonBody(request, createPatternRequestSchema);
      log["requestId"] = input.requestId;
      const outcome = await createPattern(deps, {
        ownerId: user.id,
        requestId: input.requestId,
        projectId: param(context, "projectId"),
        name: input.name,
      });
      switch (outcome.kind) {
        case "created":
          return Response.json({ pattern: outcome.pattern } satisfies PatternResponse, {
            status: 201,
          });
        case "not_found":
        case "request_id_reused":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
  {
    method: "PATCH",
    path: "/api/patterns/:patternId",
    async handle(context) {
      const { request, deps, user, log } = context;
      const input = await readJsonBody(request, renameRequestSchema);
      log["requestId"] = input.requestId;
      const outcome = await renamePattern(deps, {
        ownerId: user.id,
        requestId: input.requestId,
        patternId: param(context, "patternId"),
        version: input.version,
        name: input.name,
      });
      switch (outcome.kind) {
        case "renamed":
          return Response.json({ pattern: outcome.pattern } satisfies PatternResponse);
        case "not_found":
        case "version_conflict":
        case "request_id_reused":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
];
