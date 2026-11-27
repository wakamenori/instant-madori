import assert from "node:assert/strict";
import { test } from "node:test";
import { fitCamera, viewBoxOf, zoomAt, zoomBy, panBy, press, type Press } from "./plan-camera.ts";
import { parseFloorPlan, selectableAt } from "./plan-svg.ts";
import { readFileSync } from "node:fs";
const box = { x: -20, y: 0, width: 100, height: 100 };
const fit = fitCamera(box);
const size = { width: 400, height: 200 };
void test("fit contains the plan and zoom keeps the pointer's plan coordinates", () => {
  const before = viewBoxOf(box, fit, size);
  assert.deepEqual(before, { x: -70, y: 0, width: 200, height: 100 });
  const at = { x: 260, y: 60 };
  const after = viewBoxOf(box, zoomAt(box, fit, size, -250, at), size);
  for (const [pos, extent] of [
    ["x", "width"],
    ["y", "height"],
  ] as const) {
    const fraction = at[pos] / size[extent];
    assert.ok(
      Math.abs(before[pos] + fraction * before[extent] - after[pos] - fraction * after[extent]) <
        1e-9,
    );
  }
  assert.equal(zoomBy(fit, 100).zoom, 20);
  assert.equal(zoomBy(fit, 0.1).zoom, 1);
  const camera = zoomBy(fit, 2);
  assert.deepEqual(panBy(box, camera, size, 40, -40), { zoom: 2, centerX: 20, centerY: 60 });
  assert.deepEqual(panBy(box, camera, size, 1e6, -1e6), { zoom: 2, centerX: -20, centerY: 100 });
});
void test("a primary press selects on release and a drag only pans", () => {
  const plan = parseFloorPlan(
    readFileSync(new URL("./verification-1.svg", import.meta.url), "utf8"),
    "a5e84c0db7:s1",
  );
  assert.ok(plan);
  const hit = selectableAt(plan, "a5e84c0db7:r1");
  assert.ok(hit);
  const idle: Press = { kind: "idle" };
  const down = { kind: "down" as const, pointer: 1, at: { x: 0, y: 0 }, primary: true, hit };
  const move = { kind: "move" as const, pointer: 1, at: { x: 2, y: 2 } };
  const up = { ...move, kind: "up" as const };
  const pressed = press(idle, down).state;
  assert.deepEqual(press(pressed, move), { state: pressed, effect: { kind: "none" } });
  assert.deepEqual(press(pressed, up).effect, { kind: "select", element: hit });
  assert.deepEqual(press(press(idle, { ...down, hit: null }).state, up).effect, {
    kind: "select",
    element: null,
  });
  assert.deepEqual(press(idle, { ...down, primary: false }).state, idle);
  assert.deepEqual(press(pressed, { ...down, pointer: 2 }).state, pressed);
  assert.deepEqual(press(pressed, { ...up, pointer: 2 }).state, pressed);
  const drag = press(pressed, { ...move, at: { x: 5, y: 0 } });
  assert.deepEqual(drag.effect, { kind: "pan", dx: 5, dy: 0 });
  assert.equal(press(drag.state, up).effect.kind, "pan");
  assert.deepEqual(press(drag.state, up).state, idle);
});
