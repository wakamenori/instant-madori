import type { GeometryApi } from "./geometry-client.ts";
import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import { geometryInternal as protocol } from "@madori/contracts/geometry-internal";
import { logEvent } from "../log.ts";
import { ContainerGateway, containerInactivityMarginMs } from "./container-gateway.ts";
import { acceptReadinessResponse, readSampleDisplay, routeTimeouts } from "./geometry-protocol.ts";
import type { GeometryCall } from "./geometry-protocol.ts";
const configSchema = z.object({
  GEOMETRY_INSTANCE_TYPE: z.enum(["lite", "standard-1", "standard-2", "standard-3", "standard-4"]),
  GEOMETRY_IDLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(21_600_000 - containerInactivityMarginMs),
});
export class GeometryContainer extends DurableObject<Env> implements GeometryApi {
  readonly #gateway: ContainerGateway;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const config = configSchema.parse(env);
    const container = ctx.container;
    this.#gateway = new ContainerGateway(
      container && {
        get running() {
          return container.running;
        },
        get images() {
          return container.images;
        },
        start: (options) => container.start(options),
        destroy: (reason) => container.destroy(reason),
        setInactivityTimeout: (ms) => container.setInactivityTimeout(ms),
        fetchPort: (request) => container.getTcpPort(protocol.port).fetch(request),
      },
      {
        readStopRetry: () => ctx.storage.kv.get("stopRetryMs"),
        writeStopRetry: (ms) => ctx.storage.kv.put("stopRetryMs", ms),
        clearStopRetry: () => {
          ctx.storage.kv.delete("stopRetryMs");
        },
        readActivity: () => ctx.storage.kv.get("lastActivityAt"),
        writeActivity: (at) => ctx.storage.kv.put("lastActivityAt", at),
        clearActivity: () => {
          ctx.storage.kv.delete("lastActivityAt");
        },
        setAlarm: async (at) => {
          await ctx.storage.setAlarm(at);
        },
        deleteAlarm: async () => {
          await ctx.storage.deleteAlarm();
        },
        read: () => ctx.storage.kv.get("start"),
        write: (record) => ctx.storage.kv.put("start", record),
        clear: () => {
          ctx.storage.kv.delete("start");
        },
      },
      {
        imageName: "geometry",
        instance: config.GEOMETRY_INSTANCE_TYPE,
        idleTimeoutMs: config.GEOMETRY_IDLE_TIMEOUT_MS,
        tokenEnv: protocol.tokenEnv,
        authorizationHeader: protocol.headers.authorization,
        traceHeader: protocol.headers.traceId,
        readiness: {
          path: protocol.routes.health.path,
          acceptHealth: acceptReadinessResponse,
          deadlineMs: 60_000,
          probeTimeoutMs: routeTimeouts.health,
          intervalMs: 250,
        },
      },
      {
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        deadline: (ms) => {
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(new DOMException("Deadline exceeded", "TimeoutError")),
            ms,
          );
          return { signal: controller.signal, clear: () => clearTimeout(timer) };
        },
        newToken: () => {
          const bytes = crypto.getRandomValues(new Uint8Array(32));
          return btoa(String.fromCharCode(...bytes))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "");
        },
        log: (event, fields, level) => logEvent(level ?? "info", event, fields),
      },
    );
    void ctx.blockConcurrencyWhile(() => this.#gateway.resume());
  }
  override alarm() {
    return this.#gateway.alarm();
  }
  sampleDisplay(call: GeometryCall) {
    return this.#gateway.run((send) => readSampleDisplay(send, call));
  }
}
