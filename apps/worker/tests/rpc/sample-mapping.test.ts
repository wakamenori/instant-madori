import assert from "node:assert/strict";
import { test } from "node:test";
import { geometryClient } from "../../src/geometry/geometry-client.ts";
import { sampleRoutes } from "../../src/api/sample.ts";
import { ApiFailure, errorResponse } from "../../src/api/http.ts";
import { getSampleDisplay } from "../../src/services/geometry.ts";
import type { RouteContext } from "../../src/api/router.ts";
import type { GeometryResult, DisplayArtifact } from "../../src/geometry/geometry-protocol.ts";
// Only the RPC boundary is substituted; HTTP error mapping is real.
function context(call: () => Promise<GeometryResult<DisplayArtifact>>): RouteContext {
  return {
    traceId: "trace-1",
    log: {},
    deps: {
      geometry: geometryClient((name) => {
        assert.equal(name, "sample");
        return { sampleDisplay: call };
      }),
    },
  } as unknown as RouteContext;
}
void test("retryable and overloaded RPC failures map to unavailable, foreign errors stay failures", async () => {
  for (const error of [
    { retryable: true },
    { overloaded: true },
    Object.assign(new Error("rpc"), { retryable: true }),
  ]) {
    const c = context(async () => {
      await Promise.resolve();
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercise foreign RPC rejection values
      throw error;
    });
    assert.deepEqual(await getSampleDisplay(c.deps, { traceId: c.traceId }), {
      kind: "unavailable",
      reason: "unreachable",
    });
    const route = sampleRoutes[0];
    assert(route);
    await assert.rejects(
      route.handle(c),
      (e: unknown) =>
        e instanceof ApiFailure &&
        errorResponse(e.code, e.headers).status === 503 &&
        e.headers["retry-after"] === "5",
    );
  }
  for (const error of [
    new Error("bug"),
    { retryable: "true" },
    {
      get retryable() {
        throw new Error("getter");
      },
    },
  ])
    await assert.rejects(
      getSampleDisplay(
        context(async () => {
          await Promise.resolve();
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercise foreign RPC rejection values
          throw error;
        }).deps,
        { traceId: "x" },
      ),
      (e) => e === error,
    );
});
void test("failed geometry maps to 500; binary successes preserve the artifact", async () => {
  const route = sampleRoutes[0];
  assert(route);
  await assert.rejects(
    route.handle(
      context(() => Promise.resolve({ kind: "failed", reason: "build_failed", status: 500 })),
    ),
    (e: unknown) => e instanceof ApiFailure && errorResponse(e.code).status === 500,
  );
  const success = context(() =>
    Promise.resolve({
      kind: "ok",
      start: "warm",
      ms: 1,
      value: {
        bytes: new ArrayBuffer(1),
        contentType: "application/vnd.madori.display; version=1",
      },
    }),
  );
  const response = await route.handle(success);
  assert.equal(success.log["geometryStart"], "warm");
  assert.equal(success.log["geometryMs"], 1);
  assert.equal(success.log["geometryFailure"], undefined);
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 1);
});

void test("failed geometry logs reason, status and violation in separate fields", async () => {
  const { geometryValue } = await import("../../src/api/geometry.ts");
  const log: Record<string, string | number | boolean | undefined> = {};
  assert.throws(
    () =>
      geometryValue(
        { kind: "failed", reason: "protocol_violation", status: 502, violation: "schema" },
        log,
      ),
    ApiFailure,
  );
  assert.deepEqual(log, {
    geometryFailure: "protocol_violation",
    geometryStatus: 502,
    geometryViolation: "schema",
  });
  const failed = context(() =>
    Promise.resolve({ kind: "failed", reason: "build_failed", status: 500 }),
  );
  assert(sampleRoutes[0]);
  await assert.rejects(sampleRoutes[0].handle(failed), ApiFailure);
  assert.equal(failed.log["geometryFailure"], "build_failed");
  assert.equal(failed.log["geometryStatus"], 500);
});
