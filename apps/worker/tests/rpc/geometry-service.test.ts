import assert from "node:assert/strict";
import { test } from "node:test";
import { applyHouseOperations } from "../../src/services/geometry.ts";
import type { GeometryApi, GeometryInstance } from "../../src/geometry/geometry-client.ts";

void test("sample service selects the pattern key and forwards the call", async () => {
  const call = { traceId: "service-trace" };
  const request = {
    job_id: call.traceId,
    generation: 1,
    operation_id: "op",
    snapshot: { kind: "empty" as const },
    operations: [],
  };
  const keys: GeometryInstance[] = [];
  const fake: GeometryApi = {
    sampleDisplay() {
      throw new Error("Unexpected applyOperations");
    },
    applyOperations: (actual, received) => {
      assert.deepEqual(actual, call);
      assert.deepEqual(received, request);
      return Promise.resolve({ kind: "failed", reason: "request_too_large", limit: 1, bytes: 2 });
    },
  };
  const actual = await applyHouseOperations(
    {
      geometry: (key) => {
        keys.push(key);
        return fake;
      },
    },
    "pattern-1",
    request,
  );
  assert.deepEqual(keys, [{ kind: "pattern", patternId: "pattern-1" }]);
  assert.deepEqual(actual, { kind: "failed", reason: "request_too_large", limit: 1, bytes: 2 });
});
