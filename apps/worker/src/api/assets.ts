import { createAssetQuerySchema, type CreateAssetResponse } from "@madori/contracts";
import { assetUploadMaxBytes, createAsset, readAsset } from "../services/assets.ts";
import { ApiFailure, readBodyBytes, readQuery } from "./http.ts";
import { param, type Route } from "./router.ts";

export const assetRoutes: Route[] = [
  {
    method: "POST",
    path: "/api/assets",
    async handle({ url, request, user, deps, log }) {
      const { requestId } = readQuery(url, createAssetQuerySchema);
      log["requestId"] = requestId;
      const outcome = await createAsset(deps, {
        ownerId: user.id,
        requestId,
        contentType: request.headers.get("content-type"),
        bytes: await readBodyBytes(request, assetUploadMaxBytes),
      });
      if (outcome.kind !== "created") throw new ApiFailure(outcome.kind);
      return Response.json({ asset: outcome.asset } satisfies CreateAssetResponse, { status: 201 });
    },
  },
  {
    method: "GET",
    path: "/api/assets/:assetId",
    async handle(context) {
      const outcome = await readAsset(context.deps, {
        ownerId: context.user.id,
        assetId: param(context, "assetId"),
      });
      if (outcome.kind === "not_found") throw new ApiFailure(outcome.kind);
      return new Response(outcome.content.body, {
        headers: { "content-type": outcome.content.mediaType, "x-content-type-options": "nosniff" },
      });
    },
  },
];
