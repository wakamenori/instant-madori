import { z } from "zod";

const accountId = "4a67230af28ec94d9c70ca48572d8e9f";
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`;
const rowLimit = 2000;
const timestamp = z.number().int().nonnegative();
const service = z.string().min(1);
const logRowSchema = z.looseObject({ t: timestamp, service });
export type LogRow = z.infer<typeof logRowSchema>;
export type QueryLogs = (window: { from: number; to: number }) => Promise<LogRow[]>;

const wireEvent = z.object({
  timestamp,
  source: z.union([z.record(z.string(), z.unknown()), z.string()]),
  $metadata: z.object({ service }),
});
const responseSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    result: z.object({ events: z.object({ events: z.array(wireEvent) }) }),
  }),
  z.object({
    success: z.literal(false),
    errors: z.array(z.object({ code: z.number().int(), message: z.string() })).min(1),
  }),
]);

export function workersLogs(token: string, fetchImpl: typeof fetch = fetch): QueryLogs {
  return async ({ from, to }) => {
    if (!(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from < to))
      throw new Error("Expected a time range with from before to");
    const response = await fetchImpl(endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queryId: "adhoc",
        dry: true,
        view: "events",
        limit: rowLimit,
        timeframe: { from, to },
        parameters: {},
      }),
    }).catch(() => {
      throw new Error("Workers Logs request failed");
    });
    if (!response.ok) throw new Error(`Workers Logs HTTP ${response.status}`);
    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success)
      throw new Error(
        `Invalid Workers Logs response at ${parsed.error.issues[0]?.path.join(".") || "root"}`,
      );
    if (!parsed.data.success)
      throw new Error(
        `Workers Logs query was unsuccessful (codes ${parsed.data.errors.map((e) => e.code).join(", ")})`,
      );
    const events = parsed.data.result.events.events;
    if (events.length >= rowLimit) throw new Error("hit the 2000-row limit; narrow the time range");
    return events
      .map(({ source, timestamp: t, $metadata }) => ({
        ...(typeof source === "string" ? { message: source } : source),
        t,
        service: $metadata.service,
      }))
      .sort((a, b) => a.t - b.t);
  };
}

export function parseLogRows(jsonl: string): LogRow[] {
  return jsonl.split(/\r?\n/u).flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      return [logRowSchema.parse(JSON.parse(line))];
    } catch {
      throw new Error(`Invalid events file at line ${i + 1}`);
    }
  });
}
export function formatLogRows(rows: readonly LogRow[]): string {
  return rows.map((row) => JSON.stringify(row) + "\n").join("");
}

const ms = z.number().nonnegative();
const traceId = z.string().min(1);
const api = z
  .object({
    traceId,
    status: z.number().int(),
    geometryStart: z.enum(["cold", "warm"]).optional(),
    geometryMs: ms.optional(),
  })
  .refine((row) => (row.geometryStart === undefined) === (row.geometryMs === undefined));
const geometry = z.object({
  route: z.string().min(1),
  traceId: traceId.nullish(),
  ms,
  vmHwmKib: z.number().int().nonnegative().nullable(),
});
const limits = z.object({
  cgroupCpuMax: z.string().nullable(),
  cgroupMemoryMax: z.string().nullable(),
  parallelism: z.number().int().positive().nullable(),
});
const container = z.object({
  traceId: traceId.optional(),
  mode: z.string().optional(),
  ms: ms.optional(),
});

function classify(row: LogRow) {
  const { t, event, message } = row;
  try {
    if (event === "api.request") {
      const data = api.parse(row);
      return {
        kind: "api",
        t,
        traceId: data.traceId,
        status: data.status,
        geometry:
          data.geometryStart && data.geometryMs !== undefined
            ? { start: data.geometryStart, ms: data.geometryMs }
            : null,
      } as const;
    }
    if (event === "geometry.request") {
      const data = geometry.parse(row);
      return { kind: "geometry", t, ...data, traceId: data.traceId ?? null } as const;
    }
    if (event === "geometry.limits") return { kind: "limits", t, ...limits.parse(row) } as const;
    if (typeof event === "string" && event.startsWith("container.")) {
      const data = container.parse(row);
      if (event === "container.ready" && data.mode === "cold" && data.ms === undefined)
        throw new Error();
      return {
        kind: "container",
        t,
        name: event,
        traceId: data.traceId ?? null,
        mode: data.mode ?? null,
        ms: data.ms ?? null,
      } as const;
    }
    if (typeof message === "string" && message.startsWith("Container exited"))
      return { kind: "exited", t, message } as const;
    return { kind: "other", t } as const;
  } catch {
    throw new Error(`Invalid ${String(event)} at ${t}`);
  }
}
export function readEvents(rows: readonly LogRow[]) {
  return rows.map(classify).sort((a, b) => a.t - b.t);
}
