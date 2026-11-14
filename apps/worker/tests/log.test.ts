import assert from "node:assert/strict";
import { test } from "node:test";
import { describeError, logEvent } from "../src/log.ts";
import type { LogFields } from "../src/log.ts";
import type { GatewayEnvironment } from "../src/geometry/container-gateway.ts";

await test("structured logs preserve request and container fields at both levels", (t) => {
  const info: string[] = [];
  const errors: string[] = [];
  t.mock.method(console, "log", (line: string) => {
    info.push(line);
  });
  t.mock.method(console, "error", (line: string) => {
    errors.push(line);
  });
  logEvent("info", "api.request", {
    traceId: "trace-1",
    rayId: undefined,
    method: "GET",
    route: "GET /api/sample/display",
    userId: "user-1",
    status: 200,
    ms: 15,
    bytes: 128,
    geometryStart: "warm",
    geometryMs: 10,
  });
  logEvent("error", "api.unexpected_error", {
    traceId: "trace-1",
    error: describeError(new Error("network down")),
  });
  const gateway: Pick<GatewayEnvironment, "log"> = {
    log: (event, fields, level) => logEvent(level ?? "info", event, fields),
  };
  gateway.log("container.ready", { traceId: "trace-1", mode: "cold", ms: 5 });
  assert.deepEqual(info, [
    JSON.stringify({
      level: "info",
      event: "api.request",
      traceId: "trace-1",
      method: "GET",
      route: "GET /api/sample/display",
      userId: "user-1",
      status: 200,
      ms: 15,
      bytes: 128,
      geometryStart: "warm",
      geometryMs: 10,
    }),
    JSON.stringify({
      level: "info",
      event: "container.ready",
      traceId: "trace-1",
      mode: "cold",
      ms: 5,
    }),
  ]);
  assert.deepEqual(errors, [
    JSON.stringify({
      level: "error",
      event: "api.unexpected_error",
      traceId: "trace-1",
      error: "Error: network down",
    }),
  ]);

  function typeChecks(environment: GatewayEnvironment) {
    // @ts-expect-error Request content is not an allowed log field.
    logEvent("info", "api.request", { body: "private content" });
    // @ts-expect-error HTTP status is numeric.
    logEvent("info", "api.request", { status: "200" });
    // @ts-expect-error Error descriptions must come from describeError.
    logEvent("error", "api.unexpected_error", { error: "private content" });
    // @ts-expect-error Container logs also reject request content.
    environment.log("container.ready", { body: "private content" });
    // @ts-expect-error Container log fields use the same numeric types.
    environment.log("container.ready", { ms: "5" });
    // @ts-expect-error Container logs also require describeError results.
    environment.log("container.destroy_failed", { error: "private content" });
    const fields: LogFields = {};
    // @ts-expect-error Route handlers cannot attach request content.
    fields.body = "private content";
    // @ts-expect-error Route handlers must preserve numeric status.
    fields.status = "200";
  }
  void typeChecks;
});

await test("an unexpected error is logged with everything it wraps", () => {
  const batch = new Error("UNIQUE constraint failed: requests.owner_id");
  const lookup = new TypeError("D1 unavailable", { cause: new Error("network down") });
  const wrapped = new AggregateError([batch, lookup], "project.create: batch failed");
  assert.equal(
    describeError(wrapped),
    "AggregateError: project.create: batch failed" +
      " <- Error: UNIQUE constraint failed: requests.owner_id" +
      " <- TypeError: D1 unavailable <- Error: network down",
  );
  assert.equal(describeError("thrown string"), "string");
});
