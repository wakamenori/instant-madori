import { getSampleDisplay } from "../services/geometry.ts";
import { geometryValue } from "./geometry.ts";
import type { Route } from "./router.ts";
export const sampleRoutes: Route[] = [
  {
    method: "GET",
    path: "/api/sample/display",
    async handle({ deps, traceId, log }) {
      const artifact = geometryValue(await getSampleDisplay(deps, { traceId }), log);
      log["bytes"] = artifact.bytes.byteLength;
      return new Response(artifact.bytes, { headers: { "content-type": artifact.contentType } });
    },
  },
];
