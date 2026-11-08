import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { start, stop } from "./processes.ts";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function ready(url: string, child: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Server exited before ${url} was ready`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch {
      /* The server may still be binding its port. */
    }
    await setTimeout(200);
  }
  throw new Error(`Server startup timed out: ${url}`);
}

const workerPort = await freePort();
const geometryPort = await freePort();
const geometry = start("target/debug/madori-geometry", [], {
  env: { ...process.env, MADORI_GEOMETRY_BIND: `127.0.0.1:${geometryPort}` },
});
const worker = start("pnpm", [
  "--filter",
  "@madori/worker",
  "exec",
  "wrangler",
  "dev",
  "--local",
  "--ip",
  "127.0.0.1",
  "--port",
  String(workerPort),
  "--inspector-port",
  "0",
]);
const processes = [geometry, worker];
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    void stop(processes).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });

try {
  const native = await ready(`http://127.0.0.1:${geometryPort}/healthz`, geometry.child);
  assert.deepEqual(await native.json(), { status: "ok", service: "geometry" });
  const origin = `http://127.0.0.1:${workerPort}`;
  const health = await ready(`${origin}/api/health`, worker.child);
  assert.deepEqual(await health.json(), { status: "ok", service: "worker" });
  assert.equal((await fetch(`${origin}/api/health`, { method: "POST" })).status, 405);
  assert.equal(
    (await fetch(`${origin}/api/missing`, { headers: { accept: "text/html" } })).status,
    404,
  );
  const html = await (await fetch(origin)).text();
  assert.match(html, /instant-madori/);
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert(script, "Built web entry must be served by Workers Static Assets");
  const js = await (await fetch(new URL(script, origin))).text();
  const wasmPath = js.match(/\/assets\/[^"'`\s]+\.wasm/)?.[0];
  assert(wasmPath, "Built JavaScript must reference the emitted Wasm file");
  const wasmResponse = await fetch(new URL(wasmPath, origin));
  assert.equal(wasmResponse.status, 200);
  assert.match(wasmResponse.headers.get("content-type") ?? "", /application\/wasm/);
  const wasmBytes = Buffer.from(await wasmResponse.arrayBuffer());
  assert.deepEqual(
    wasmBytes,
    await readFile(new URL("../crates/viewer/pkg/madori_viewer_bg.wasm", import.meta.url)),
  );
  const viewer = await import("../crates/viewer/pkg/madori_viewer.js");
  await viewer.default({ module_or_path: wasmBytes });
  assert.equal(viewer.check_runtime(), true);
  if (interrupted) throw new Error("Smoke check interrupted");
  console.log(
    "Smoke passed: native engine startup, Worker routes, static assets, Wasm delivery and initialization.",
  );
} finally {
  await stop(processes);
}
