import { z } from "zod";
import { hash, canonical, type Json, type Obj } from "../l1/envelope.ts";
import { object, telemetry } from "../l1/privacy.ts";
import type { Parsed } from "../l1/sources.ts";
const obj = z.record(z.string(), z.json());
const resource = {
  resource: obj.and(z.object({ attributes: z.array(z.json()).optional() })).optional(),
};
const logs = z.object({
  resourceLogs: z.array(
    z.object({
      ...resource,
      scopeLogs: z.array(z.object({ scope: obj.optional(), logRecords: z.array(obj) })),
    }),
  ),
});
const group = z.looseObject({
  dataPoints: z.array(obj),
  aggregationTemporality: z.json().optional(),
  isMonotonic: z.json().optional(),
});
const metrics = z.object({
  resourceMetrics: z.array(
    z.object({
      ...resource,
      scopeMetrics: z.array(
        z.object({
          scope: obj.optional(),
          metrics: z.array(
            obj.and(
              z.object({
                name: z.string(),
                sum: group.optional(),
                gauge: group.optional(),
                histogram: group.optional(),
                exponentialHistogram: group.optional(),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
});
function attr(o: Obj, key: string) {
  if (!Array.isArray(o.attributes)) return "";
  for (const item of o.attributes) {
    const kv = object(item);
    if (kv.key === key) {
      const val = object(kv.value);
      return typeof val.stringValue === "string"
        ? val.stringValue
        : typeof val.intValue === "number" || typeof val.intValue === "string"
          ? String(val.intValue)
          : "";
    }
  }
  return "";
}
function instant(v: Json | undefined) {
  if (typeof v !== "string") return null;
  const ms = /^\d+$/u.test(v) ? Number(v) / 1e6 : Date.parse(v);
  return ms >= Date.UTC(2020, 0) && ms < Date.UTC(10000, 0) ? new Date(ms).toISOString() : null;
}
export function parseOtlp(signal: "logs" | "metrics", bytes: Buffer): Parsed {
  const out: Parsed = { records: [], rejects: [], drops: [] };
  function add(resource: Obj, scope: Obj, record: Obj, metric?: Obj) {
    const svc = attr(resource, "service.name"),
      emitter = svc === "claude-code" ? "claude" : svc.startsWith("codex") ? "codex" : null;
    if (!emitter) {
      out.drops.push({ source: "otlp", reason: "unknown_service" });
      return;
    }
    const source = `${emitter}.otel.${metric ? "metric" : "log"}` as const;
    const key = emitter === "claude" ? "session.id" : "conversation.id",
      id = attr(record, key) || attr(scope, key) || attr(resource, key);
    if (!id) {
      out.drops.push({ source, reason: "unattributed" });
      return;
    }
    const payload: Obj = metric
      ? { resource, scope, metric, data_point: record }
      : { resource, scope, log_record: record };
    const occurredAt =
      instant(attr(record, "event.timestamp")) ??
      instant(record.timeUnixNano) ??
      instant(record.observedTimeUnixNano);
    const parts = metric
      ? [
          id,
          metric.name,
          record.startTimeUnixNano ?? null,
          record.timeUnixNano ?? null,
          hash(canonical(telemetry({ attributes: record.attributes ?? [] }))),
        ]
      : [
          id,
          attr(record, "event.name") || hash(canonical(telemetry(payload))),
          occurredAt,
          attr(record, "event.sequence"),
        ];
    const naturalKey = canonical(parts.map((v) => v ?? null));
    out.records.push({
      source,
      occurredAt,
      sourceVersion: (svc + "@" + (attr(resource, "service.version") || "unknown")).slice(0, 128),
      naturalKey: naturalKey.length > 512 ? hash(naturalKey) : naturalKey,
      payload,
      scope: {
        kind: "gated",
        subject: (emitter === "claude" ? "claude.session:" : "codex.conversation:") + id,
      },
    });
  }
  try {
    const body: unknown = JSON.parse(bytes.toString());
    if (signal === "logs") {
      for (const r of logs.parse(body).resourceLogs)
        for (const s of r.scopeLogs)
          for (const row of s.logRecords) add(r.resource ?? {}, s.scope ?? {}, row);
    } else {
      for (const r of metrics.parse(body).resourceMetrics)
        for (const s of r.scopeMetrics)
          for (const m of s.metrics)
            for (const type of ["sum", "gauge", "histogram", "exponentialHistogram"] as const) {
              const g = m[type];
              if (g)
                for (const point of g.dataPoints)
                  add(r.resource ?? {}, s.scope ?? {}, point, {
                    name: m.name,
                    description: m.description ?? null,
                    unit: m.unit ?? null,
                    type,
                    aggregationTemporality: g.aggregationTemporality ?? null,
                    isMonotonic: g.isMonotonic ?? null,
                  });
            }
    }
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
    out.rejects.push({
      source: "otlp",
      reason:
        error instanceof z.ZodError
          ? JSON.stringify(error.issues.map((i) => i.path)).slice(0, 2000)
          : "invalid_json",
      unitHash: hash(bytes),
      content: { signal, bytes: bytes.length },
    });
  }
  return out;
}
