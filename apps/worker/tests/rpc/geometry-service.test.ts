import assert from "node:assert/strict";
import { test } from "node:test";
import { getSampleDisplay } from "../../src/services/geometry.ts";
import type { GeometryApi, GeometryInstance } from "../../src/geometry/geometry-client.ts";
import type { GeometryResult, DisplayArtifact } from "../../src/geometry/geometry-protocol.ts";
void test("sample service selects the sample key and forwards the call", async () => {
  const call = { traceId: "service-trace" };
  const result = {
    kind: "unavailable",
    reason: "not_ready",
  } satisfies GeometryResult<DisplayArtifact>;
  const keys: GeometryInstance[] = [];
  const fake: GeometryApi = {
    sampleDisplay: (actual) => {
      assert.deepEqual(actual, call);
      return Promise.resolve(result);
    },
  };
  const actual = await getSampleDisplay(
    {
      geometry: (key) => {
        keys.push(key);
        return fake;
      },
    },
    call,
  );
  assert.deepEqual(keys, [{ kind: "sample" }]);
  assert.equal(actual, result);
});
