import assert from "node:assert/strict";
import { test } from "node:test";
import { renderDashboard } from "./render.ts";
import type { ViewerData } from "./data.ts";

const empty: ViewerData = {
  generatedAt: "2026-11-20T18:00:00Z",
  timelines: {},
  quality: [],
  breaks: [],
  combos: [{ span: 8, target: "全種類", points: [], issues: [], kinds: [] }],
  effects: [],
  prevention: [],
  health: [],
  gaps: [],
  inactive: [],
  verification: [],
};
void test("the review follows the KPI tree with anchors and a quiet empty state", () => {
  const html = renderDashboard(empty);
  assert.match(html, /data-span="8" data-target="全種類"/u);
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
