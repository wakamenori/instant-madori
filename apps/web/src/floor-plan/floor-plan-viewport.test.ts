import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { registerTsx } from "../tsx-test-loader.ts";
import { parseFloorPlan, selectableAt } from "./plan-svg.ts";
const hooks = await registerTsx(new URL("./floor-plan-viewport.tsx", import.meta.url));
const { PlanSvg, FloorPlanViewport } = await import("./floor-plan-viewport.tsx").finally(() =>
  hooks.deregister(),
);
const svg = readFileSync(new URL("./verification-1.svg", import.meta.url), "utf8");
const storey = "a5e84c0db7:s1";
void test("selection reveals exactly the picked element's dimensions", () => {
  const plan = parseFloorPlan(svg, storey);
  assert.ok(plan);
  for (const raw of [null, "a5e84c0db7:r1"]) {
    const html = renderToStaticMarkup(
      createElement(PlanSvg, { plan, viewBox: plan.viewBox, selected: selectableAt(plan, raw) }),
    );
    for (const label of ["居間", "19.70 m²", "12.1畳", "北（仮）", "8,400", "5,400"])
      assert.ok(html.includes(label));
    assert.doesNotMatch(html, /<script|href=|url\(|\son\w+=/i);
    const groups = html.match(/<g class="dimensions"[^>]*>/g) ?? [];
    assert.equal(groups.length, 9);
    const visible = groups.filter((g) => !g.includes('display="none"'));
    assert.equal(visible.length, raw ? 1 : 0);
    if (raw) {
      assert.ok(visible[0]?.includes(`data-dimensions-for="${raw}"`));
      assert.match(html, /class="room selected"/);
    }
  }
});
void test("escaped room names remain text", () => {
  const plan = parseFloorPlan(svg.replace("居間", "&lt;script&gt;&amp;"), storey);
  assert.ok(plan);
  const html = renderToStaticMarkup(
    createElement(PlanSvg, { plan, selected: null, viewBox: plan.viewBox }),
  );
  assert.match(html, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(html, /<script/);
});
void test("unavailable plans render their status without a drawing", () => {
  for (const kind of ["absent", "rejected"] as const) {
    const html = renderToStaticMarkup(createElement(FloorPlanViewport, { slot: { kind } }));
    assert.doesNotMatch(html, /<svg/);
    assert.match(
      html,
      kind === "absent"
        ? /role="status">この案には間取り図がありません。/
        : /role="alert">この案の間取り図を表示できませんでした。/,
    );
  }
  const empty = renderToStaticMarkup(createElement(FloorPlanViewport, { slot: null }));
  assert.doesNotMatch(empty, /<svg|<p/);
});
