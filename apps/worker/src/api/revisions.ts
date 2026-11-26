import {
  floorPlanQuerySchema,
  floorPlanStoreysHeader,
  formatFloorPlanStoreys,
  patternStateQuerySchema,
  revisionListQuerySchema,
} from "@madori/contracts";
import type { PatternStateResponse, RevisionListResponse } from "@madori/contracts";
import {
  getFloorPlan,
  getPatternState,
  getRevisionView,
  listRevisions,
} from "../services/revisions.ts";
import { decodeRevisionCursor, encodeRevisionCursor } from "./cursor.ts";
import { ApiFailure, readQuery } from "./http.ts";
import { param } from "./router.ts";
import type { Route } from "./router.ts";

const floorPlanCsp = "default-src 'none'; frame-ancestors 'self'";

export const revisionRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/patterns/:patternId/state",
    async handle(context) {
      readQuery(context.url, patternStateQuerySchema);
      const outcome = await getPatternState(context.deps, {
        ownerId: context.user.id,
        patternId: param(context, "patternId"),
      });
      switch (outcome.kind) {
        case "found":
          return Response.json({
            pattern: outcome.state.pattern,
            currentRevision: outcome.state.currentRevision,
            runningJob: outcome.state.runningJob,
            queuedJobs: outcome.state.queuedJobs,
            queueHold: outcome.state.queueHold,
            lastFinishedJob: outcome.state.lastFinishedJob,
          } satisfies PatternStateResponse);
        case "not_found":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
  {
    method: "GET",
    path: "/api/patterns/:patternId/revisions",
    async handle(context) {
      const query = readQuery(context.url, revisionListQuerySchema);
      const outcome = await listRevisions(context.deps, {
        ownerId: context.user.id,
        patternId: param(context, "patternId"),
        after: query.cursor === undefined ? null : decodeRevisionCursor(query.cursor),
      });
      switch (outcome.kind) {
        case "listed":
          return Response.json({
            revisions: outcome.page.revisions,
            nextCursor: outcome.page.next === null ? null : encodeRevisionCursor(outcome.page.next),
          } satisfies RevisionListResponse);
        case "not_found":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
  {
    method: "GET",
    path: "/api/revisions/:revisionId/view",
    async handle(context) {
      const outcome = await getRevisionView(context.deps, {
        ownerId: context.user.id,
        revisionId: param(context, "revisionId"),
      });
      switch (outcome.kind) {
        case "found":
          return new Response(outcome.display.bytes, {
            headers: {
              "content-type": outcome.display.contentType,
              [floorPlanStoreysHeader]: formatFloorPlanStoreys(outcome.storeys),
              "x-revision-id": param(context, "revisionId"),
            },
          });
        case "not_found":
          throw new ApiFailure(outcome.kind);
      }
    },
  },
  {
    method: "GET",
    path: "/api/revisions/:revisionId/floor-plan",
    async handle(context) {
      const { storey } = readQuery(context.url, floorPlanQuerySchema);
      const revisionId = param(context, "revisionId");
      const outcome = await getFloorPlan(context.deps, {
        ownerId: context.user.id,
        revisionId,
        storey,
      });
      if (outcome.kind === "not_found") throw new ApiFailure(outcome.kind);
      return new Response(outcome.artifact.bytes, {
        headers: {
          "content-type": outcome.artifact.contentType,
          "x-revision-id": revisionId,
          "content-security-policy": floorPlanCsp,
          "x-content-type-options": "nosniff",
        },
      });
    },
  },
];
