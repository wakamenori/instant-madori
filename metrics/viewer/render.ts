import { color, date, esc, fmt, stacked, table, trend } from "./chart.ts";
import type { Point, ViewerData } from "./data.ts";
import { style } from "./page.ts";

const states: Record<string, string> = {
  post_merge: "マージの後の確認",
  verifier: "検証",
  owner_turn: "担当の作業",
  implementer: "実装役の作業",
  check_wait: "checkの待ち",
  ci: "CI",
  staging_occupied: "stagingの占有",
  deploy_running: "デプロイの実行中",
  coordinator_busy: "指揮役がほかの仕事中",
  coordinator_asleep: "指揮役が起きていない",
  owner_wait: "担当の待ち",
  unknown: "不明",
};
const reasons: Record<string, string> = {
  no_ready_issue: "着手できるIssueが無い",
  resource_limit: "資源の枠で選べない",
  awaiting_dispatch: "指揮役がまだ立てていない",
};
const gapNames: Record<string, string> = {
  missing_closure: "Issueを閉じたPRが不明",
  missing_kind: "種類の記録なし",
  missing_open_kind: "未完了Issueの種類なし",
  multiple_kinds: "種類が複数",
  missing_owner: "担当の記録なし",
  bypass: "担当を通さず完了",
  label_file_mismatch: "ラベルと変更ファイルの食い違い",
  missing_dispatch_target: "改善の担当を立てた時点の狙いなし",
  invalid_issue_record: "Issueの定型記録が不足または形式違い",
  missing_issue_yaml: "Issueの定型記録なし",
  missing_comment_yaml: "コメントの定型記録なし",
  invalid_comment_yaml: "コメントの定型記録が不正",
  missing_verdict: "判定の記録なし",
  invalid_verdict: "判定の形式が不明",
  legacy_verdict: "旧形式の判定",
  missing_verifier: "検証役の記録なし",
  missing_first_round: "初回の判定なし",
  missing_failed_checks: "落ちた確認の記録なし",
  undated_comment_verdict: "判定日時の記録なし",
  unknown_target: "改善の狙いが不明",
};
function stateLayer(s: { state: string; minutes: number }) {
  return {
    name: states[s.state] ?? s.state,
    value: s.minutes / 60,
    color: color(Object.keys(states).indexOf(s.state)),
  };
}
function windowPage(data: ViewerData, w: ViewerData["windows"][number]) {
  const axis = {
    points: w.points,
    start: w.length * 60,
    end: data.operatingHours.at(-1)?.position ?? 0,
    breaks: data.breaks,
  };
  const section = (key: string) => key + "-" + w.length;
  function quality(title: string, metric: "first_pass" | "rework" | "escaped") {
    return (["product", "development"] as const)
      .map((area) =>
        trend(
          axis,
          title + " · " + (area === "product" ? "製品" : "開発の仕組み"),
          "%",
          metric === "first_pass" ? "高いほど良い" : "低いほど良い",
          (p) => {
            const q = p.quality.find((row) => row.area === area);
            const rate = q?.[metric];
            return {
              value: rate?.value ?? null,
              low: rate?.low ?? null,
              high: rate?.high ?? null,
              n: rate?.n ?? 0,
              excluded: (q?.total ?? 0) - (rate?.n ?? 0),
              observed: metric === "first_pass" ? undefined : q?.observed,
              dim: metric !== "first_pass" && q?.observed !== q?.total,
            };
          },
          "",
          100,
        ),
      )
      .join("");
  }
  const kindNames = Array.from(new Set(w.points.flatMap((p) => p.kinds.map((r) => r.kind)))).sort();
  function hourly(metric: "parallelism" | "feature_share") {
    const percent = metric === "feature_share";
    const hourlyAxis = { points: data.operatingHours, breaks: data.breaks };
    return `<details><summary>日本時間の各時間帯の${percent ? "機能に回った割合" : "並列数"}</summary>${trend(
      hourlyAxis,
      percent ? "機能に回った割合" : "並列数",
      percent ? "%" : "件",
      percent ? "高いほど良い" : "良し悪しの向きなし",
      (h) => ({ value: h[metric] }),
      "",
      percent ? 100 : 1,
    )}</details>`;
  }
  function kindLayers(p: Point, metric: "minutes" | "completions") {
    return p.kinds.map((r) => ({
      name: r.kind === "unknown" ? "不明" : r.kind,
      value: r[metric] / (metric === "minutes" ? 60 : 1),
      color: color(kindNames.indexOf(r.kind)),
    }));
  }
  const breaks = data.breaks
    .map((b) => `<span>${fmt(b.position / 60)} h │ ${date(b.resume)} 再開</span>`)
    .join("");
  const overview = [
    trend(axis, "機能のスループット", "件/h", "高いほど良い", (p) => ({
      value: p.throughput,
      low: p.throughput_low,
      high: p.throughput_high,
      uncounted: p.uncounted_features,
    })),
    trend(
      axis,
      "並列数",
      "件",
      "良し悪しの向きなし",
      (p) => ({ value: p.parallelism }),
      section("capacity"),
    ),
    trend(
      axis,
      "機能に回った割合",
      "%",
      "高いほど良い",
      (p) => ({ value: p.feature_share }),
      section("allocation"),
      100,
    ),
    trend(
      axis,
      "機能1件あたりの延べ時間",
      "h/件",
      "短いほど良い",
      (p) => ({
        value: p.hours_per_feature,
        low: p.hours_per_feature_low,
        high: p.hours_per_feature_high,
      }),
      section("effort"),
    ),
  ].join("");
  const issueList = w.issues
    .map(
      (f) =>
        `<li><div><b>#${f.issue}</b> ${esc(f.title)} <strong>${fmt(f.minutes / 60)} h</strong></div><div class="strip">${f.states
          .map((s) => {
            const r = stateLayer(s);
            return `<i style="flex:${s.minutes};background:${r.color}"><span>${esc(r.name)} ${s.minutes} 分</span></i>`;
          })
          .join("")}</div></li>`,
    )
    .join("");
  return `<div data-window="${w.length}" ${w.length === 8 ? "" : "hidden"}><section><h2>スループットとその分解</h2>${overview}
  ${breaks ? `<div class="resumes"><b>稼働再開（日本時間）</b>${breaks}</div>` : ""}</section>
  <section id="${section("capacity")}"><h2>並列数</h2>${stacked(
    axis,
    "担当枠の使われ方",
    "枠",
    (p) => [
      { name: "並列数", value: p.parallelism, color: color(0) },
      ...Object.entries(reasons).map(([reason, name], i) => ({
        name,
        color: color(i + 1),
        value: (p.slots.find((r) => r.reason === reason)?.slots ?? 0) / p.active_minutes,
      })),
    ],
    (p) => p.capacity,
  )}${hourly("parallelism")}</section>
  <section id="${section("allocation")}"><h2>機能に回った割合</h2>${stacked(axis, "種類ごとの延べ時間", "h", (p) => kindLayers(p, "minutes"))}${stacked(axis, "種類ごとの完了数", "件", (p) => kindLayers(p, "completions"))}${quality("作りの見直しが起きた割合", "rework")}${quality("不具合が漏れた割合", "escaped")}${hourly("feature_share")}</section>
  <section id="${section("effort")}"><h2>機能1件あたりの延べ時間</h2>${stacked(axis, "機能の延べ時間の内訳", "h", (p) => p.states.map(stateLayer))}${quality("一度で検証に合格した割合", "first_pass")}<h3>直近の窓で完了した機能</h3>${issueList ? `<ol>${issueList}</ol>` : "<p>完了した機能はありません</p>"}</section></div>`;
}
function effectValue(
  rate: number | null,
  low: number | null,
  high: number | null,
  n: number | null,
) {
  return rate === null
    ? "比較できる記録なし"
    : `${fmt(rate, 100)}%（${fmt(low, 100)}〜${fmt(high, 100)}） · n=${n ?? 0}`;
}
export function renderDashboard(data: ViewerData) {
  const options = data.windows
    .map(
      (w) =>
        `<option value="${w.length}" ${w.length === 8 ? "selected" : ""}>${w.length} 時間</option>`,
    )
    .join("");
  const gapCounts = new Map<string, number>();
  for (const { reason } of data.gaps) gapCounts.set(reason, (gapCounts.get(reason) ?? 0) + 1);
  const alert = data.health.some((r) => r.stopped || r.recent_quarantined > 0)
    ? '<aside><a href="#health">記録の到着に問題があります。計測の信頼性を確認</a></aside>'
    : "";
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Software Factory 計測</title><style>${style}</style><main>${alert}
  <header><div><p>Software Factory</p><h1>機能のデリバリー</h1><small>集計日時 ${data.generatedAt ? date(Date.parse(data.generatedAt) / 1000) + " JST" : "—"}</small></div><label>直近の稼働時間 <select id="window">${options}</select></label></header>
  ${data.windows.map((w) => windowPage(data, w)).join("")}
  <section><h2>改善の効果</h2>${table(
    ["改善 Issue", "狙い", "前後の稼働分", "改善前（95%区間）", "改善後（95%区間）"],
    data.effects.map((r) => [
      r.issues,
      r.name,
      r.minutes,
      effectValue(r.before, r.before_low, r.before_high, r.before_n),
      effectValue(r.after, r.after_low, r.after_high, r.after_n),
    ]),
  )}
  <h3>事故を防ぐ改善</h3>${table(
    ["Issue", "狙い", "検査したrun", "検出", "mainのrun", "mainの失敗"],
    data.prevention.map((r) => [
      r.issue,
      r.name,
      r.checked_runs,
      r.catches,
      r.main_runs,
      r.main_failures,
    ]),
  )}</section>
  <section id="health"><h2>計測の信頼性</h2><h3>出どころ</h3>${table(
    [
      "出どころ",
      "最終取込（JST）",
      "最終巡回（JST）",
      "最終成功（JST）",
      "巡回",
      "取込の遅れ（分）",
      "隔離（直近8稼働時間）",
      "隔離（累計）",
      "保留",
      "失敗",
      "見送り",
    ],
    data.health.map((r) => [
      r.source,
      r.last_append ? date(Date.parse(r.last_append) / 1000) : null,
      r.last_poll ? date(Date.parse(r.last_poll) / 1000) : null,
      r.last_success ? date(Date.parse(r.last_success) / 1000) : null,
      r.stopped ? "停止" : r.last_poll ? "稼働" : "—",
      fmt(r.lag_minutes),
      r.recent_quarantined,
      r.quarantined,
      r.held,
      r.failed_cycles,
      r.skipped_cycles,
    ]),
  )}
  <h3>記録の抜け（${data.gaps.length}件）</h3>${table(
    ["理由", "件数"],
    Array.from(gapCounts, ([reason, count]) => [gapNames[reason] ?? reason, count]),
  )}
  <details><summary>該当するIssueの一覧</summary>${table(
    ["Issue", "理由"],
    data.gaps.map((r) => [r.issue, gapNames[r.reason] ?? r.reason]),
  )}</details>
  <details><summary>検証の記録の詳細（${data.verification.length}件）</summary>${table(
    ["Issue", "PR", "理由"],
    data.verification.map((r) => [r.issue, r.pr, gapNames[r.reason] ?? r.reason]),
  )}</details>
  <details><summary>エージェントとCIが動かなかった期間（${data.inactive.length}件）</summary>${table(
    ["開始（JST）", "終了（JST）", "分"],
    data.inactive.map((r) => [date(r.start), date(r.end), r.minutes]),
  )}</details></section></main>
  <script>
    const select = document.querySelector('#window');
    function show() {
      for (const panel of document.querySelectorAll('[data-window]')) {
        panel.hidden = panel.dataset.window !== select.value;
      }
    }
    select.addEventListener('change', show);
    show();
  </script></html>`;
}
