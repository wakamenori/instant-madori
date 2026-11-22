export const style = `
:root {
  color-scheme: light dark;
  --surface: #fcfcfb;
  --ink: #262722;
  --muted: #555750;
  --edge: #d6d7cf;
  --neutral: #71796e;
  --work: #2a78d6;
  --wait: #eb6834;
  --unclassified: #8a8984;
  --running: #1baf7a;
  --dispatch: #eda100;
  --resource: #e87ba4;
  --ready: #6250d6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --surface: #1a1a19;
    --ink: #edeee8;
    --muted: #b7b8b0;
    --edge: #474940;
    --neutral: #a1aa9c;
    --work: #3987e5;
    --wait: #d95926;
    --unclassified: #8f8e89;
    --running: #199e70;
    --dispatch: #c98500;
    --resource: #d55181;
    --ready: #9085e9;
  }
}
* {
  box-sizing: border-box;
}
[hidden] {
  display: none !important;
}
body {
  margin: 0;
  background: var(--surface);
  color: var(--ink);
  font:
    14px/1.4 system-ui,
    sans-serif;
  font-variant-numeric: tabular-nums;
}
main {
  max-width: 1600px;
  margin: auto;
  padding: 8px 20px;
}
header,
header label,
.tiles,
.legend,
.quality > div {
  display: flex;
  gap: 12px;
  align-items: center;
}
header {
  margin-bottom: 8px;
}
header > div {
  margin-right: auto;
}
h1,
h2,
h3,
p {
  margin: 0;
}
h1 {
  font-size: 22px;
}
h2 {
  font-size: 16px;
  margin-bottom: 6px;
}
h3 {
  font-size: 14px;
  margin: 12px 0 4px;
}
small {
  font-size: 11px;
  color: var(--muted);
}
button,
select,
summary {
  font: inherit;
  color: inherit;
  cursor: pointer;
}
button,
select,
dialog {
  background: var(--surface);
  border: 1px solid var(--edge);
  border-radius: 4px;
  color: var(--ink);
}
button:hover,
button[aria-pressed="true"] {
  background: var(--ink);
  color: var(--surface);
}
a {
  color: inherit;
}
article {
  border: 1px solid var(--edge);
  border-radius: 6px;
  padding: 10px;
  min-width: 0;
}
.tiles {
  align-items: stretch;
  gap: 8px;
}
.tile {
  flex: 1;
}
.tile:first-child {
  flex: 1.35;
}
.tile strong {
  font-size: 26px;
}
.tile:first-child strong {
  font-size: 34px;
}
.tile small,
.middle article > small {
  display: block;
}
.tile .plot svg {
  height: 32px;
}
.middle,
.lower {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}
.middle {
  grid-template-columns: 1.65fr 1fr 1fr 1fr;
}
.lower {
  grid-template-columns: 1.4fr 1fr 1.35fr;
}
.middle article,
.lower article {
  max-height: 230px;
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  border-bottom: 1px solid var(--edge);
  padding: 3px 4px;
}
td button {
  width: 100%;
}
.scroll {
  overflow: auto;
}
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
  font-size: 12px;
  padding: 0 0 3px;
}
.bar b,
.issue b {
  margin-left: auto;
  white-space: nowrap;
}
.bar i {
  position: absolute;
  height: 2px;
  bottom: 1px;
  left: 0;
  background: var(--neutral);
}
.plot svg {
  width: 100%;
  height: 110px;
  display: block;
}
.plot small {
  display: flex;
  justify-content: space-between;
}
.chart {
  text-align: right;
}
.ceiling{float:left;color:var(--muted);font-size:10px}.tick{stroke:var(--ink);vector-effect:non-scaling-stroke}
.chart .swap {
  font-size: 10px;
}
.chart-table {
  max-height: 135px;
  overflow: auto;
  font-size: 11px;
}
.line,
.gap,
.break,
.cross {
  fill: none;
  vector-effect: non-scaling-stroke;
}
.line,
.break,
.cross {
  stroke: var(--ink);
}
.break {
  stroke-dasharray: 2 3;
  stroke-width: 2;
}
.cross {
  pointer-events: none;
}
.gap {
  stroke: var(--surface);
  stroke-width: 2;
}
.band {
  fill: var(--neutral);
  opacity: 0.28;
}
.legend {
  flex-wrap: wrap;
  gap: 2px 8px;
  font-size: 11px;
}
.legend i {
  display: inline-block;
  width: 9px;
  height: 9px;
  margin-right: 3px;
}
.issue {
  display: flex;
  width: 100%;
  align-items: center;
  text-align: left;
  padding: 3px 2px;
  gap: 6px;
  border: 0;
  border-bottom: 1px solid var(--edge);
}
.issue span {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.reliability {
  margin-top: 8px;
  padding: 8px;
  border-block: 1px solid var(--edge);
}
.quality,
main > section:not(.combo) {
  margin-top: 32px;
}
.quality > div > div {
  flex: 1;
}
.dim {
  opacity: 0.68;
}
aside {
  font-weight: bold;
}
dialog {
  width: min(800px, 90vw);
  max-height: 80vh;
}
.close {
  float: right;
}
.lanes {
  text-align: left;
}
.lanes.hover .track:after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: var(--cursor);
  border-left: 1px solid var(--ink);
}
.lanes > div {
  display: grid;
  grid-template-columns: 90px 1fr;
  margin: 4px;
}
.lanes > div > div {
  position: relative;
  background: color-mix(in srgb, var(--neutral) 10%, transparent);
}
.lanes i {
  position: absolute;
  top: 3px;
  bottom: 3px;
}
#tooltip {
  pointer-events: none;
  position: fixed;
  z-index: 3;
  white-space: pre-line;
  background: var(--ink);
  color: var(--surface);
  border-radius: 4px;
  padding: 6px 10px;
  font-size: 12px;
}
@media (max-width: 850px) {
  main {
    padding: 8px;
  }
  .middle,
  .lower {
    grid-template-columns: 1fr 1fr;
  }
  .tiles,
  header {
    flex-wrap: wrap;
  }
  .tile {
    min-width: 42%;
  }
  .middle article,
  .lower article {
    max-height: none;
  }
  .reliability {
    font-size: 12px;
  }
}
`;
export const script = String.raw`
const target = document.querySelector("#target"),
  span = document.querySelector("#window");
function selectCombo() {
  for (const panel of document.querySelectorAll(".combo"))
    panel.hidden =
      panel.dataset.span !== span.value ||
      panel.dataset.target !== target.value;
}
target.onchange = span.onchange = selectCombo;
const dialog = document.querySelector("dialog");
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.matches(".swap")) {
    const chart = button.closest(".chart"),
      table = chart.querySelector(".chart-table");
    table.hidden = !table.hidden;
    chart.querySelector(".plot").hidden = !table.hidden;
    button.textContent = table.hidden ? "表で見る" : "グラフで見る";
    button.setAttribute("aria-expanded", String(!table.hidden));
  } else if (button.matches("[data-cell]")) {
    const panel = button.closest(".combo"),
      active = button.getAttribute("aria-pressed") !== "true";
    for (const cell of panel.querySelectorAll("[data-cell]"))
      cell.setAttribute("aria-pressed", String(active && cell === button));
    const [phase, tier] = button.dataset.cell.split(".");
    const weight = (row) =>
      active
        ? (JSON.parse(row.dataset.cells)[phase]?.[tier] ?? 0)
        : Number(row.dataset.effort);
    const issues = Array.from(panel.querySelectorAll(".issue")).sort(
      (a, b) =>
        weight(b) - weight(a) ||
        Number(a.dataset.issue) - Number(b.dataset.issue),
    );
    let count = 0;
    const rest = panel.querySelector(".rest");
    for (const row of issues) {
      row.hidden = active && !weight(row);
      const dest =
        !row.hidden && ++count <= 6
          ? panel.querySelector(".top")
          : rest.querySelector("div");
      dest.append(row);
      row.querySelector("b").textContent =
        (weight(row) / 3600000).toLocaleString("ja-JP", {
          maximumFractionDigits: 2,
        }) + " h";
    }
    rest.hidden = count <= 6;
    rest.open = false;
    panel.querySelector(".empty-issues").hidden = count !== 0;
  } else if (button.matches(".issue")) {
    dialog
      .querySelector("div")
      .replaceChildren(
        document
          .querySelector("#issue-" + button.dataset.issue)
          .content.cloneNode(true),
      );
    dialog.showModal();
  } else if (button.matches(".close")) dialog.close();
});
const tooltip = document.querySelector("#tooltip");
document.addEventListener("pointermove", (event) => {
  const track = event.target.closest(".track");
  const lanes = track?.closest(".lanes");
  for (const chart of document.querySelectorAll(".lanes.hover"))
    chart.classList.remove("hover");
  const el = event.target.closest("[data-tip]");
  for (const line of document.querySelectorAll(".cross:not([hidden])"))
    line.setAttribute("hidden", "");
  tooltip.hidden = !el && !lanes;
  if (lanes) {
    const rect = track.getBoundingClientRect(),
      fraction = (event.clientX - rect.left) / rect.width;
    const time =
      Number(lanes.dataset.start) +
      fraction * (Number(lanes.dataset.end) - Number(lanes.dataset.start));
    const labels = Array.from(lanes.children)
      .filter((row) =>
        Array.from(row.querySelectorAll("i")).some(
          (i) =>
            Number(i.dataset.start) <= time && time < Number(i.dataset.end),
        ),
      )
      .map((row) => row.querySelector("b").textContent);
    lanes.style.setProperty("--cursor", 100 * fraction + "%");
    lanes.classList.add("hover");
    dialog.append(tooltip);
    tooltip.textContent = [
      new Date(time).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) +
        " JST",
      ...labels,
    ].join("\n");
  } else if (el) {
    document.body.append(tooltip);

    const svg = el.closest("svg"),
      rect = svg.getBoundingClientRect(),
      x = ((event.clientX - rect.left) / rect.width) * 1000;
    const line = svg.querySelector(".cross");
    line.removeAttribute("hidden");
    line.setAttribute("x1", x);
    line.setAttribute("x2", x);
    tooltip.textContent = el.dataset.tip;
  } else return;
  tooltip.style.left =
    Math.min(event.clientX + 12, innerWidth - tooltip.offsetWidth - 4) + "px";
  tooltip.style.top =
    Math.min(event.clientY + 12, innerHeight - tooltip.offsetHeight - 4) + "px";
});
`;
