import { pickRequestSchema, type PickResponse } from "@madori/contracts";
import { pickElement } from "../services/selection.ts";
import { ApiFailure, readJsonBody } from "./http.ts";
import { param, type Route } from "./router.ts";

export const pickRoute: Route = {
  method: "POST",
  path: "/api/revisions/:revisionId/pick",
  async handle(context) {
    const request = await readJsonBody(context.request, pickRequestSchema);
    const outcome = await pickElement(context.deps, {
      ownerId: context.user.id,
      revisionId: param(context, "revisionId"),
      request,
    });
    if (outcome.kind !== "picked") throw new ApiFailure(outcome.kind);
    return Response.json({
      target: outcome.target,
      element: outcome.element,
    } satisfies PickResponse);
  },
};
