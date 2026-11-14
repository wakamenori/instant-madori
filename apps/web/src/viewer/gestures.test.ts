import assert from "node:assert/strict";
import { test } from "node:test";
import { dragDelta, wheelSteps } from "./gestures.ts";
void test("gestures use CSS pixels and normalize wheel modes", () => {
  assert.deepEqual(dragDelta({ x: 2, y: 5 }, { x: 7, y: 3 }), { dx: 5, dy: -2 });
  assert.equal(wheelSteps({ deltaY: 2, deltaMode: 0 }), 2);
  assert.equal(wheelSteps({ deltaY: 2, deltaMode: 1 }), 32);
  assert.equal(wheelSteps({ deltaY: 2, deltaMode: 2 }), 1600);
});
