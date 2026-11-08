import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { setTimeout } from "node:timers/promises";
import { start, stop } from "./processes.mjs";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function ready(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Server exited before ${url} was ready`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return response;
    } catch { /* The server may still be binding its port. */ }
    await setTimeout(200);
  }
  throw new Error(`Server startup timed out: ${url}`);
}

const workerPort = await freePort();
const geometryPort = await freePort();
const geometry = start("target/debug/madori-geometry", [], { env: { ...process.env, MADORI_GEOMETRY_BIND: `127.0.0.1:${geometryPort}` } });
const worker = start("pnpm", ["--filter", "@madori/worker", "exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1", "--port", String(workerPort), "--inspector-port", "0"]);
const processes = [geometry, worker];
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { interrupted = true; void stop(processes); });

try {
  const native = await ready(`http://127.0.0.1:${geometryPort}/healthz`, geometry.child);
  assert.deepEqual(await native.json(), { status: "ok", service: "geometry" });
  const origin = `http://127.0.0.1:${workerPort}`;
  const health = await ready(`${origin}/api/health`, worker.child);
  assert.deepEqual(await health.json(), { status: "ok", service: "worker" });
  assert.equal((await fetch(`${origin}/api/health`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/api/missing`, { headers: { accept: "text/html" } })).status, 404);
  const html = await (await fetch(origin)).text();
  assert.match(html, /instant-madori/);
  const script = html.match(/src="([^"]+\.js)"/);
  assert(script, "Built web entry must be served by Workers Static Assets");
  const js = await (await fetch(new URL(script[1], origin))).text();
  const wasmPath = js.match(/\/assets\/[^"'`\s]+\.wasm/);
  assert(wasmPath, "Built JavaScript must reference the emitted Wasm file");
  const wasmResponse = await fetch(new URL(wasmPath[0], origin));
  assert.equal(wasmResponse.status, 200);
  assert.match(wasmResponse.headers.get("content-type") ?? "", /application\/wasm/);
  await WebAssembly.compile(await wasmResponse.arrayBuffer());
  const viewer = await import("../crates/viewer/pkg/madori_viewer.js");
  await viewer.default({ module_or_path: await readFile(new URL("../crates/viewer/pkg/madori_viewer_bg.wasm", import.meta.url)) });
  assert.equal(viewer.check_runtime(), true);
  if (interrupted) throw new Error("Smoke check interrupted");
  console.log("Smoke passed: native engine startup, Worker routes, static assets, Wasm delivery and initialization.");
} finally {
  await stop(processes);
}
