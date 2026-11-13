import assert from "node:assert/strict";
import { test } from "node:test";
import { apiErrorSchema, workerHealthSchema } from "@madori/contracts";
import { startLocalWorker, testSpaHtml } from "./support/local-worker.ts";

/** A lowercase UUID of any version; trace IDs are opaque, only their form is fixed. */
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

await test("HTTP surface", async (t) => {
  const worker = await startLocalWorker();
  t.after(() => worker.stop());

  await t.test(
    "health answers without authentication and matches the shared contract",
    async () => {
      const response = await worker.call("/api/health");
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      assert.equal(workerHealthSchema.safeParse(await response.json()).success, true);
    },
  );

  await t.test("unsupported methods return 405 and advertise the allowed ones", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "HEAD"]) {
      const health = await worker.call("/api/health", { method });
      assert.equal(health.status, 405, method);
      assert.equal(health.headers.get("allow"), "GET", method);
    }
    const projects = await worker.call("/api/projects", { method: "DELETE" });
    assert.equal(projects.status, 405);
    assert.equal(projects.headers.get("allow"), "GET, POST");
  });

  await t.test(
    "unknown API routes return a JSON 404 even when the browser accepts HTML",
    async () => {
      const response = await worker.navigate("/api/missing");
      assert.equal(response.status, 404);
      assert.deepEqual(apiErrorSchema.parse(JSON.parse(response.body)), { error: "not_found" });
    },
  );

  await t.test("other paths are the SPA, so the API checks above are meaningful", async () => {
    const response = await worker.navigate("/projects/123");
    assert.equal(response.status, 200);
    assert.equal(response.body, testSpaHtml);
  });

  await t.test("trace IDs are ours, never taken from the client", async () => {
    const ids = new Set<string>();
    // Includes IDs that already look like ours, which a "propagate the caller's ID" change
    // could be tempted to adopt.
    const [rayUuid, traceUuid] = [crypto.randomUUID(), crypto.randomUUID()];
    const sent: Record<string, string>[] = [
      // The same input twice: a fresh ID each time, so IDs are not derived from headers.
      { "cf-ray": "230b030023ae2822-SJC" },
      { "cf-ray": "230b030023ae2822-SJC" },
      { "cf-ray": "x".repeat(5000) },
      { "cf-ray": rayUuid },
      { "x-trace-id": traceUuid },
      { "cf-ray": rayUuid, "x-trace-id": traceUuid },
    ];
    for (const [index, headers] of sent.entries()) {
      const response = await worker.call("/api/health", { headers });
      const traceId = response.headers.get("x-trace-id");
      const label = `#${index} ${JSON.stringify(headers).slice(0, 60)}`;
      assert.ok(traceId, label);
      assert.match(traceId, uuidPattern, label);
      assert.notEqual(traceId, rayUuid, label);
      assert.notEqual(traceId, traceUuid, label);
      // The request's log line exists under the same, server-made ID.
      await worker.logLine(traceId);
      ids.add(traceId);
    }
    // And no log line was written under any value the client sent. Each request's
    // `api.request` line, its last line, was awaited above. Error-level lines go to stderr,
    // which is not ordered with stdout, so for those this covers only lines already arrived.
    const clientValues = new Set(sent.flatMap((headers) => Object.values(headers)));
    const adopted = worker
      .logEntries()
      .filter((entry) => clientValues.has(String(entry["traceId"])));
    assert.deepEqual(adopted, []);
    assert.equal(ids.size, sent.length, "every request gets a fresh trace ID");
  });

  await t.test("a well-formed Cloudflare ray ID is logged beside the trace ID", async () => {
    const valid = "230b030023ae2822-SJC";
    for (const [ray, logged] of [
      [valid, valid],
      // A valid ID with anything around it must be rejected as a whole.
      [`<script>${valid}</script>`, undefined],
      [`${valid}x`, undefined],
      [`x${valid}`, undefined],
      // Character classes and lengths are exact, too.
      ["230B030023AE2822-SJC", undefined],
      ["230b030023ae282-SJC", undefined],
      ["230b030023ae28221-SJC", undefined],
      ["230b030023ae2822-sjc", undefined],
      ["230b030023ae2822-SJCX", undefined],
      ["forged<script>", undefined],
      ["x".repeat(5000), undefined],
      // No header (most requests outside Cloudflare) and an empty one log nothing.
      [null, undefined],
      ["", undefined],
    ] as const) {
      const response = await worker.call("/api/health", {
        headers: ray === null ? {} : { "cf-ray": ray },
      });
      const traceId = response.headers.get("x-trace-id");
      assert.ok(traceId, "every API response carries a trace ID");
      assert.match(traceId, uuidPattern);
      const line = await worker.logLine(traceId);
      assert.equal(line["rayId"], logged, JSON.stringify(ray).slice(0, 40));
    }
  });

  await t.test("API responses are uncacheable and carry a trace ID", async () => {
    for (const path of ["/api/health", "/api/missing", "/api/me"]) {
      const response = await worker.call(path);
      assert.equal(response.headers.get("cache-control"), "no-store", path);
      assert.match(response.headers.get("x-trace-id") ?? "", uuidPattern, path);
    }
  });
});
