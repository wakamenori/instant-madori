import assert from "node:assert/strict";
import { test } from "node:test";
import { geometryClient } from "../../src/geometry/geometry-client.ts";
import { renderPatternSample } from "../../src/services/geometry.ts";

function renderWithRejection(error: unknown) {
  const geometry = geometryClient((name) => {
    assert.equal(name, "pattern:pattern-1");
    return {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- RPC can reject with foreign values.
      sampleDisplay: () => Promise.reject(error),
    };
  });
  return renderPatternSample({ geometry }, { patternId: "pattern-1", traceId: "trace-1" });
}

void test("retryable and overloaded RPC failures retry, foreign errors propagate unchanged", async () => {
  for (const error of [
    { retryable: true },
    { overloaded: true },
    Object.assign(new Error("rpc"), { retryable: true }),
  ]) {
    assert.deepEqual(await renderWithRejection(error), { kind: "retry", reason: "unreachable" });
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
    await assert.rejects(renderWithRejection(error), (actual) => actual === error);
});
