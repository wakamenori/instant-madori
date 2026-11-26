import assert from "node:assert/strict";
import { URL, fileURLToPath } from "node:url";
import { join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { z } from "zod";

const state = z.string().min(1).parse(process.argv[2]);
const proxy = await getPlatformProxy<Pick<Env, "DB">>({
  configPath: fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)),
  persist: { path: join(state, "v3") },
  remoteBindings: false,
});
try {
  if (process.argv[3] === "counts") {
    const counts = await proxy.env.DB.prepare(
      `SELECT
      (SELECT count(*) FROM messages) AS messages,
      (SELECT count(*) FROM jobs) AS jobs,
      (SELECT count(*) FROM requests) AS requests,
      (SELECT count(*) FROM message_attachments) AS attachments`,
    ).first();
    console.log(JSON.stringify(counts));
  } else {
    const jobId = z.uuid().parse(process.argv[3]);
    const jobState = z.enum(["completed", "cancelled"]).parse(process.argv[4]);
    const result = await proxy.env.DB.prepare("UPDATE jobs SET state = ? WHERE id = ?")
      .bind(jobState, jobId)
      .run();
    assert.equal(result.meta.changes, 1);
  }
} finally {
  await proxy.dispose();
}
