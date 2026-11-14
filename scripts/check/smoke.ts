import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { repositoryRoot } from "../shared/repository.ts";
import { freePort, ready, start, stop } from "../shared/processes.ts";

const workerPort = await freePort();
const geometryPort = await freePort();
const token = randomBytes(32).toString("base64url");
const geometry = start("target/debug/madori-geometry", [], {
  env: {
    ...process.env,
    MADORI_INTERNAL_TOKEN: token,
    MADORI_GEOMETRY_BIND: `127.0.0.1:${geometryPort}`,
  },
});
const worker = start("pnpm", [
  "--filter",
  "@madori/worker",
  "exec",
  "wrangler",
  "dev",
  "--local",
  "--enable-containers=false",
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
  assert.deepEqual(await native.json(), { status: "ok", service: "geometry", protocol: 1 });
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
    await readFile(new URL("crates/viewer/pkg/madori_viewer_bg.wasm", repositoryRoot)),
  );
  const viewer = await import("../../crates/viewer/pkg/madori_viewer.js");
  await viewer.default({ module_or_path: wasmBytes });
  const displayUrl = `http://127.0.0.1:${geometryPort}/v1/sample/display`;
  assert.equal((await fetch(displayUrl)).status, 401);
  const display = await fetch(displayUrl, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(display.status, 200);
  const summary = viewer.describe_display(new Uint8Array(await display.arrayBuffer()));
  assert.equal(summary.bodies, 4);
  assert.deepEqual(summary.elements, [
    "sample:slab",
    "sample:wall-north",
    "sample:wall-west",
    "sample:wall-east",
  ]);
  summary.free();
  assert.throws(() => viewer.describe_display(new Uint8Array([0])));
  if (interrupted) throw new Error("Smoke check interrupted");
  console.log(
    "Smoke passed: native engine startup, Worker routes, static assets, Wasm delivery, native-to-Wasm display decoding and authentication failure.",
  );
} finally {
  await stop(processes);
}
