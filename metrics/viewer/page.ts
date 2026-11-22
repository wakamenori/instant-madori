// Series colors pass dataviz validate_palette.js against these exact surfaces in both modes.
const light = `
  --surface: #fcfcfb;
  --ink: #1d1f1e;
  --ink-2: #4f524f;
  --ink-3: #696c68;
  --rule: #e4e4df;
  --rule-strong: #c9cac3;
  --hover: #f1f1ed;
  --band: rgba(42, 120, 214, 0.16);
  --neutral: #9a9c96;
  --actor: #6f726d;
  --work: #2a78d6;
  --wait: #eb6834;
  --unclassified: #8a8984;
  --running: #1baf7a;
  --dispatch: #eda100;
  --resource: #e87ba4;
  --ready: #6250d6;
  --alert: #fdf0d5;`;
const dark = `
  --surface: #1a1a19;
  --ink: #efeee9;
  --ink-2: #c2c1b8;
  --ink-3: #9d9c94;
  --rule: #2e2e2c;
  --rule-strong: #46463f;
  --hover: #252524;
  --band: rgba(57, 135, 229, 0.2);
  --neutral: #6e6d68;
  --actor: #a5a49d;
  --work: #3987e5;
  --wait: #d95926;
  --unclassified: #8f8e89;
  --running: #199e70;
  --dispatch: #c98500;
  --resource: #d55181;
  --ready: #9085e9;
  --alert: #3a2f17;`;
export const style = `
:root { color-scheme: light; ${light} }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { color-scheme: dark; ${dark} }
}
:root[data-theme="dark"] { color-scheme: dark; ${dark} }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body {
  margin: 0;
  background: var(--surface);
  color: var(--ink);
  font: 13px/1.45 "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif;
}
main { max-width: 1280px; margin: auto; padding: 12px 24px 48px; }
h1, h2, h3 { margin: 0; font-feature-settings: "palt"; }
h1 { font-size: 18px; font-weight: 600; }
h2 { font-size: 13px; font-weight: 600; color: var(--ink); }
h3 { font-size: 12px; font-weight: 600; color: var(--ink-2); margin-bottom: 4px; }
h2 small, h3 small { font-weight: 400; color: var(--ink-3); margin-left: 8px; font-size: 11px; }
p { margin: 0; }
a { color: inherit; text-underline-offset: 2px; }
button { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--work); outline-offset: 2px; }
aside { padding: 2px 8px; background: var(--alert); border-radius: 4px; font-size: 12px; white-space: nowrap; }

header { display: flex; align-items: baseline; gap: 14px; padding-bottom: 10px; border-bottom: 1px solid var(--rule-strong); }
header > p { color: var(--ink-3); font-size: 12px; }
.filters { margin-left: auto; display: flex; gap: 20px; }
fieldset { border: 0; margin: 0; padding: 0; display: flex; align-items: center; gap: 0; }
fieldset legend { float: left; margin-right: 8px; color: var(--ink-3); font-size: 12px; padding: 0; }
fieldset label { cursor: pointer; }
fieldset input { position: absolute; opacity: 0; pointer-events: none; }
fieldset span { display: block; padding: 3px 10px; border: 1px solid var(--rule-strong); margin-left: -1px; font-size: 12px; color: var(--ink-2); }
fieldset label:first-of-type span { border-radius: 4px 0 0 4px; }
fieldset label:last-of-type span { border-radius: 0 4px 4px 0; }
fieldset input:checked + span { background: var(--ink); border-color: var(--ink); color: var(--surface); }
fieldset input:focus-visible + span { outline: 2px solid var(--work); outline-offset: 1px; }

.combo > section { display: grid; gap: 0 28px; padding: 12px 0; border-bottom: 1px solid var(--rule); }
.chart-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.swap { border: 0; background: none; padding: 0; font-size: 11px; color: var(--ink-3); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.swap[aria-pressed="true"] { color: var(--ink); }

.kpis { grid-template-columns: 5fr 7fr; align-items: stretch; }
.factors { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 24px; padding-left: 28px; border-left: 1px solid var(--rule); }
.tile .value { margin-top: 2px; color: var(--ink-2); font-size: 12px; }
.tile .value strong { font-size: 24px; font-weight: 600; color: var(--ink); letter-spacing: -0.01em; }
.tile .meta { display: flex; flex-wrap: wrap; gap: 2px 10px; color: var(--ink-3); font-size: 11px; margin-bottom: 4px; }
.hero { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto 1fr; gap: 0 24px; }
.hero .chart-head { grid-column: 1 / -1; }
.hero .value strong { font-size: 46px; line-height: 1.05; letter-spacing: -0.02em; }
.hero .value { font-size: 15px; margin-top: 6px; }
.hero .meta { flex-direction: column; grid-column: 1; margin: 4px 0 0; }
.hero figure { grid-column: 2; grid-row: 2 / 4; align-self: end; }

figure { margin: 0; }
.plot { position: relative; height: var(--h); }
.plot svg { display: block; width: 100%; height: 100%; overflow: visible; }
.spark .plot { margin-right: 4px; }
.line { fill: none; stroke: var(--ink); stroke-width: 1.5; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
.hero .line { stroke-width: 2; }
.band { fill: var(--band); }
.dot { position: absolute; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--ink); box-shadow: 0 0 0 2px var(--surface); }
.break { stroke: var(--rule-strong); stroke-width: 1; vector-effect: non-scaling-stroke; }
.grid { stroke: var(--rule); stroke-width: 1; vector-effect: non-scaling-stroke; }
.base { stroke: var(--rule-strong); stroke-width: 1; vector-effect: non-scaling-stroke; }
.cap { stroke: var(--ink); stroke-width: 1.5; vector-effect: non-scaling-stroke; fill: none; }
.stack rect { stroke: var(--surface); stroke-width: 1; vector-effect: non-scaling-stroke; }
.stack .plot { margin-left: 30px; }
.yaxis span { position: absolute; left: -30px; width: 26px; text-align: right; transform: translateY(-50%); font-size: 10px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.xaxis { position: relative; height: 30px; margin-left: 30px; font-size: 10px; color: var(--ink-3); font-variant-numeric: tabular-nums; }
.xaxis span { position: absolute; top: 2px; transform: translateX(-50%); white-space: nowrap; }
.xaxis span:first-child { transform: none; }
.xaxis .end { right: 0; transform: none; }
.xaxis .resume { top: 15px; padding-left: 4px; border-left: 1px solid var(--rule-strong); transform: none; }
.xaxis .resume.left { padding: 0 4px 0 0; border-left: 0; border-right: 1px solid var(--rule-strong); transform: translateX(-100%); }
.probe { position: absolute; inset: 0; cursor: crosshair; }
.probe:focus-visible { outline-offset: 0; }
.cross { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px solid var(--ink-2); pointer-events: none; }
#tooltip { position: fixed; z-index: 10; pointer-events: none; min-width: 140px; max-width: 280px; padding: 6px 8px; background: var(--surface); border: 1px solid var(--rule-strong); border-radius: 4px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12); font-size: 11px; }
#tooltip p { color: var(--ink-3); margin-bottom: 2px; }
#tooltip div { display: flex; align-items: center; gap: 6px; }
#tooltip b { font-size: 12px; font-variant-numeric: tabular-nums; min-width: 3.5em; }
#tooltip i { width: 10px; height: 2px; flex: none; }
#tooltip span { color: var(--ink-2); }

.legend { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 2px 0 6px; padding: 0; list-style: none; font-size: 11px; color: var(--ink-2); }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.legend b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }

.effort { grid-template-columns: 5fr 4fr 3fr; }
.breakdown .plot { --h: 140px; }
.note { font-size: 11px; color: var(--ink-3); }
.phases { grid-column: 2 / 4; display: grid; grid-template-columns: 4fr 3fr; gap: 6px 28px; align-content: start; }
.phases h2 { grid-column: 1 / -1; }
.matrix { align-self: start; width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.matrix th { font-weight: 400; color: var(--ink-3); text-align: left; padding: 3px 6px 3px 0; font-size: 11px; }
.matrix thead th { text-align: right; border-bottom: 1px solid var(--rule-strong); }
.matrix tbody th { color: var(--ink-2); font-size: 12px; white-space: nowrap; }
.matrix td { padding: 1px 0; text-align: right; border-bottom: 1px solid var(--rule); }
.matrix .sum { color: var(--ink-2); padding-left: 10px; }
.matrix tfoot td, .matrix tfoot th { border-bottom: 0; border-top: 1px solid var(--rule-strong); padding-top: 3px; color: var(--ink-2); }
.matrix button { position: relative; width: 100%; padding: 3px 6px 5px; border: 0; border-radius: 3px; background: none; text-align: right; cursor: pointer; }
.matrix button i { position: absolute; left: 6px; bottom: 2px; height: 2px; border-radius: 1px; max-width: calc(100% - 12px); }
.matrix button:hover:not(:disabled) { background: var(--hover); }
.matrix button[aria-pressed="true"] { background: var(--ink); color: var(--surface); }
.matrix button:disabled { color: var(--ink-3); cursor: default; }
.lists { display: grid; gap: 10px; align-content: start; }
.bars { list-style: none; margin: 0; padding: 0; font-size: 12px; }
.bars li { position: relative; display: grid; grid-template-columns: 1fr auto; column-gap: 8px; padding: 1px 0 4px; line-height: 1.35; }
.bars span { color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bars b { font-weight: 600; font-variant-numeric: tabular-nums; }
.bars small { font-weight: 400; color: var(--ink-3); }
.bars i { position: absolute; left: 0; bottom: 1px; height: 3px; border-radius: 0 2px 2px 0; min-width: 2px; }

.flow { grid-template-columns: 4fr 3fr 5fr; }
.capacity .plot { --h: 96px; }
.kinds .bars { margin-top: 6px; }
.issues ol { list-style: none; margin: 0; padding: 0; }
.issue { display: grid; grid-template-columns: 3.4em 1fr 72px 4.2em; align-items: center; gap: 8px; width: 100%; padding: 3px 4px; border: 0; border-bottom: 1px solid var(--rule); background: none; text-align: left; cursor: pointer; font-size: 12px; }
.issue:hover:not(:disabled) { background: var(--hover); }
.issue:disabled { cursor: default; }
.issue .no { color: var(--ink-3); font-variant-numeric: tabular-nums; }
.issue .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.issue b { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.issue small { font-weight: 400; color: var(--ink-3); }
.seg { display: flex; height: 6px; gap: 1px; border-radius: 3px; overflow: hidden; }
.rest summary { font-size: 11px; color: var(--ink-3); cursor: pointer; padding-top: 4px; }

.reliability { display: flex; flex-wrap: wrap; gap: 4px 22px; padding: 8px 0; font-size: 12px; color: var(--ink-2); border-bottom: 1px solid var(--rule-strong); }
.reliability a { font-weight: 600; color: var(--ink); }
.reliability b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.reliability span:last-child { margin-left: auto; color: var(--ink-3); }

.detail, .combo > section.detail { display: block; padding: 22px 0 6px; border-bottom: 0; }
.detail h2 { font-size: 15px; margin-bottom: 10px; }
.detail h3 { margin-top: 14px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.dim table { color: var(--ink-3); }
.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
.detail th, .detail td, .chart-table th, .chart-table td { text-align: left; padding: 4px 10px 4px 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
.detail th, .chart-table th { font-weight: 600; color: var(--ink-2); border-bottom-color: var(--rule-strong); }
.num { text-align: right !important; font-variant-numeric: tabular-nums; }
.chart-table { max-height: 260px; overflow: auto; }
details { margin-top: 10px; }
details summary { cursor: pointer; color: var(--ink-2); }
.empty { color: var(--ink-3); font-size: 12px; padding: 4px 0; }

dialog { width: min(960px, calc(100vw - 32px)); padding: 16px 20px; border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--surface); color: var(--ink); }
dialog::backdrop { background: rgba(0, 0, 0, 0.35); }
dialog form { float: right; }
.close { border: 1px solid var(--rule-strong); background: none; border-radius: 4px; padding: 2px 10px; cursor: pointer; }
dialog h2 { font-size: 15px; margin-bottom: 8px; }
.lanes .plot { height: auto; }
.lane { display: grid; grid-template-columns: 8em 1fr; align-items: center; gap: 10px; height: 20px; font-size: 12px; }
.lane b { font-weight: 400; color: var(--ink-2); }
.track { position: relative; height: 10px; background: var(--hover); border-radius: 2px; }
.track i { position: absolute; top: 0; bottom: 0; min-width: 1px; }
.lanes.tracking .track::after { content: ""; position: absolute; left: var(--cursor); top: -5px; bottom: -5px; border-left: 1px solid var(--ink); }

@media (max-width: 900px) {
  main { padding: 10px 16px 40px; }
  header { flex-wrap: wrap; }
  .filters { margin-left: 0; flex-wrap: wrap; }
  .kpis, .effort, .flow, .pair { grid-template-columns: 1fr; }
  .phases { grid-column: auto; grid-template-columns: 1fr; }
  .factors { padding-left: 0; border-left: 0; grid-auto-flow: row; padding-top: 12px; }
  .hero { grid-template-columns: 1fr; }
  .hero figure { grid-column: 1; grid-row: auto; }
  .combo > section > * + * { margin-top: 14px; }
}
`;
export const script = String.raw`
const form = document.querySelector(".filters");
function selectCombo() {
  const target = form.elements.target.value, span = form.elements.span.value;
  for (const panel of document.querySelectorAll(".combo"))
    panel.hidden = panel.dataset.span !== span || panel.dataset.target !== target;
  hideTip();
}
form.addEventListener("change", selectCombo);
const dialog = document.querySelector("dialog");
const tooltip = document.querySelector("#tooltip");
const hours = (ms) => (ms / 3600000).toLocaleString("ja-JP", { maximumFractionDigits: ms < 36000000 ? 2 : 1 });
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.matches(".swap")) {
    const host = button.closest("article, .chart");
    const on = button.getAttribute("aria-pressed") !== "true";
    for (const figure of host.querySelectorAll("figure")) {
      figure.querySelector(".chart-table").hidden = !on;
      for (const part of figure.querySelectorAll(":scope > .plot, :scope > .xaxis")) part.hidden = on;
    }
    button.setAttribute("aria-pressed", String(on));
    button.textContent = on ? "グラフで見る" : "表で見る";
  } else if (button.matches("[data-cell]")) {
    const panel = button.closest(".combo"),
      active = button.getAttribute("aria-pressed") !== "true";
    for (const cell of panel.querySelectorAll("[data-cell]"))
      cell.setAttribute("aria-pressed", String(active && cell === button));
    const [phase, tier] = button.dataset.cell.split(".");
    const weight = (row) =>
      active ? (JSON.parse(row.dataset.cells)[phase]?.[tier] ?? 0) : Number(row.dataset.effort);
    const rows = Array.from(panel.querySelectorAll(".issue")).sort(
      (a, b) => weight(b) - weight(a) || Number(a.dataset.issue) - Number(b.dataset.issue),
    );
    const top = panel.querySelector(".top"), rest = panel.querySelector(".rest");
    let count = 0;
    for (const row of rows) {
      const item = row.parentElement;
      item.hidden = active && !weight(row);
      (!item.hidden && ++count <= 6 ? top : rest.querySelector("ol")).append(item);
      row.querySelector("b").firstChild.textContent = hours(weight(row));
    }
    rest.hidden = count <= 6;
    rest.open = false;
    rest.querySelector("summary").textContent = "ほかの" + Math.max(0, count - 6) + "件";
    const state = panel.querySelector(".filter-state");
    state.hidden = !active;
    state.textContent = active ? button.getAttribute("aria-label").replace("で絞り込む", "") + "の時間が長い順" : "";
    panel.querySelector(".empty-issues").hidden = count !== 0;
  } else if (button.matches(".issue")) {
    dialog.querySelector("div").replaceChildren(
      document.querySelector("#issue-" + button.dataset.issue).content.cloneNode(true),
    );
    dialog.showModal();
  }
});
function hideTip() {
  tooltip.hidden = true;
  for (const line of document.querySelectorAll(".cross")) line.hidden = true;
}
function showTip(layer, index, anchor) {
  const chart = JSON.parse(layer.dataset.chart);
  const row = chart.rows[index];
  if (!row) return hideTip();
  const line = layer.querySelector(".cross");
  line.hidden = false;
  line.style.left = (100 * (row.a + row.b)) / 2 + "%";
  const head = document.createElement("p");
  head.textContent = row.t + " JST まで";
  const items = chart.series.map((s, i) => {
    const div = document.createElement("div"), key = document.createElement("i"),
      value = document.createElement("b"), name = document.createElement("span");
    key.style.background = "var(--" + s.color + ")";
    value.textContent = row.v[i] + " " + chart.unit;
    name.textContent = s.label;
    div.append(key, value, name);
    return div;
  });
  tooltip.replaceChildren(head, ...items.reverse());
  tooltip.hidden = false;
  const box = layer.getBoundingClientRect();
  const x = anchor ?? box.left + (box.width * (row.a + row.b)) / 2;
  const left = x + 14 + tooltip.offsetWidth > innerWidth ? x - 14 - tooltip.offsetWidth : x + 14;
  tooltip.style.left = Math.max(4, left) + "px";
  tooltip.style.top = Math.max(4, Math.min(box.top, innerHeight - tooltip.offsetHeight - 4)) + "px";
  layer.dataset.index = index;
}
function nearest(layer, clientX) {
  const box = layer.getBoundingClientRect(), f = (clientX - box.left) / box.width;
  const rows = JSON.parse(layer.dataset.chart).rows;
  const i = rows.findIndex((r) => f < r.b);
  return i === -1 ? rows.length - 1 : i;
}
document.addEventListener("pointermove", (event) => {
  const layer = event.target.closest(".probe[data-chart]");
  const lanes = event.target.closest(".lanes");
  for (const chart of document.querySelectorAll(".lanes.tracking")) chart.classList.remove("tracking");
  if (layer) return showTip(layer, nearest(layer, event.clientX), event.clientX);
  if (lanes) {
    const track = lanes.querySelector(".track");
    if (!track) return;
    const box = track.getBoundingClientRect(), f = (event.clientX - box.left) / box.width;
    if (f < 0 || f > 1) return hideTip();
    const time = Number(lanes.dataset.start) + f * (Number(lanes.dataset.end) - Number(lanes.dataset.start));
    const head = document.createElement("p");
    head.textContent = new Date(time).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) + " JST";
    const active = Array.from(lanes.querySelectorAll(".lane"))
      .filter((lane) => Array.from(lane.querySelectorAll("i")).some((i) => Number(i.dataset.start) <= time && time < Number(i.dataset.end)))
      .map((lane) => { const d = document.createElement("div"); d.textContent = lane.querySelector("b").textContent; return d; });
    lanes.style.setProperty("--cursor", 100 * f + "%");
    lanes.classList.add("tracking");
    dialog.append(tooltip);
    tooltip.replaceChildren(head, ...active);
    tooltip.hidden = false;
    tooltip.style.left = Math.min(event.clientX + 14, innerWidth - tooltip.offsetWidth - 4) + "px";
    tooltip.style.top = Math.min(event.clientY + 14, innerHeight - tooltip.offsetHeight - 4) + "px";
    return;
  }
  if (tooltip.parentElement !== document.body) document.body.append(tooltip);
  hideTip();
});
document.addEventListener("focusin", (event) => {
  const layer = event.target.closest?.(".probe[data-chart]");
  if (layer) showTip(layer, JSON.parse(layer.dataset.chart).rows.length - 1);
});
document.addEventListener("focusout", (event) => {
  if (event.target.closest?.(".probe[data-chart]")) hideTip();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") return hideTip();
  const layer = event.target.closest?.(".probe[data-chart]");
  if (!layer || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
  event.preventDefault();
  const last = JSON.parse(layer.dataset.chart).rows.length - 1;
  const index = Math.max(0, Math.min(last, Number(layer.dataset.index ?? last) + (event.key === "ArrowLeft" ? -1 : 1)));
  showTip(layer, index);
});
`;
