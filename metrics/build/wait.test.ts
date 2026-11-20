import { test } from "node:test";
import assert from "node:assert/strict";
import { waitMinutes } from "./wait.ts";
void test("samples from launch, gives overlapping time to verification, and counts the final partial minute", () => {
  const at = (n: number) => new Date(10_000 + n * 60_000).toISOString();
  const span = (kind: string, start: number, end: number) => ({
    kind,
    actor: "t",
    start: at(start),
    end: at(end),
  });
  assert.deepEqual(
    [
      ...waitMinutes(
        at(0),
        at(4.5),
        [span("owner_turn", 0, 2), span("verifier_run", 1, 3)],
        [{ kind: "report", at: at(2), actor: null, wake_kind: null }],
      ),
    ],
    [
      ["owner_turn", 1],
      ["verifier", 2],
      ["coord_dispatch", 2],
    ],
  );
});
