import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { describeError, logEvent } from "../src/log.ts";
import type { LogFields } from "../src/log.ts";
import type { GatewayEnvironment } from "../src/geometry/container-gateway.ts";

await test("request logs omit extra keys from nonliteral fields", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => {
    lines.push(line);
  });
  const assigned: LogFields = { status: 200 };
  Object.assign(assigned, { name: "private name", accessJwt: "test-only-token" });
  const extra = { status: 201, accessJwt: "test-only-token" };
  for (const fields of [assigned, extra]) {
    logEvent("info", "api.request", fields);
  }
  assert.deepEqual(lines, [
    JSON.stringify({ level: "info", event: "api.request", status: 200 }),
    JSON.stringify({ level: "info", event: "api.request", status: 201 }),
  ]);
});

await test("logs omit nested objects and arrays from assigned, record and proxy fields", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => {
    lines.push(line);
  });
  const nested = { accessJwt: "test-only-token" };
  const route = ["test-only-token"];
  const assigned: LogFields = { status: 200 };
  Object.assign(assigned, { bytes: nested, route });
  const record: Record<string, unknown> = { status: 201, bytes: nested, route };
  const proxy = new Proxy<LogFields>(
    { status: 202, bytes: 1, route: "GET /api/projects" },
    {
      get(target, key) {
        if (key === "bytes") return nested;
        if (key === "route") return route;
        return target.status;
      },
    },
  );
  for (const fields of [assigned, record, proxy]) logEvent("info", "api.request", fields);
  assert.deepEqual(
    lines,
    [200, 201, 202].map((status) =>
      JSON.stringify({ level: "info", event: "api.request", status }),
    ),
  );
});

await test("logs omit nonprimitive values without calling toJSON", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => {
    lines.push(line);
  });
  let conversions = 0;
  const toJSON = () => {
    conversions++;
    return "test-only-token";
  };
  const values = [null, true, { toJSON }, Object.assign(() => undefined, { toJSON })];
  for (const value of values) {
    const fields: LogFields = { status: 500 };
    Object.assign(fields, { bytes: value, route: value });
    logEvent("error", "api.request", fields);
  }
  assert.deepEqual(
    lines,
    values.map(() => JSON.stringify({ level: "error", event: "api.request", status: 500 })),
  );
  assert.equal(conversions, 0);
});

await test("logs omit values whose primitive type differs from the key's", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => {
    lines.push(line);
  });
  const fields: LogFields = { status: 200 };
  Object.assign(fields, { bytes: "test-only-token", route: 404, ms: 15 });
  logEvent("info", "api.request", fields);
  assert.deepEqual(lines, [
    JSON.stringify({ level: "info", event: "api.request", status: 200, ms: 15 }),
  ]);
});

await test("logs omit prototype names even when supplied as own keys", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => {
    lines.push(line);
  });
  const fields = Object.fromEntries<string | number>([
    ["status", 200],
    ["constructor", "test-only-token"],
    ["__proto__", "test-only-token"],
  ]);
  logEvent("info", "api.request", fields);
  assert.deepEqual(lines, [JSON.stringify({ level: "info", event: "api.request", status: 200 })]);
});

await test("structured logs preserve allowed fields at both levels", (t) => {
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
  logEvent("info", "container.ready", { traceId: "trace-1", mode: "cold", ms: 5 });
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
