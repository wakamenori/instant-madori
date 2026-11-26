import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { z } from "zod";
import { getTestPlatformProxy } from "./platform-proxy.ts";

const state = z.string().min(1).parse(process.argv[2]);
const ownerId = z.uuid().parse(process.argv[3]);
const proxy = await getTestPlatformProxy<Pick<Env, "DB" | "BLOBS">>({
  configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
  persist: { path: join(state, "v3") },
  remoteBindings: false,
});
try {
  const { DB, BLOBS } = proxy.env;
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
} finally {
  await proxy.dispose();
}
