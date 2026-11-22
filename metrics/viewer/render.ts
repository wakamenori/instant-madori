import { date, esc, fmt, graph, table } from "./chart.ts";
import { qualityRates, type Point, type Combo, type ViewerData } from "./data.ts";
import { style, script } from "./page.ts";
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
  const gapCounts = new Map<string, number>();
  for (const { reason } of data.gaps) gapCounts.set(reason, (gapCounts.get(reason) ?? 0) + 1);
  const alert = data.health.some((r) => r.stopped || r.recent_quarantined > 0)
    ? '<aside><a href="#health">記録の到着に問題があります。計測の信頼性を確認</a></aside>'
    : "";
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Software Factory 計測</title><style>${style}</style><main>${alert}
  <header><div><small>Software Factory · ${data.generatedAt ? date(Date.parse(data.generatedAt) / 1000) + " JST" : "—"}</small><h1>デリバリーの振り返り</h1></div><label>集計対象 <select id="target"><option value="機能">機能のみ</option><option selected>全種類</option></select></label><label>直近の稼働 <select id="window"><option value="4">4 時間</option><option value="8" selected>8 時間</option><option value="24">24 時間</option></select></label></header>
  ${data.combos.map((c) => panel(data, c)).join("")}
  ${Object.entries(data.timelines)
    .map(([issue, lanes]) => timeline(issue, lanes))
    .join("")}
  <dialog><button autofocus class="close">閉じる</button><div></div></dialog><output id="tooltip" hidden></output>
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
  <script>${script}</script></html>`;
}
const tiers = ["work", "wait", "unclassified"] as const;
const tierNames = ["作業", "待ち", "未分類"];
const phases: Record<string, string> = {
  implementation: "実装",
  verification: "検証",
  rework: "手戻り",
  merge_wait: "マージ待ち",
  post_merge: "マージ後",
  none: "フェーズ不明",
};
const waitNames: Record<string, string> = {
  "human.approval": "人 · 承認",
  "human.decision": "人 · 判断",
  "resource.ci_queue": "リソース · CI順番",
  "resource.docker_wait": "リソース · Docker枠",
  "resource.deploy_queue": "リソース · デプロイ順番",
  "resource.staging": "リソース · staging",
  "resource.deploy_order": "リソース · デプロイ順序",
  "coordinator.this_issue": "指揮役 · このIssue",
  "coordinator.elsewhere": "指揮役 · 別件",
  "coordinator.stopped": "指揮役 · 停止",
};
const laneNames: Record<string, string> = {
  "tier:work": "作業",
  "tier:wait": "待ち",
  "tier:unclassified": "未分類",
  "run:owner": "担当",
  "run:implementer": "実装役",
  "run:verifier": "検証役",
  "run:other": "その他の役",
  "run:local": "ローカル",
  "run:ci": "CI",
  "queue:ci": "CI順番待ち",
  approval: "承認待ち",
};
function timeline(issue: string, lanes: ViewerData["timelines"][number]) {
  const intervals = lanes.flatMap((l) => l.intervals);
  const start = intervals.reduce((m, r) => Math.min(m, r[0]), Infinity),
    end = intervals.reduce((m, r) => Math.max(m, r[1]), 0);
  const heading = `<h2>#${esc(issue)} 担い手ごとの経過</h2>`;
  const rows = lanes
    .map((l) => {
      const name = esc(laneNames[l.name] ?? l.name);
      const intervals = l.intervals
        .map(
          ([a, b]) =>
            `<i data-start="${a}" data-end="${b}" style="left:${(100 * (a - start)) / (end - start)}%;width:${(100 * (b - a)) / (end - start)}%;background:var(--${l.name.startsWith("tier:") ? esc(l.name.slice(5)) : "neutral"})"></i>`,
        )
        .join("");
      return `<div><b>${name}</b><div class="track">${intervals}</div></div>`;
    })
    .join("");
  const records = table(
    ["担い手", "開始（JST）", "終了（JST）"],
    lanes.flatMap((l) =>
      l.intervals.map(([a, b]) => [laneNames[l.name] ?? l.name, date(a / 1000), date(b / 1000)]),
    ),
  );
  const chart = intervals.length
    ? `<div class="chart"><button class="swap" aria-expanded="false">表で見る</button><div class="plot"><p>${date(start / 1000)} 〜 ${date(end / 1000)} JST</p><div class="lanes" data-start="${start}" data-end="${end}">${rows}</div></div><div class="chart-table" hidden>${records}</div></div>`
    : "区間の記録はありません";
  return `<template id="issue-${esc(issue)}">${heading}${chart}</template>`;
}
function portion(p: Point, ms: number) {
  const total = Object.values(p.effort.tiers).reduce((a, b) => a + b, 0);
  return total ? (ms / total) * (p.kpi.hours_per_completion ?? 100) : 0;
}
const unit = (p: Point) => (p.kpi.hours_per_completion === null ? "%" : "h/件");
function bars(rows: [string, number][], unit: string) {
  const max = rows.reduce((m, r) => Math.max(m, r[1]), 0);
  return rows.length
    ? rows
        .sort((a, b) => b[1] - a[1])
        .map(
          ([name, v]) =>
            `<div class="bar"><span>${esc(name)}</span><b>${fmt(v)} ${unit}</b><i style="width:${max ? (100 * v) / max : 0}%"></i></div>`,
        )
        .join("")
    : "該当する記録はありません";
}
function legend(labels: string[], colors: readonly string[]) {
  return `<div class="legend">${labels.map((name, i) => `<span><i style="background:var(--${colors[i] ?? "ink"})"></i>${esc(name)}</span>`).join("")}</div>`;
}
function panel(data: ViewerData, c: Combo) {
  const p = c.points.at(-1);
  const open = `<section class="combo" data-span="${c.span}" data-target="${c.target}" ${c.span === 8 && c.target === "全種類" ? "" : "hidden"}>`;
  if (!p) return open + "<p>稼働の記録はありません</p></section>";
  const chartRows = (values: (r: Point) => (number | null)[], units: (r: Point) => string) =>
    c.points.map((r) => ({
      position: r.position,
      end: r.end,
      unit: units(r),
      values: values(r),
      context: `${date(r.start)} JST 開始 · 稼働 ${r.kpi.active_minutes} 分 · 工数 ${r.kpi.issue_minutes} 分 · 完了 ${r.kpi.completions} 件 · 境目の未完了 ${r.kpi.open_start} → ${r.kpi.open_end} 件`,
    }));
  function tile(
    key: "throughput" | "parallelism" | "target_share" | "hours_per_completion",
    title: string,
    u: string,
    direction: string,
  ) {
    if (!p) return "";
    const bounds = key === "throughput" || key === "hours_per_completion" ? key : null;
    const scale = u === "%" ? 100 : 1;
    const v = p.kpi[key],
      lo = bounds ? p.kpi[`${bounds}_low`] : null,
      hi = bounds ? p.kpi[`${bounds}_high`] : null;
    const rows = chartRows(
      (r) => {
        const val = r.kpi[key];
        return [
          val === null ? null : val * scale,
          ...(bounds ? [r.kpi[`${bounds}_low`], r.kpi[`${bounds}_high`]] : []),
        ];
      },
      () => u,
    );
    return `<article class="tile" data-kpi="${key}" data-value="${v ?? ""}" data-low="${lo ?? ""}" data-high="${hi ?? ""}" data-n="${p.kpi.completions}"><h2>${title}</h2><strong>${fmt(v, scale)}</strong> ${u}<small>${direction} · 完了 ${p.kpi.completions} 件${bounds ? " · 95%区間 " + fmt(lo) + "〜" + fmt(hi) : ""}</small>${graph({ rows, labels: [title, ...(bounds ? ["95%下限", "95%上限"] : [])], colors: [], mode: "trend", breaks: data.breaks })}</article>`;
  }
  const u = unit(p);
  const phaseTable = Object.entries(phases)
    .filter(([phase]) => phase !== "none" || p.effort.phases.none)
    .map(
      ([phase, name]) =>
        `<tr><th>${name}</th>${tiers
          .map((t) => {
            const v = portion(p, p.effort.phases[phase]?.[t] ?? 0);
            return `<td><button data-cell="${phase}.${t}" data-value="${v}" aria-pressed="false">${fmt(v)}</button></td>`;
          })
          .join("")}</tr>`,
    )
    .join("");
  const slots = [
    "進行中",
    "割り当て待ち",
    "リソース制約で着手不可",
    "着手可能なIssueなし",
    "担当枠の上限",
  ];
  const colors = ["running", "dispatch", "resource", "ready"];
  const issueButtons = c.issues.map(
    (i) =>
      `<button class="issue" data-issue="${i.issue}" data-effort="${i.effort_ms}" data-cells="${esc(JSON.stringify(i.cells))}"><span>#${i.issue} ${esc(i.title)}</span><b>${fmt(i.effort_ms / 3600000)} h</b></button>`,
  );
  const quality = ["product", "development"]
    .map((area) => {
      const r = qualityRates(
        data.quality.filter((q) => q.closed >= p.start && q.closed < p.end),
        area,
      );
      return `<div class="${r.observed < r.total ? "dim" : ""}"><h3>${area === "product" ? "製品" : "開発の仕組み"} · 観察完了 ${r.observed}/${r.total}</h3>${table(
        ["指標", "割合（95%区間）"],
        (
          [
            ["一度で検証に合格", r.first_pass],
            ["作りの見直し", r.rework],
            ["不具合の漏れ", r.escaped],
          ] as const
        ).map(([name, rate]) => [name, effectValue(rate.value, rate.low, rate.high, rate.n)]),
      )}</div>`;
    })
    .join("");
  return (
    open +
    `<div class="tiles">${tile("throughput", "スループット", "件/h", "多いほど良い")}${tile("parallelism", "同時進行数", "件", "良し悪しの向きなし")}${c.target === "機能" ? tile("target_share", "機能の工数比率", "%", "高いほど良い") : ""}${tile("hours_per_completion", "1件あたりの工数", "h/件", "少ないほど良い")}</div>
 <div class="middle"><article><h2>1件あたりの工数の内訳</h2>${graph({ rows: chartRows((r) => tiers.map((t) => portion(r, r.effort.tiers[t])), unit), labels: tierNames, colors: [...tiers], mode: "stack", breaks: data.breaks })}${legend(tierNames, tiers)}<small>${p.kpi.completions ? u : "完了なし · %"}${c.points.some((r) => !r.kpi.completions) && c.points.some((r) => r.kpi.completions) ? " · 完了なしの区間は割合（0〜100%）" : ""}</small></article>
 <article><h2>フェーズ別の内訳 <small>${u}</small></h2><table><thead><tr><th>フェーズ</th>${tierNames.map((t) => "<th>" + t + "</th>").join("")}</tr></thead><tbody>${phaseTable}</tbody></table></article>
 <article><h2>待ち時間の内訳</h2>${bars(
   Object.entries(p.effort.waits).map(([k, v]) => [waitNames[k] ?? k, portion(p, v)]),
   u,
 )}</article>
 <article><h2>作業時間の内訳</h2>${bars(
   [
     ["応答生成", portion(p, p.effort.work.generation)],
     ["ローカル", portion(p, p.effort.work.local)],
     ["CI・デプロイ", portion(p, p.effort.work.ci_deploy)],
   ],
   u,
 )}<small>並行度 ${fmt(p.effort.tiers.work ? Object.values(p.effort.work).reduce((a, b) => a + b, 0) / p.effort.tiers.work : null)} 倍</small></article></div>
 <div class="lower"><article><h2>同時進行数の上限の内訳</h2>${graph({
   rows: chartRows(
     (r) => [
       r.kpi.parallelism,
       r.slots.awaiting_dispatch,
       r.slots.resource_limit,
       r.slots.no_ready_issue,
       r.capacity,
     ],
     () => "枠",
   ),
   labels: slots,
   colors,
   capacity: true,
   mode: "stack",
   breaks: data.breaks,
 })}${legend(slots, colors)}</article>
 <article><h2>種類別の${c.target === "機能" ? "工数比率" : "完了件数"}</h2>${bars(
   c.kinds.map((k) => [
     k.kind === "unknown" ? "種類不明" : k.kind,
     c.target === "機能" ? (100 * k.minutes) / p.kpi.issue_minutes : k.completions,
   ]),
   c.target === "機能" ? "%" : "件",
 )}</article>
 <article><h2>期間内に完了したIssue</h2><div class="top">${issueButtons.slice(0, 6).join("")}</div><details class="rest" ${issueButtons.length <= 6 ? "hidden" : ""}><summary>残りのIssue</summary><div>${issueButtons.slice(6).join("")}</div></details><p class="empty-issues" ${issueButtons.length ? "hidden" : ""}>該当するIssueはありません</p></article></div>
 <p class="reliability"><b>計測の信頼性</b> · 未分類 ${fmt(p.unclassified_share, 100)}% · <a href="#health">Issueに結べなかった記録 ${data.gaps.length} 件</a> · 期間内の完了 ${p.kpi.completions} 件</p>
 <section class="quality"><h2>品質</h2><div>${quality}</div></section></section>`
  );
}
