import { geometryInternal } from "../../packages/contracts/src/generated/geometry-internal.ts";
import { readEvents, type LogRow } from "./workers-logs.ts";

function stats(values: number[]) {
  const sorted = values.sort((a, b) => a - b);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    median: sorted[(sorted.length - 1) >> 1] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

export function summarize(rows: readonly LogRow[]) {
  const events = readEvents(rows);
  const api = events.filter((e) => e.kind === "api");
  const geometry = events.filter((e) => e.kind === "geometry");
  const display = geometry.filter((e) => e.route === geometryInternal.routes.sampleDisplay.path);
  const containers = events.filter((e) => e.kind === "container");
  const coldReady = containers.filter((e) => e.name === "container.ready" && e.mode === "cold");
  // The Worker no longer logs api.request geometryStart; container.ready carries the same traces.
  const coldTraces = new Set(coldReady.map((e) => e.traceId));
  const warm = display.filter((e) => e.traceId === null || !coldTraces.has(e.traceId));
  const starts = containers.filter((e) => e.name === "container.started").map((e) => e.t);
  const groups = new Map<number | null, number[]>();
  let startIndex = 0;
  for (const row of warm) {
    while (startIndex < starts.length && (starts[startIndex] ?? Infinity) <= row.t) startIndex++;
    const start = starts[startIndex - 1] ?? null;
    const group = groups.get(start);
    if (group) group.push(row.ms);
    else groups.set(start, [row.ms]);
  }
  return {
    coldReadyMs: stats(coldReady.flatMap((e) => (e.ms === null ? [] : [e.ms]))),
    coldRequestGeometryMs: stats(
      api.flatMap((e) => (e.geometry?.start === "cold" ? [e.geometry.ms] : [])),
    ),
    warmRequestGeometryMs: stats(
      api.flatMap((e) => (e.geometry?.start === "warm" ? [e.geometry.ms] : [])),
    ),
    warmContainerHandlerMs: stats(warm.map((e) => e.ms)),
    warmContainerHandlerMsByStart: Array.from(groups, ([start, group]) => ({
      start,
      ms: stats(group),
    })),
    maxVmHwmKib: geometry.reduce<number | null>(
      (max, { vmHwmKib }) => (vmHwmKib === null ? max : Math.max(max ?? 0, vmHwmKib)),
      null,
    ),
    limits: events
      .filter((e) => e.kind === "limits")
      .map(({ t, cgroupCpuMax, cgroupMemoryMax, parallelism }) => ({
        t,
        cgroupCpuMax,
        cgroupMemoryMax,
        parallelism,
      })),
    counts: {
      apiRequests: api.length,
      containerDisplayLines: display.length,
      failedApiRequests: api.filter((e) => e.status !== 200).length,
    },
    containerEvents: events
      .filter((e) => e.kind === "container" || e.kind === "exited")
      .map((e) =>
        e.kind === "container"
          ? { t: e.t, event: e.name, mode: e.mode, ms: e.ms }
          : { t: e.t, event: e.message, mode: null, ms: null },
      ),
  };
}
