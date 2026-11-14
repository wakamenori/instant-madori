import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { describeError, logEvent } from "../src/log.ts";
import type { LogFields } from "../src/log.ts";
import type { GatewayEnvironment } from "../src/geometry/container-gateway.ts";

await test("request and gateway adapters omit extra keys from nonliteral fields", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => {
    lines.push(line);
  });
  const gateway: Pick<GatewayEnvironment, "log"> = {
    log: (event, fields, level) => logEvent(level ?? "info", event, fields),
  };
  const assigned: LogFields = { status: 200 };
  Object.assign(assigned, { name: "private name", accessJwt: "test-only-token" });
  const extra = { status: 201, accessJwt: "test-only-token" };
  for (const fields of [assigned, extra]) {
    logEvent("info", "api.request", fields);
    gateway.log("api.request", fields);
  }
  assert.deepEqual(lines, [
    JSON.stringify({ level: "info", event: "api.request", status: 200 }),
    JSON.stringify({ level: "info", event: "api.request", status: 200 }),
    JSON.stringify({ level: "info", event: "api.request", status: 201 }),
    JSON.stringify({ level: "info", event: "api.request", status: 201 }),
  ]);
});

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
    const forged = z.string().brand<"ErrorDescription">().parse("private content");
    // @ts-expect-error A public Zod brand cannot forge the private error brand.
    logEvent("error", "api.unexpected_error", { error: forged });
    // @ts-expect-error Gateway adapters also require the private error brand.
    environment.log("container.destroy_failed", { error: forged });
    // @ts-expect-error Only cold and warm geometry starts are supported.
    logEvent("info", "api.request", { geometryStart: "unknown" });
    // @ts-expect-error Gateway adapters must preserve geometry start literals.
    environment.log("container.ready", { geometryStart: "unknown" });
    // @ts-expect-error Only cold, adopted and reprobe lifecycle modes are supported.
    logEvent("info", "container.ready", { mode: "unknown" });
    // @ts-expect-error Gateway adapters must preserve lifecycle mode literals.
    environment.log("container.ready", { mode: "unknown" });
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
