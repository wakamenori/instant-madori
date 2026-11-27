import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { callGeometry, type Send } from "../../apps/worker/src/geometry/geometry-protocol.ts";
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
  const send =
    (headers: Record<string, string>): Send =>
    async (request) => ({
      kind: "response",
      response: await fetch(`http://127.0.0.1:${geometryPort}${request.path}`, {
        method: request.method,
        headers: request.contentType
          ? { ...headers, "content-type": request.contentType }
          : headers,
        body: request.body ?? null,
        signal: AbortSignal.timeout(request.timeoutMs),
      }),
      start: "warm",
      ms: 0,
    });
  const placeRoom = (send: Send) =>
    callGeometry(send, "applyOperations", {
      traceId: "smoke",
      body: {
        job_id: "smoke",
        operation_id: "place",
        generation: 1,
        snapshot: { kind: "empty" },
        operations: [
          {
            kind: "place_rooms",
            layout: {
              walls: { exterior_thickness: 200, interior_thickness: 100, height: 2800 },
              rooms: [
                { name: "room", usage: "living", min: { x: 0, y: 0 }, max: { x: 4000, y: 3000 } },
              ],
            },
          },
        ],
      },
    });
  assert.deepEqual(await placeRoom(send({})), {
    kind: "failed",
    reason: "unauthorized",
    status: 401,
  });
  const result = await placeRoom(send({ authorization: `Bearer ${token}` }));
  assert.equal(result.kind, "ok");
  assert.equal(result.value.kind, "applied");
  const housePart = result.value.parts.find((part) => part.artifact.kind === "house");
  const display = result.value.parts.find((part) => part.artifact.kind === "display");
  assert.ok(housePart);
  assert.ok(display);
  const ids = z.array(z.object({ id: z.string() }));
  const { house } = z
    .object({ house: z.object({ boundaries: ids, rooms: ids }) })
    .parse(JSON.parse(new TextDecoder().decode(housePart.bytes)));
  const summary = viewer.describe_display(display.bytes);
  try {
    assert.ok(summary.bodies > 0);
    assert.deepEqual(
      new Set(summary.elements),
      new Set([...house.boundaries, ...house.rooms].map((element) => element.id)),
    );
  } finally {
    summary.free();
  }
  assert.throws(() => viewer.describe_display(new Uint8Array([0])));
  if (interrupted) throw new Error("Smoke check interrupted");
  console.log(
    "Smoke passed: native engine startup, Worker routes, static assets, Wasm delivery, and authenticated house operations with viewer decoding of housing element IDs.",
  );
} finally {
  await stop(processes);
}
