import { createAssetQuerySchema, type CreateAssetResponse } from "@madori/contracts";
import { assetUploadMaxBytes, createAsset } from "../services/assets.ts";
import { ApiFailure, readBodyBytes, readQuery } from "./http.ts";
import type { Route } from "./router.ts";

export const assetRoute: Route = {
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
};
