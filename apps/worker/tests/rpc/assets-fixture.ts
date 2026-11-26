import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { z } from "zod";
import { getTestPlatformProxy } from "./platform-proxy.ts";

const state = z.string().min(1).parse(process.argv[2]);
const input = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("inspect"), ownerId: z.uuid() }),
    z.object({
      kind: z.literal("damage"),
      assetId: z.uuid(),
      how: z.enum(["rewrite", "missing", "media_type"]),
    }),
  ])
  .parse(JSON.parse(process.argv[3] ?? ""));
const proxy = await getTestPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
  configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
  persist: { path: join(state, "v3") },
  remoteBindings: false,
});
try {
  const { DB, BLOBS } = proxy.env;
  if (input.kind === "inspect") {
    const { ownerId } = input;
    const rows = await DB.prepare("SELECT * FROM assets WHERE owner_id = ? ORDER BY id")
      .bind(ownerId)
      .all();
    const list = await BLOBS.list({ prefix: `owners/${ownerId}/assets/` });
    assert(!list.truncated);
    const objects = [];
    for (const { key } of list.objects) {
      const obj = await BLOBS.get(key);
      assert(obj);
      objects.push({
        key,
        size: obj.size,
        contentType: obj.httpMetadata?.contentType,
        sha256: createHash("sha256")
          .update(new Uint8Array(await obj.arrayBuffer()))
          .digest("hex"),
      });
    }
    console.log(JSON.stringify({ rows: rows.results, objects }));
  } else if (input.how === "media_type") {
    await DB.prepare("UPDATE assets SET media_type = 'image/gif' WHERE id = ?")
      .bind(input.assetId)
      .run();
  } else {
    const key = z
      .string()
      .parse(
        await DB.prepare("SELECT object_key FROM assets WHERE id = ?")
          .bind(input.assetId)
          .first("object_key"),
      );
    if (input.how === "missing") await BLOBS.delete(key);
    else {
      const object = await BLOBS.get(key);
      assert(object);
      const bytes = new Uint8Array(await object.arrayBuffer());
      assert(bytes[0] !== undefined);
      bytes[0] ^= 0xff;
      await BLOBS.put(key, bytes);
    }
  }
} finally {
  await proxy.dispose();
}
