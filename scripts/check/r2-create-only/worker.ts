import assert from "node:assert/strict";
import { r2 } from "../../../apps/worker/src/storage/r2.ts";
import { original, stepSchema } from "./protocol.ts";
import type { Step } from "./protocol.ts";

export async function runStep(bucket: R2Bucket, key: string, step: Step): Promise<void> {
  const adapter = r2(bucket);
  switch (step) {
    case "first":
      assert.equal(await bucket.head(key), null, "probe key must be absent");
      await adapter.putNew(key, original, "application/octet-stream");
      break;
    case "reject":
      await assert.rejects(
        adapter.putNew(key, new Uint8Array([2, 3]), "application/octet-stream"),
        { message: `R2 object ${key} already exists` },
      );
      break;
    case "direct":
      assert.equal(
        await bucket.put(key, new Uint8Array([4, 5]), {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: "application/octet-stream" },
        }),
        null,
        "direct conditional put must return null",
      );
      break;
    case "delete":
      await bucket.delete(key);
      assert.equal(await bucket.head(key), null, "probe key must be deleted");
      return;
  }
  assert.deepEqual(await adapter.read(key), { bytes: original }, "original bytes must remain");
}

export default {
  async fetch(request: Request, env: { BLOBS: R2Bucket; PROBE_TOKEN: string; PROBE_KEY: string }) {
    if (new URL(request.url).pathname === "/health") return Response.json({ ok: true });
    if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`)
      return new Response(null, { status: 403 });
    const parsed = stepSchema.safeParse(new URL(request.url).pathname.slice(1));
    if (request.method !== "POST" || !parsed.success) return new Response(null, { status: 400 });
    try {
      await runStep(env.BLOBS, env.PROBE_KEY, parsed.data);
      return Response.json({ ok: true, step: parsed.data, key: env.PROBE_KEY });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Probe failed" },
        { status: 500 },
      );
    }
  },
};
