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
    last_quarantine: null,
    quarantined: 54,
    held: 2,
    lag_minutes: null,
    failed_cycles: 7,
    skipped_cycles: 2,
    stopped: false,
  };
  for (const [stopped, recent_quarantined] of [
    [false, 0],
    [false, 1],
    [true, 0],
  ] as const) {
    const html = renderDashboard({
      ...empty,
      health: [{ ...health, stopped, recent_quarantined }],
    });
    assert.equal(html.includes("<aside>"), stopped || recent_quarantined > 0);
    assert.ok(html.includes("&lt;/script&gt;&lt;img src=x&gt;"));
  }
});

void test("uncounted completions stay in the throughput tooltip and shares keep a full axis", () => {
  const rate = { value: null, low: null, high: null, n: 0 };
  const point = {
    start: 1_795_000_000,
    end: 1_795_028_800,
    position: 480,
    active_minutes: 480,
    issue_minutes: 960,
    feature_minutes: 0,
    features: 0,
    uncounted_features: 2,
    open_start: 1,
    open_end: 1,
    throughput: 0,
    throughput_low: 0,
    throughput_high: 0.46,
    parallelism: 2,
    feature_share: 0,
    hours_per_feature: null,
    hours_per_feature_low: 0,
    hours_per_feature_high: null,
    capacity: 5,
    slots: [],
    kinds: [],
    states: [],
    quality: (["product", "development"] as const).map((area) => ({
      area,
      total: 0,
      observed: 0,
      first_pass: rate,
      rework: rate,
      escaped: rate,
    })),
  };
  const html = renderDashboard({
    ...empty,
    operatingHours: [{ ...point, hour: 1_795_025_200, parallelism: 2, feature_share: 0 }],
    windows: [{ length: 8, points: [point], issues: [] }],
  });
  assert.equal(html.match(/担当を通さず完了（数えない） 2 件/gu)?.length, 1);
  assert.match(
    html,
    /機能に回った割合 ↓<\/a><\/h3><small>高いほど良い<\/small><div class="series"><div class="graph"><small>100 %<\/small>/u,
  );
});

void test("record gap totals are visible above the collapsed issue list", () => {
  const html = renderDashboard({
    ...empty,
    gaps: [
      { issue: 41, reason: "missing_dispatch_target" },
      { issue: 42, reason: "missing_dispatch_target" },
    ],
  });
  assert.match(html, /<td>改善の担当を立てた時点の狙いなし<\/td><td>2<\/td>/u);
  assert.match(html, /<details><summary>該当するIssueの一覧<\/summary>.*<td>41<\/td>/u);
});
