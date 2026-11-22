import { date, esc, fmt, legend, shortDate, spark, stack, table, type ChartRow } from "./chart.ts";
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
const tiers = ["work", "wait", "unclassified"] as const;
const tierNames = { work: "作業", wait: "待ち", unclassified: "未分類" };
// Waiting sits on the baseline because it is the layer the reader diagnoses.
const stackOrder = ["wait", "work", "unclassified"] as const;
const phases: Record<string, string> = {
  implementation: "実装",
  verification: "検証",
  rework: "手戻り",
  merge_wait: "マージ待ち",
  post_merge: "マージ後",
  none: "フェーズ不明",
};
const waitNames: Record<string, string> = {
  "human.approval": "人の承認",
  "human.decision": "人の判断",
  "resource.ci_queue": "CIの順番",
  "resource.docker_wait": "Dockerの枠",
  "resource.deploy_queue": "デプロイの順番",
  "resource.staging": "stagingの占有",
  "resource.deploy_order": "デプロイの順序",
  "coordinator.this_issue": "指揮役（このIssueを対応中）",
  "coordinator.elsewhere": "指揮役（別件を対応中）",
  "coordinator.stopped": "指揮役（停止中）",
};
const laneNames: Record<string, string> = {
  "tier:work": "作業",
  "tier:wait": "待ち",
  "tier:unclassified": "未分類",
  "run:owner": "担当",
  "run:implementer": "実装役",
  "run:verifier": "検証役",
  "run:other": "その他の役",
  "run:local": "ローカルの実行",
  "run:ci": "CIの実行",
  "queue:ci": "CIの順番待ち",
  approval: "承認待ち",
};
const capacitySeries = [
  { label: "進行中", color: "running" },
  { label: "割り当て待ち", color: "dispatch" },
  { label: "リソース制約で着手不可", color: "resource" },
  { label: "着手可能なIssueなし", color: "ready" },
];
function effectValue(
  rate: number | null,
  low: number | null,
  high: number | null,
  n: number | null,
) {
  return rate === null
    ? "比較できる記録なし"
    : `${fmt(rate, 100)}%（${fmt(low, 100)}〜${fmt(high, 100)}）n=${n ?? 0}`;
}
const toggle = '<button type="button" class="swap" aria-pressed="false">表で見る</button>';
export function renderDashboard(data: ViewerData) {
  const gapCounts = new Map<string, number>();
  for (const { reason } of data.gaps) gapCounts.set(reason, (gapCounts.get(reason) ?? 0) + 1);
  const alert = data.health.some((r) => r.stopped || r.recent_quarantined > 0)
    ? '<aside><a href="#health">記録が届いていない出どころがあります。計測の信頼性を確認してください</a></aside>'
    : "";
  const radio = (name: string, options: [string, string][], checked: string) =>
    options
      .map(
        ([value, text]) =>
          `<label><input type="radio" name="${name}" value="${value}"${value === checked ? " checked" : ""}><span>${text}</span></label>`,
      )
      .join("");
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>デリバリーの振り返り</title><style>${style}</style><main>${alert}
  <header><h1>デリバリーの振り返り</h1><p>${data.generatedAt ? date(Date.parse(data.generatedAt) / 1000) + " JST 時点" : "集計時刻不明"}</p>
  <form class="filters"><fieldset><legend>集計対象</legend>${radio(
    "target",
    [
      ["機能", "機能のみ"],
      ["全種類", "全種類"],
    ],
    "全種類",
  )}</fieldset><fieldset><legend>直近の稼働</legend>${radio(
    "span",
    [
      ["4", "4時間"],
      ["8", "8時間"],
      ["24", "24時間"],
    ],
    "8",
  )}</fieldset></form></header>
  ${data.combos.map((c) => panel(data, c)).join("")}
  ${Object.entries(data.timelines)
    .map(([issue, lanes]) => timeline(issue, lanes))
    .join("")}
  <dialog><form method="dialog"><button class="close">閉じる</button></form><div></div></dialog><div id="tooltip" role="status" hidden></div>
  <section class="detail"><h2>改善の効果</h2>${table(
    ["改善のIssue", "狙い", "前後の稼働分", "改善前（95%区間）", "改善後（95%区間）"],
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
    4,
  )}</section>
  <section class="detail" id="health"><h2>計測の信頼性</h2><h3>出どころ</h3>${table(
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
    6,
  )}
  <h3>記録の抜け（${data.gaps.length}件）</h3>${table(
    ["理由", "件数"],
    Array.from(gapCounts, ([reason, count]) => [gapNames[reason] ?? reason, count]),
    1,
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
    1,
  )}</details></section></main>
  <script>${script}</script></html>`;
}
function timeline(issue: string, lanes: ViewerData["timelines"][number]) {
  const intervals = lanes.flatMap((l) => l.intervals);
  const start = intervals.reduce((m, r) => Math.min(m, r[0]), Infinity),
    end = intervals.reduce((m, r) => Math.max(m, r[1]), 0);
  const order = Object.keys(laneNames);
  const sorted = [...lanes].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  const rows = sorted
    .map((l) => {
      const color = l.name.startsWith("tier:") ? l.name.slice(5) : "actor";
      const marks = l.intervals
        .map(
          ([a, b]) =>
            `<i data-start="${a}" data-end="${b}" style="left:${(100 * (a - start)) / (end - start)}%;width:${(100 * (b - a)) / (end - start)}%;background:var(--${color})"></i>`,
        )
        .join("");
      return `<div class="lane"><b>${esc(laneNames[l.name] ?? l.name)}</b><div class="track">${marks}</div></div>`;
    })
    .join("");
  const records = table(
    ["担い手", "合計（h）", "最初（JST）", "最後（JST）"],
    sorted.map((l) => [
      laneNames[l.name] ?? l.name,
      fmt(l.ms / 3600000),
      date((l.intervals[0]?.[0] ?? 0) / 1000),
      date((l.intervals.at(-1)?.[1] ?? 0) / 1000),
    ]),
    3,
  );
  const body = intervals.length
    ? `<div class="chart"><div class="chart-head"><p>${esc(date(start / 1000))} 〜 ${esc(date(end / 1000))} JST</p>${toggle}</div><figure class="lanes" data-start="${start}" data-end="${end}"><div class="plot">${rows}</div><div class="chart-table" hidden>${records}</div></figure></div>`
    : '<p class="empty">区間の記録はありません</p>';
  return `<template id="issue-${esc(issue)}"><h2>#${esc(issue)} 担い手ごとの経過</h2>${body}</template>`;
}
function share(p: Point, ms: number) {
  const total = Object.values(p.effort.tiers).reduce((a, b) => a + b, 0);
  return total ? (ms / total) * (p.kpi.hours_per_completion ?? 100) : 0;
}
const unitOf = (p: Point) => (p.kpi.hours_per_completion === null ? "%" : "h/件");
function barList(rows: [string, number][], unit: string, color: string) {
  const max = rows.reduce((m, r) => Math.max(m, r[1]), 0);
  if (!rows.some((r) => r[1] > 0)) return '<p class="empty">該当する時間はありません</p>';
  return `<ul class="bars">${rows
    .filter((r) => r[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, v]) =>
        `<li><span>${esc(name)}</span><b>${fmt(v)}<small> ${unit}</small></b><i style="width:${max ? (100 * v) / max : 0}%;background:var(--${color})"></i></li>`,
    )
    .join("")}</ul>`;
}
function segments(cells: Record<string, Record<string, number>>) {
  const totals = Object.fromEntries(
    tiers.map((t) => [t, Object.values(cells).reduce((s, c) => s + (c[t] ?? 0), 0)]),
  );
  return `<span class="seg">${stackOrder
    .map((t) => (totals[t] ? `<i style="flex:${totals[t]};background:var(--${t})"></i>` : ""))
    .join("")}</span>`;
}
function panel(data: ViewerData, c: Combo) {
  const p = c.points.at(-1);
  const open = `<div class="combo" data-span="${c.span}" data-target="${c.target}"${c.span === 8 && c.target === "全種類" ? "" : " hidden"}>`;
  if (!p) return open + '<p class="empty">稼働の記録はありません</p></div>';
  const rows = (values: (r: Point) => (number | null)[]): ChartRow[] =>
    c.points.map((r) => ({ position: r.position, end: r.end, values: values(r) }));
  const byEnd = new Map(c.points.map((r) => [r.end, r]));
  const contextHeaders = [
    "開始（JST）",
    "稼働（分）",
    "工数（分）",
    "完了（件）",
    "境目の未完了（件）",
  ];
  const context = (row: ChartRow) => {
    const r = byEnd.get(row.end);
    return r
      ? [
          date(r.start),
          r.kpi.active_minutes,
          r.kpi.issue_minutes,
          r.kpi.completions,
          `${r.kpi.open_start} → ${r.kpi.open_end}`,
        ]
      : [];
  };
  function tile(
    key: "throughput" | "parallelism" | "target_share" | "hours_per_completion",
    title: string,
    u: string,
    direction: string,
  ) {
    if (!p) return "";
    const bounded = key === "throughput" || key === "hours_per_completion" ? key : null;
    const scale = u === "%" ? 100 : 1;
    const v = p.kpi[key],
      lo = bounded ? p.kpi[`${bounded}_low`] : null,
      hi = bounded ? p.kpi[`${bounded}_high`] : null;
    const hero = key === "throughput";
    const series = [{ label: title, color: "ink" }];
    if (bounded)
      series.push({ label: "95%下限", color: "ink" }, { label: "95%上限", color: "ink" });
    const chart = spark(
      {
        rows: rows((r) => {
          const val = r.kpi[key];
          return [
            val === null ? null : val * scale,
            ...(bounded ? [r.kpi[`${bounded}_low`], r.kpi[`${bounded}_high`]] : []),
          ];
        }),
        series,
        unit: u,
        breaks: data.breaks,
        context,
        contextHeaders,
      },
      hero ? 76 : 30,
    );
    const interval = bounded ? `<span>95%区間 ${fmt(lo)}〜${fmt(hi)}</span>` : "";
    return `<article class="tile${hero ? " hero" : ""}" data-kpi="${key}" data-value="${v ?? ""}" data-low="${lo ?? ""}" data-high="${hi ?? ""}" data-n="${p.kpi.completions}"><div class="chart-head"><h2>${title}</h2>${toggle}</div><p class="value"><strong>${fmt(v, scale)}</strong> ${u}</p><p class="meta"><span>${direction}</span>${interval}<span>完了 ${p.kpi.completions}件</span></p>${chart}</article>`;
  }
  const u = unitOf(p);
  const phaseKeys = Object.keys(phases).filter((k) => k !== "none" || p.effort.phases.none);
  const cellValues = phaseKeys.flatMap((k) =>
    tiers.map((t) => share(p, p.effort.phases[k]?.[t] ?? 0)),
  );
  const cellMax = Math.max(...cellValues, 0);
  const phaseRows = phaseKeys
    .map((phase) => {
      const cells = tiers.map((t) => {
        const v = share(p, p.effort.phases[phase]?.[t] ?? 0);
        return `<td><button type="button" data-cell="${phase}.${t}" data-value="${v}" aria-pressed="false" aria-label="${phases[phase]}の${tierNames[t]}で絞り込む"${v ? "" : " disabled"}>${v ? fmt(v) : "·"}<i style="width:${cellMax ? (100 * v) / cellMax : 0}%;background:var(--${t})"></i></button></td>`;
      });
      const total = tiers.reduce((s, t) => s + share(p, p.effort.phases[phase]?.[t] ?? 0), 0);
      return `<tr><th scope="row">${phases[phase]}</th>${cells.join("")}<td class="sum">${fmt(total)}</td></tr>`;
    })
    .join("");
  const tierTotals = tiers.map((t) => share(p, p.effort.tiers[t]));
  const issueRows = c.issues.map((i) => {
    const hours = i.effort_ms / 3600000;
    return `<li><button type="button" class="issue" data-issue="${i.issue}" data-effort="${i.effort_ms}" data-cells="${esc(JSON.stringify(i.cells))}"${data.timelines[i.issue] ? "" : " disabled"}><span class="no">#${i.issue}</span><span class="title">${esc(i.title)}</span>${segments(i.cells)}<b>${fmt(hours)}<small> h</small></b></button></li>`;
  });
  const quality = ["product", "development"]
    .map((area) => {
      const r = qualityRates(
        data.quality.filter((q) => q.closed >= p.start && q.closed < p.end),
        area,
      );
      return `<div class="${r.observed < r.total ? "dim" : ""}"><h3>${area === "product" ? "製品" : "開発の仕組み"}<small>観察完了 ${r.observed}/${r.total}</small></h3>${table(
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
  const work = p.effort.work;
  const parallel = p.effort.tiers.work
    ? (work.generation + work.local + work.ci_deploy) / p.effort.tiers.work
    : null;
  const effortSeries = stackOrder.map((t) => ({ label: tierNames[t], color: t }));
  const kindUnit = c.target === "機能" ? "%" : "件";
  return (
    open +
    `<section class="kpis">${tile("throughput", "スループット", "件/h", "多いほど良い")}<div class="factors">${tile("parallelism", "同時進行数", "件", "向きなし")}${c.target === "機能" ? tile("target_share", "機能の工数比率", "%", "多いほど良い") : ""}${tile("hours_per_completion", "1件あたりの工数", "h/件", "少ないほど良い")}</div></section>
<section class="effort"><article class="breakdown"><div class="chart-head"><h2>1件あたりの工数の内訳</h2>${toggle}</div>${legend(
      effortSeries,
      stackOrder.map((t) => `${fmt(share(p, p.effort.tiers[t]))} ${u}`),
    )}${stack(
      {
        // One axis keeps one unit: in h/件 mode, periods without a completion stay empty.
        rows: rows((r) =>
          stackOrder.map((t) =>
            u === "%" || r.kpi.hours_per_completion !== null ? share(r, r.effort.tiers[t]) : null,
          ),
        ),
        series: effortSeries,
        unit: u,
        breaks: data.breaks,
        context,
        contextHeaders,
      },
      128,
    )}${
      p.kpi.completions
        ? c.points.some((r) => !r.kpi.completions)
          ? '<p class="note">完了が無い時間帯は空けています</p>'
          : ""
        : '<p class="note">期間内に完了が無いため、割合で示しています</p>'
    }</article>
<article class="phases"><h2>フェーズ別の内訳<small>${u}</small><small>セルを押すと右下のIssueを絞り込みます</small></h2><table class="matrix"><thead><tr><th></th>${tiers.map((t) => `<th scope="col">${tierNames[t]}</th>`).join("")}<th scope="col" class="sum">計</th></tr></thead><tbody>${phaseRows}</tbody><tfoot><tr><th scope="row">計</th>${tierTotals.map((v) => `<td>${fmt(v)}</td>`).join("")}<td class="sum">${fmt(tierTotals.reduce((a, b) => a + b, 0))}</td></tr></tfoot></table>
<div class="lists"><div><h3>待ちの相手</h3>${barList(
      Object.entries(p.effort.waits).map(([k, v]) => [waitNames[k] ?? k, share(p, v)]),
      u,
      "wait",
    )}</div><div><h3>作業の内訳<small>並行度 ${fmt(parallel)} 倍</small></h3>${barList(
      [
        ["応答生成", share(p, work.generation)],
        ["ローカルの実行", share(p, work.local)],
        ["CIとデプロイ", share(p, work.ci_deploy)],
      ],
      u,
      "work",
    )}</div></div></article></section>
<section class="flow"><article class="capacity"><div class="chart-head"><h2>同時進行数の上限の内訳</h2>${toggle}</div>${legend(capacitySeries)}${stack(
      {
        rows: rows((r) => [
          r.kpi.parallelism,
          r.slots.awaiting_dispatch,
          r.slots.resource_limit,
          r.slots.no_ready_issue,
          r.capacity,
        ]),
        series: [...capacitySeries, { label: "担当枠の上限", color: "ink" }],
        unit: "枠",
        breaks: data.breaks,
      },
      96,
      { cap: (r) => r.values[4] ?? null, resumes: false },
    )}</article>
<article class="kinds"><h2>種類別の${c.target === "機能" ? "工数比率" : "完了件数"}</h2>${barList(
      c.kinds.map((k) => [
        k.kind === "unknown" ? "種類不明" : k.kind,
        c.target === "機能" ? (100 * k.minutes) / (p.kpi.issue_minutes || 1) : k.completions,
      ]),
      kindUnit,
      "neutral",
    )}</article>
<article class="issues"><h2>期間内に完了したIssue<small class="filter-state" hidden></small></h2>${legend(effortSeries)}<ol class="top">${issueRows.slice(0, 6).join("")}</ol><details class="rest"${issueRows.length > 6 ? "" : " hidden"}><summary>ほかの${issueRows.length - 6}件</summary><ol>${issueRows.slice(6).join("")}</ol></details><p class="empty empty-issues"${issueRows.length ? " hidden" : ""}>該当するIssueはありません</p></article></section>
<p class="reliability"><a href="#health">計測の信頼性</a><span>未分類 <b>${fmt(p.unclassified_share, 100)}%</b></span><span>Issueに結べなかった記録 <b>${data.gaps.length}件</b></span><span>期間内の完了 <b>${p.kpi.completions}件</b></span><span>${esc(shortDate(p.start))} 〜 ${esc(shortDate(p.end))} JST</span></p>
<section class="detail quality"><h2>品質<small>期間内に閉じたIssue</small></h2><div class="pair">${quality}</div></section></div>`
  );
}
