import { chart, esc, format, table, type Mark } from "./chart.ts";
import { style, interactions } from "./page.ts";

type Time = string;
type Flow = {
  issue: number;
  pr: number | null;
  title: string;
  ready_at: Time | null;
  launch: Time;
  pr_opened: Time | null;
  first_report: Time | null;
  merged: Time | null;
  deployed: Time | null;
  last_owner_activity: Time | null;
  verifier_rounds: number;
  fails: number;
  check_jobs: number;
  coordinator_messages: number;
  owner_wakes: number;
};
type Versioned<T> = (T & { definition_version?: string })[];
export type DashboardData = {
  generated_at: Time;
  range_start: Time | null;
  range_end: Time | null;
  mart_issue_flow: Versioned<Flow>;
  mart_issue_wait: Versioned<{ issue: number; state: string; minutes: number }>;
  mart_ci_job: Versioned<{
    job_id: number;
    created_at: Time;
    workflow: string;
    queue_minutes: number | null;
    run_minutes: number | null;
    conclusion: string | null;
    mode: string | null;
    steps: { name: string; minutes: number | null }[];
  }>;
  mart_runner_hour: Versioned<{
    hour: Time;
    check_minutes: number;
    deploy_minutes: number;
    utilization: number;
  }>;
  mart_merge_wait: Versioned<{
    pr: number;
    last_pass: Time | null;
    merged: Time;
    minutes: number | null;
    reason: string;
  }>;
  mart_wip: Versioned<{ at: Time; active_owners: number; queued_ready: number }>;
  mart_health: Versioned<{
    source: string;
    last_append: Time | null;
    last_poll: Time | null;
    lag_minutes: number | null;
    held: number;
    quarantined: number;
    failed_cycles: number;
  }>;
  span: { issue: number; kind: string; start: Time; end: Time | null }[];
};
const waitNames = [
  "担当のターン",
  "担当の子（設計・Codex）",
  "CIの順番待ち",
  "CIの実行",
  "検証役",
  "指揮役の待ち",
  "その他",
];
const states = [
  ["owner_turn"],
  [
    "implementer",
    "implementer_run",
    "codex",
    "advisor",
    "advisor_run",
    "owner_subagent",
    "gap:subagent_done",
    "gap:delegate_done",
  ],
  ["ci_queue"],
  ["ci_run", "gap:pr_watch"],
  ["verifier", "verifier_run"],
  ["coord_dispatch", "coord_decide", "coordinator_dispatch", "coordinator_decide", "gap:coord_msg"],
];
function group(state: string) {
  const named = waitNames.indexOf(state);
  if (named !== -1) return named;
  const index = states.findIndex((keys) => keys.includes(state));
  return index < 0 ? 6 : index;
}
const minute = 60000;
const hour = 60 * minute;
const stamp = (t: Time | null) =>
  t === null ? "未記録" : new Date(t).toISOString().slice(0, 16).replace("T", " ");
const elapsed = (start: Time | null, end: Time | null) =>
  start && end ? (Date.parse(end) - Date.parse(start)) / minute : null;
const numeric = (v: number | null): v is number => v !== null;
const total = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
function quantile(ns: number[], p: number) {
  const sorted = [...ns].sort((a, b) => a - b);
  const i = (sorted.length - 1) * p,
    lo = sorted[Math.floor(i)],
    hi = sorted[Math.ceil(i)];
  return lo === undefined || hi === undefined ? null : lo + (hi - lo) * (i - Math.floor(i));
}
const empty = '<p class="empty">この期間の記録はありません。</p>';
function kpis(d: DashboardData) {
  if (!d.mart_issue_flow.length && !d.mart_ci_job.length && !d.mart_runner_hour.length)
    return empty;
  const end = Date.parse(d.generated_at);
  return [1, 7]
    .map((days) => {
      const start = end - days * 24 * hour;
      const inside = (t: Time | null) =>
        t !== null && Date.parse(t) > start && Date.parse(t) <= end;
      const issues = d.mart_issue_flow.filter((f) => inside(f.merged));
      const prs = new Map<number, number>();
      for (const f of issues)
        if (f.pr !== null) prs.set(f.pr, Math.max(f.fails, prs.get(f.pr) ?? 0));
      const jobs = d.mart_ci_job.filter((j) => j.workflow === "check" && inside(j.created_at));
      let duration = 0,
        busy = 0;
      for (const h of d.mart_runner_hour) {
        const t = Date.parse(h.hour);
        const overlap = Math.max(
          0,
          Math.min(end, t + hour, d.range_end ? Date.parse(d.range_end) : end) -
            Math.max(start, t, d.range_start ? Date.parse(d.range_start) : start),
        );
        duration += overlap;
        busy += overlap * h.utilization;
      }
      const tiles: [string, number | null, string][] = [
        ["マージしたIssue", issues.length, "件"],
        [
          "着手からマージ · 中央値",
          quantile(issues.map((f) => elapsed(f.launch, f.merged)).filter(numeric), 0.5),
          "分",
        ],
        [
          "マージからstaging · 中央値",
          quantile(issues.map((f) => elapsed(f.merged, f.deployed)).filter(numeric), 0.5),
          "分",
        ],
        [
          "check 順番待ち · p90",
          quantile(jobs.map((j) => j.queue_minutes).filter(numeric), 0.9),
          "分",
        ],
        ["runner 稼働率", duration ? (100 * busy) / duration : null, "%"],
        ["マージPRあたりのFAIL", prs.size ? total([...prs.values()]) / prs.size : null, "回"],
      ];
      return (
        "<h3>" +
        (days === 1 ? "直近24時間" : "直近7日間") +
        '</h3><div class="tiles">' +
        tiles
          .map(
            ([label, v, unit]) =>
              "<div><small>" +
              label +
              "</small><strong>" +
              format(v) +
              "</strong> " +
              (v === null ? "" : unit) +
              "</div>",
          )
          .join("") +
        "</div>"
      );
    })
    .join("");
}
function waitChart(d: DashboardData) {
  const merged = d.mart_issue_flow
    .filter((f): f is Flow & { merged: string } => f.merged !== null)
    .sort((a, b) => Date.parse(b.merged) - Date.parse(a.merged))
    .slice(0, 30);
  const rows = merged.map((f) => {
    const matches = d.mart_issue_wait.filter((w) => w.issue === f.issue);
    const values = waitNames.map((_, i) =>
      total(matches.filter((w) => group(w.state) === i).map((w) => w.minutes)),
    );
    return { label: "#" + f.issue, values, recorded: matches.length > 0 };
  });
  if (!rows.some((r) => r.recorded)) return empty;
  const max = Math.max(1, ...rows.map((r) => total(r.values)));
  const marks: Mark[] = [];
  rows.forEach(({ label, values }, i) => {
    let start = 0;
    values.forEach((v, s) => {
      if (v)
        marks.push({
          shape: "bar",
          x: start / max,
          y: (i + 0.5) / rows.length,
          w: v / max,
          slot: s,
          label: label + " " + waitNames[s] + " " + format(v) + "分",
        });
      start += v;
    });
  });
  return chart({
    marks,
    series: waitNames,
    labels: rows.map((r) => r.label),
    height: rows.length * 27,
    axis: ["0分", format(max) + "分"],
    headers: ["Issue", ...waitNames.map((n) => n + "（分）")],
    rows: rows.map((r) => [r.label, ...r.values.map((v) => (r.recorded ? v : null))]),
  });
}
function domain(times: number[]) {
  const min = times.reduce((a, b) => Math.min(a, b), Infinity);
  const max = times.reduce((a, b) => Math.max(a, b), -Infinity);
  return {
    at: (t: number) => (max === min ? 0.5 : (t - min) / (max - min)),
    axis: [stamp(new Date(min).toISOString()), stamp(new Date(max).toISOString())],
  };
}
function checks(d: DashboardData) {
  const jobs = d.mart_ci_job.filter(
    (j) => j.workflow === "check" && (j.queue_minutes !== null || j.run_minutes !== null),
  );
  if (!jobs.length) return empty;
  const x = domain(jobs.map((j) => Date.parse(j.created_at)));
  const fields = ["queue_minutes", "run_minutes"] as const,
    series = ["順番待ち", "実行"];
  const max = jobs.reduce((m, j) => Math.max(m, j.queue_minutes ?? 0, j.run_minutes ?? 0), 1);
  const marks: Mark[] = [];
  const reference: string[] = [];
  fields.forEach((f, s) => {
    for (const p of [0.5, 0.9]) {
      const v = quantile(jobs.map((j) => j[f]).filter(numeric), p);
      if (v === null) continue;
      const label = series[s] + " p" + p * 100 + " " + format(v) + "分";
      reference.push(label);
      marks.push({ shape: "rule", x: 0, y: 1 - v / max, slot: s, label, dashed: p === 0.9 });
    }
  });
  for (const j of jobs)
    fields.forEach((f, s) => {
      const v = j[f];
      if (v !== null)
        marks.push({
          shape: "dot",
          slot: s,
          x: x.at(Date.parse(j.created_at)),
          y: 1 - v / max,
          label:
            "#" + j.job_id + " " + stamp(j.created_at) + " " + series[s] + " " + format(v) + "分",
        });
    });
  return chart({
    marks,
    series,
    axis: x.axis,
    top: format(max) + "分",
    bottom: "0分",
    note: reference.join(" ／ "),
    headers: ["ジョブ", "作成（UTC）", "順番待ち（分）", "実行（分）"],
    rows: jobs.map((j) => [j.job_id, stamp(j.created_at), j.queue_minutes, j.run_minutes]),
  });
}
function runner(d: DashboardData) {
  const hours = d.mart_runner_hour;
  if (!hours.length) return empty;
  const times = hours.map((h) => Date.parse(h.hour));
  const x = domain([...times, times.reduce((a, b) => Math.max(a, b)) + hour]);
  const marks: Mark[] = [];
  for (const h of hours) {
    const t = Date.parse(h.hour);
    let base = 0;
    [h.check_minutes, h.deploy_minutes].forEach((v, s) => {
      if (v)
        marks.push({
          shape: "column",
          slot: s,
          x: x.at(t + hour / 2),
          w: x.at(t + hour) - x.at(t),
          y: 1 - (base + v) / 60,
          h: v / 60,
          label: stamp(h.hour) + " " + ["check", "deploy-staging"][s] + " " + format(v) + "分",
        });
      base += v;
    });
  }
  return chart({
    marks,
    series: ["check", "deploy-staging"],
    axis: x.axis,
    top: "100%",
    bottom: "0%",
    headers: ["時間（UTC）", "check（分）", "deploy-staging（分）", "稼働率（%）"],
    rows: hours.map((h) => [stamp(h.hour), h.check_minutes, h.deploy_minutes, h.utilization * 100]),
  });
}
function mergeWait(d: DashboardData) {
  const reasons = new Map([
    ["staging_occupied", "staging占有"],
    ["deploy_running", "デプロイ実行中"],
    ["conflict_or_rebase", "競合・リベース"],
    ["none", "理由を特定できず"],
  ]);
  const sums = new Map<string, number>();
  for (const r of d.mart_merge_wait)
    if (r.minutes !== null) sums.set(r.reason, (sums.get(r.reason) ?? 0) + r.minutes);
  if (!sums.size) return empty;
  const entries = [...sums].sort((a, b) => b[1] - a[1]);
  const labels = entries.map(([key]) => reasons.get(key) ?? key);
  const max = Math.max(1, ...sums.values());
  return chart({
    marks: entries.map(([, v], i) => ({
      shape: "bar",
      x: 0,
      y: (i + 0.5) / entries.length,
      w: v / max,
      slot: 0,
      label: labels[i] + " " + format(v) + "分",
    })),
    labels,
    height: entries.length * 32,
    axis: ["0分", format(max) + "分"],
    headers: ["推定理由", "待ち時間の合計（分）"],
    rows: entries.map(([key, v]) => [reasons.get(key) ?? key, v]),
    note:
      `PASSからマージまでを測れたのは、マージ済み${d.mart_merge_wait.length}件のうち` +
      `${d.mart_merge_wait.filter((r) => r.minutes !== null).length}件。` +
      "待ちの区間の一部でも占有やデプロイと重なれば、その区間全体をその理由に数える。",
  });
}
function wip(d: DashboardData) {
  const rows = [...d.mart_wip].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!rows.length) return empty;
  const max = rows.reduce((m, r) => Math.max(m, r.active_owners), 5);
  const x = domain(rows.map((r) => Date.parse(r.at)));
  const marks: Mark[] = [
    { shape: "rule", x: 0, y: 1 - 5 / max, slot: 1, label: "担当の上限 5人", dashed: true },
  ];
  for (const r of rows)
    marks.push({
      shape: "dot",
      x: x.at(Date.parse(r.at)),
      y: 1 - r.active_owners / max,
      slot: 0,
      label: stamp(r.at) + " 担当 " + r.active_owners + "人",
    });
  return chart({
    marks,
    axis: x.axis,
    series: ["活動中の担当", "担当の上限（5人）"],
    top: max + "人",
    bottom: "0人",
    headers: ["時間（UTC）", "活動中の担当", "着手可能なIssue"],
    rows: rows.map((r) => [stamp(r.at), r.active_owners, r.queued_ready]),
  });
}
function timeline(d: DashboardData, issue: number) {
  const spans = d.span
    .filter((s) => s.issue === issue)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (!spans.length) return "<p>活動区間の記録はありません。</p>";
  const x = domain(
    spans.flatMap((s) => [Date.parse(s.start), Date.parse(s.end ?? d.generated_at)]),
  );
  const names = new Map([
    ["owner_turn", "担当のターン"],
    ["advisor_run", "設計"],
    ["implementer_run", "Codex"],
    ["verifier_run", "検証役"],
    ["ci_queue", "CIの順番待ち"],
    ["ci_run", "CIの実行"],
    ["coordinator_turn", "指揮役"],
    ["staging_occupancy", "staging占有"],
    ["deploy_queue", "デプロイ待ち"],
    ["deploy_run", "デプロイ実行"],
  ]);
  const labels = spans.map((s) => names.get(s.kind) ?? s.kind);
  return chart({
    marks: spans.map((s, i) => ({
      shape: "bar",
      slot: 0,
      x: x.at(Date.parse(s.start)),
      y: (i + 0.5) / spans.length,
      w: x.at(Date.parse(s.end ?? d.generated_at)) - x.at(Date.parse(s.start)),
      label: labels[i] + " " + stamp(s.start) + " 〜 " + (s.end ? stamp(s.end) : "継続中"),
    })),
    labels,
    height: spans.length * 27,
    axis: x.axis,
    headers: ["活動", "開始（UTC）", "終了（UTC）"],
    rows: spans.map((s) => [
      names.get(s.kind) ?? s.kind,
      stamp(s.start),
      s.end ? stamp(s.end) : "継続中",
    ]),
  });
}
function issues(d: DashboardData) {
  if (!d.mart_issue_flow.length) return empty;
  const headers = [
    "Issue",
    "タイトル",
    "着手（UTC）",
    "マージ（UTC）",
    "所要（分）",
    "検証回数",
    "FAIL",
  ];
  return (
    '<div class="scroll"><table><thead><tr>' +
    headers.map((h) => "<th>" + h + "</th>").join("") +
    "</tr></thead><tbody>" +
    [...d.mart_issue_flow]
      .sort((a, b) => Date.parse(b.launch) - Date.parse(a.launch))
      .map((f) => {
        const id = "issue-" + esc(f.issue);
        return (
          '<tr data-issue><td><button aria-controls="' +
          id +
          '" aria-expanded="false">#' +
          esc(f.issue) +
          "</button></td>" +
          [
            f.title,
            stamp(f.launch),
            stamp(f.merged),
            format(elapsed(f.launch, f.merged)),
            f.verifier_rounds,
            f.fails,
          ]
            .map((v) => "<td>" + esc(v) + "</td>")
            .join("") +
          '</tr><tr id="' +
          id +
          '" hidden><td colspan="7">' +
          timeline(d, f.issue) +
          "</td></tr>"
        );
      })
      .join("") +
    "</tbody></table></div>"
  );
}
export function renderDashboard(d: DashboardData): string {
  const health = d.mart_health;
  const panels = [
    ["主要指標", kpis(d)],
    ["Issueごとの待ち時間", waitChart(d)],
    ["checkの順番待ちと実行時間", checks(d)],
    ["runnerの時間別稼働率", runner(d)],
    ["マージ待ちの推定理由", mergeWait(d)],
    ["活動中の担当数", wip(d)],
    ["Issueと活動履歴", issues(d)],
    [
      "計測元の状態",
      health.length
        ? table(
            [
              "計測元",
              "最終取り込み（UTC）",
              "最終取得（UTC）",
              "遅延（分）",
              "保留",
              "隔離",
              "取得失敗",
            ],
            health.map((h) => [
              h.source,
              stamp(h.last_append),
              stamp(h.last_poll),
              h.lag_minutes,
              h.held,
              h.quarantined,
              h.failed_cycles,
            ]),
          )
        : empty,
    ],
  ];
  const sections = panels
    .map(([title, body]) => `<section><h2>${title}</h2>${body}</section>`)
    .join("");
  const json = JSON.stringify(d)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Software Factory 稼働状況</title><style>${style}</style></head>
<body><main><header><h1>Software Factory 稼働状況</h1>
<p>集計期間 ${stamp(d.range_start)} 〜 ${stamp(d.range_end)} UTC<br>最終更新 ${stamp(d.generated_at)} UTC</p></header>
${sections}</main><div id="tip" hidden></div>
<script id="dashboard-data" type="application/json">${json}</script><script>${interactions}</script></body></html>`;
}
