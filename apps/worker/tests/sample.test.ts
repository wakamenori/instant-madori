import assert from "node:assert/strict";
import { test } from "node:test";
import { startLocalWorker, newUser } from "./support/local-worker.ts";
void test("sample API authenticates and maps disabled containers through real DO RPC", async () => {
  const worker = await startLocalWorker();
  try {
    assert.equal((await worker.call("/api/sample/display")).status, 401);
    const response = await worker.call("/api/sample/display", { as: newUser("sample") });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "service_unavailable" });
    assert.equal(response.headers.get("retry-after"), "5");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const log = await worker.logLine(response.headers.get("x-trace-id") ?? "");
    assert.equal(log["level"], "error");
    assert.equal(log["geometryFailure"], "containers_disabled");
    assert.equal((await worker.call("/api/sample/display", { method: "POST" })).status, 405);
  } finally {
    await worker.stop();
  }
});
