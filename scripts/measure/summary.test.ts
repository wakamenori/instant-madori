import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { summarize } from "./summary.ts";
import { parseLogRows } from "./workers-logs.ts";
import golden from "./verification-03.summary.json" with { type: "json" };

await test("replays the full verification-3 summary", () => {
  const file = new URL(
    "../../docs/verification/evidence/verification-03/events.jsonl",
    import.meta.url,
  );
  const summary = summarize(parseLogRows(readFileSync(file, "utf8")));
  assert.deepEqual(
    summary.containerEvents
      .filter((e) => e.event === "container.ready" && e.mode === "cold")
      .map((e) => e.ms),
    [8078, 339, 347, 377, 347, 38247, 356],
  );
  assert.equal(summary.maxVmHwmKib, 47012);
  assert.deepEqual(summary.warmContainerHandlerMs, { n: 102, min: 25, median: 29, max: 557 });
  assert.deepEqual(summary, golden);
});

await test("leaves the first request after a cold start out of warm handling", () => {
  const display = { event: "geometry.request", service: "geometry", route: "/v1/sample/display" };
  const summary = summarize([
    { t: 1, service: "worker", event: "container.started", traceId: "cold" },
    { t: 2, service: "worker", event: "container.ready", traceId: "cold", mode: "cold", ms: 300 },
    { ...display, t: 3, traceId: "cold", ms: 557, vmHwmKib: 10 },
    { ...display, t: 4, traceId: "next", ms: 29, vmHwmKib: 10 },
  ]);
  assert.deepEqual(summary.coldReadyMs, { n: 1, min: 300, median: 300, max: 300 });
  assert.deepEqual(summary.warmContainerHandlerMs, { n: 1, min: 29, median: 29, max: 29 });
});

await test("counts untraced displays before or simultaneous with a start", () => {
  const display = {
    event: "geometry.request",
    service: "geometry",
    route: "/v1/sample/display",
    ms: 9,
    vmHwmKib: 10,
  };
  const { warmContainerHandlerMsByStart } = summarize([
    { ...display, t: 2 },
    { ...display, t: 1 },
    { event: "container.started", service: "worker", t: 2 },
  ]);
  const ms = { n: 1, min: 9, median: 9, max: 9 };
  assert.deepEqual(warmContainerHandlerMsByStart, [
    { start: null, ms },
    { start: 2, ms },
  ]);
});

await test("preserves unavailable geometry measurements as null", () => {
  const summary = summarize([
    {
      t: 1,
      service: "geometry",
      event: "geometry.request",
      route: "/v1/sample/display",
      traceId: null,
      ms: 3,
      vmHwmKib: null,
    },
    {
      t: 2,
      service: "geometry",
      event: "geometry.limits",
      cgroupCpuMax: null,
      cgroupMemoryMax: null,
      parallelism: null,
    },
  ]);
  assert.equal(summary.maxVmHwmKib, null);
  assert.equal(summary.warmContainerHandlerMs.n, 1);
  assert.deepEqual(summary.limits, [
    { t: 2, cgroupCpuMax: null, cgroupMemoryMax: null, parallelism: null },
  ]);
});
