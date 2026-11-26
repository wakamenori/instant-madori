import { z } from "zod";
import {
  applyOperationsRequestSchema,
  summarizeHouseRequestSchema,
} from "@madori/contracts/geometry-internal";
import app from "../../src/index.ts";
import { geometryClient } from "../../src/geometry/geometry-client.ts";
export { GeometryContainer, PatternCoordinator, JobWorkflow } from "../../src/index.ts";
const probe = z.object({
  patternId: z.string(),
  traceId: z.string(),
  body: applyOperationsRequestSchema,
});
export default {
  ...app,
  async fetch(request: Request, env: Env) {
    if (request.method === "POST" && new URL(request.url).pathname === "/api/__probe/summary") {
      const { patternId, traceId, body } = probe
        .extend({ body: summarizeHouseRequestSchema })
        .parse(await request.json());
      return Response.json(
        await geometryClient((name) => env.GEOMETRY.getByName(name))({
          kind: "pattern",
          patternId,
        }).summarizeHouse({ traceId }, body),
      );
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/__probe/operations")
      return app.fetch(request, env);
    const { patternId, traceId, body } = probe.parse(await request.json());
    const result = await geometryClient((name) => env.GEOMETRY.getByName(name))({
      kind: "pattern",
      patternId,
    }).applyOperations({ traceId }, body);
    if (result.kind !== "ok" || result.value.kind !== "applied") return Response.json(result);
    const parts = result.value.parts.map(({ bytes, ...part }) => ({
      ...part,
      bytes: btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join("")),
    }));
    return Response.json({ ...result, value: { ...result.value, parts } });
  },
} satisfies ExportedHandler<Env>;
