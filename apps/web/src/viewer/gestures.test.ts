import assert from "node:assert/strict";
import { test } from "node:test";
import { dragDelta, dragKind, wheelSteps } from "./gestures.ts";
void test("gestures use CSS pixels and normalize wheel modes", () => {
  assert.deepEqual(dragDelta({ x: 2, y: 5 }, { x: 7, y: 3 }), { dx: 5, dy: -2 });
  assert.equal(wheelSteps({ deltaY: 2, deltaMode: 0 }), 2);
  assert.equal(wheelSteps({ deltaY: 2, deltaMode: 1 }), 32);
  assert.equal(wheelSteps({ deltaY: 2, deltaMode: 2 }), 1600);
});

void test("drag kind depends on the button and modifiers at pointerdown", () => {
  for (const [button, shiftKey, ctrlKey, expected] of [
    [0, false, false, "orbit"],
    [0, true, false, "pan"],
    [0, false, true, "pan"],
    [2, false, false, "pan"],
    [1, false, false, null],
    [3, false, false, null],
    [4, false, false, null],
  ] as const) {
    assert.equal(dragKind({ button, shiftKey, ctrlKey }), expected);
  }
});
