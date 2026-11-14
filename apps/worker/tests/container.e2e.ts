import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { geometryInternal } from "@madori/contracts/geometry-internal";
import { startLocalWorker, newUser } from "./support/local-worker.ts";
// Keep container cases here as subtests sharing one Docker boot.
void test(
  "real Linux container returns an artifact over Worker and DO RPC",
  { timeout: 900_000 },
  async () => {
    const started = performance.now();
    const worker = await startLocalWorker({ containers: true, readyTimeoutMs: 800_000 });
    const bootMs = performance.now() - started;
    try {
      const viewer = await import("../../../crates/viewer/pkg/madori_viewer.js");
      await viewer.default({
        module_or_path: await readFile(
          new URL("../../../crates/viewer/pkg/madori_viewer_bg.wasm", import.meta.url),
        ),
      });
      assert.equal((await worker.call("/api/sample/display")).status, 401);
      const user = newUser("container");
      for (const start of ["cold", "warm"]) {
        const requested = performance.now();
        const response = await worker.call("/api/sample/display", { as: user });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("content-type"), geometryInternal.displayContentType);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const requestMs = performance.now() - requested;
        const summary = viewer.describe_display(bytes);
        assert.equal(summary.format_version, 1);
        assert.equal(summary.bodies, 4);
        assert.deepEqual(summary.elements, [
          "sample:slab",
          "sample:wall-north",
          "sample:wall-west",
          "sample:wall-east",
        ]);
        summary.free();
        const log = await worker.logLine(response.headers.get("x-trace-id") ?? "");
        assert.equal(log["geometryStart"], start);
        console.info(
          JSON.stringify({
            environment: "local Docker amd64 emulation",
            start,
            bootMs,
            requestMs,
            bytes: bytes.byteLength,
            gatewayMs: log["geometryMs"],
          }),
        );
      }
      assert.equal(
        worker.logEntries().filter((entry) => entry["event"] === "container.started").length,
        1,
      );
    } finally {
      await worker.stop();
    }
  },
);
