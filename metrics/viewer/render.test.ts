import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboard } from "./render.ts";
import type { ViewerData } from "./data.ts";

const empty: ViewerData = {
  generatedAt: "2026-11-20T18:00:00Z",
  operatingHours: [],
  breaks: [],
  windows: [{ length: 8, points: [], issues: [] }],
  effects: [],
  prevention: [],
  health: [],
  gaps: [],
  inactive: [],
  verification: [],
};
void test("the review follows the KPI tree with anchors and a quiet empty state", () => {
  const html = renderDashboard(empty);
  assert.deepEqual(
    Array.from(html.matchAll(/<h2>(.*?)<\/h2>/gu), (m) => m[1]),
    [
      "スループットとその分解",
      "並列数",
      "機能に回った割合",
      "機能1件あたりの延べ時間",
      "改善の効果",
      "計測の信頼性",
    ],
  );
  assert.match(html, /href="#effort-8"/u);
  assert.doesNotMatch(html, /<aside>/u);
  assert.match(html, /稼働の記録はありません/u);
});
void test("only stopped sources and quarantined records raise the page warning", () => {
  const health = {
    source: "</script><img src=x>",
    last_poll: null,
    last_success: null,
    first_poll: null,
    last_append: null,
    quarantined: 0,
    held: 2,
    lag_minutes: null,
    failed_cycles: 7,
    skipped_cycles: 2,
    stopped: false,
  };
  for (const [stopped, quarantined] of [
    [false, 0],
    [false, 1],
    [true, 0],
  ] as const) {
    const html = renderDashboard({ ...empty, health: [{ ...health, stopped, quarantined }] });
    assert.equal(html.includes("<aside>"), stopped || quarantined > 0);
    assert.ok(html.includes("&lt;/script&gt;&lt;img src=x&gt;"));
  }
});
