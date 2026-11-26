import assert from "node:assert/strict";
import { test } from "node:test";
import { renderPatternSample } from "../../src/services/geometry.ts";
import type { GeometryApi, GeometryInstance } from "../../src/geometry/geometry-client.ts";
import type { GeometryResult, DisplayArtifact } from "../../src/geometry/geometry-protocol.ts";
void test("sample service selects the pattern key and forwards the call", async () => {
  const call = { traceId: "service-trace" };
  const display = new Uint8Array([0, 128, 255]);
  const result = {
    kind: "ok",
    start: "warm",
    ms: 1,
    value: { bytes: display.buffer, contentType: "application/vnd.madori.display; version=1" },
  } satisfies GeometryResult<DisplayArtifact>;
  const keys: GeometryInstance[] = [];
  const fake: GeometryApi = {
    applyOperations() {
      throw new Error("Unexpected applyOperations");
    },
    sampleDisplay: (actual) => {
      assert.deepEqual(actual, call);
      return Promise.resolve(result);
    },
  };
  const actual = await renderPatternSample(
    {
      geometry: (key) => {
        keys.push(key);
        return fake;
      },
    },
    { ...call, patternId: "pattern-1" },
  );
  assert.deepEqual(keys, [{ kind: "pattern", patternId: "pattern-1" }]);
  assert.deepEqual(actual, { kind: "rendered", display });
});
