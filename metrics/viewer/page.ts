export const style = `
:root {
  color-scheme: light;
  --surface: #fcfcfb;
  --page: #f9f9f7;
  --ink: #0b0b0b;
  --secondary: #52514e;
  --grid: #e1e0d9;
  --s0: #2a78d6;
  --s1: #eb6834;
  --s2: #1baf7a;
  --s3: #eda100;
  --s4: #e87ba4;
  --s5: #008300;
  --s6: #6250d6;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface: #1a1a19;
    --page: #0d0d0d;
    --ink: #f0efec;
    --secondary: #c3c2b7;
    --grid: #383835;
    --s0: #3987e5;
    --s1: #d95926;
    --s2: #199e70;
    --s3: #c98500;
    --s4: #d55181;
    --s5: #0ca30c;
    --s6: #9085e9;
  }
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font:
    15px/1.55 system-ui,
    sans-serif;
}
main {
  max-width: 1120px;
  margin: auto;
  padding: clamp(12px, 3vw, 40px);
}
header {
  padding: 1em 0;
}
h1 {
  font-size: clamp(24px, 4vw, 42px);
  letter-spacing: -0.04em;
  margin: 0;
}
p,
small,
.axis,
.ticks,
.legend {
  color: var(--secondary);
}
section {
  background: var(--surface);
  padding: clamp(14px, 3vw, 32px);
  border: 1px solid var(--grid);
  border-radius: 12px;
  margin-bottom: 16px;
}
h2 {
  font-size: 1.18rem;
  margin: 0 0 1em;
}
h3 {
  font-size: 0.9rem;
  margin: 1.4em 0 0.4em;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(136px, 1fr));
  gap: 10px;
}
.tiles > div {
  border-top: 1px solid var(--grid);
  padding: 0.6em 0;
}
.tiles small {
  display: block;
}
.tiles strong {
  font-size: 1.65rem;
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  font-size: 0.82rem;
  margin-bottom: 16px;
}
.legend i {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  margin-right: 5px;
}
.graph {
  display: grid;
  grid-template-columns: fit-content(28%) minmax(0, 1fr);
  gap: 4px 8px;
  margin: 12px 6px 16px 0;
}
.plot {
  position: relative;
  border-block: 1px solid var(--grid);
  background: linear-gradient(var(--grid), var(--grid)) center/100% 1px
    no-repeat;
}
.ticks,
.axis {
  font-size: 0.74rem;
  display: flex;
  justify-content: space-between;
  font-variant-numeric: tabular-nums;
}
.ticks {
  flex-direction: column;
  align-items: end;
}
.bands {
  justify-content: space-around;
}
.axis {
  grid-column: 2;
  gap: 12px;
}
.axis span:last-child {
  text-align: right;
}
.mark {
  position: absolute;
  display: block;
  color: var(--fill);
  background: currentColor;
}
.dot {
  width: 10px;
  height: 10px;
  border: 2px solid var(--surface);
  border-radius: 100%;
  transform: translate(-50%, -50%);
}
.dot:after {
  content: "";
  position: absolute;
  inset: -7px;
}
.bar {
  height: 10px;
  border-right: 2px solid var(--surface);
  border-radius: 0 3px 3px 0;
  transform: translateY(-50%);
}
.column {
  max-width: 24px;
  transform: translateX(-50%);
  border-top: 2px solid var(--surface);
  border-radius: 3px 3px 0 0;
}
.rule {
  width: 100%;
  height: 0;
  background: none;
  border-top: 1px solid currentColor;
}
.rule.dashed {
  border-top-style: dashed;
}
.mark:focus-visible,
.mark:hover {
  outline: 1px solid var(--ink);
  z-index: 1;
}
.scroll {
  overflow: auto;
  max-width: 100%;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-variant-numeric: tabular-nums;
  text-align: left;
  font-size: 0.85rem;
}
td,
th {
  padding: 8px;
  border-bottom: 1px solid var(--grid);
}
th {
  color: var(--secondary);
  white-space: nowrap;
}
details {
  margin-top: 12px;
}
summary,
button,
[data-issue] {
  cursor: pointer;
}
button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 0;
  text-decoration: underline;
}
#tip {
  position: fixed;
  z-index: 5;
  background: var(--ink);
  color: var(--surface);
  padding: 5px 10px;
  border-radius: 5px;
  max-width: 90vw;
  font-size: 0.84rem;
  pointer-events: none;
}
`;

export const interactions = `
for (const plot of document.querySelectorAll("[data-marks]")) {
  for (const mark of JSON.parse(plot.dataset.marks)) {
    const el = document.createElement("span");
    el.className = "mark " + mark.shape + (mark.dashed ? " dashed" : "");
    el.tabIndex = 0;
    el.setAttribute("role", "img");
    el.setAttribute("aria-label", mark.label);
    el.style.setProperty("--fill", "var(--s" + mark.slot + ")");
    el.style.left = mark.x * 100 + "%";
    el.style.top = mark.y * 100 + "%";
    if (mark.w !== undefined) el.style.width = mark.w * 100 + "%";
    if (mark.h !== undefined) el.style.height = mark.h * 100 + "%";
    plot.append(el);
  }
}
const tip = document.getElementById("tip");
function show(event) {
  const el = event.target.closest(".mark");
  if (!el) {
    tip.hidden = true;
    return;
  }
  tip.textContent = el.getAttribute("aria-label");
  tip.hidden = false;
  const rect = el.getBoundingClientRect();
  tip.style.left =
    Math.max(
      4,
      Math.min(
        innerWidth - tip.offsetWidth - 4,
        (event.clientX ?? rect.left) + 8,
      ),
    ) + "px";
  tip.style.top =
    Math.max(
      4,
      Math.min(
        innerHeight - tip.offsetHeight - 4,
        (event.clientY ?? rect.top) + 12,
      ),
    ) + "px";
}
document.addEventListener("pointermove", show);
document.addEventListener("focusin", show);
for (const name of ["pointerout", "focusout", "scroll"])
  document.addEventListener(
    name,
    () => {
      tip.hidden = true;
    },
    true,
  );
document.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-issue]");
  if (!row) return;
  const button = row.querySelector("button");
  const detail = document.getElementById(button.getAttribute("aria-controls"));
  detail.hidden = !detail.hidden;
  button.setAttribute("aria-expanded", String(!detail.hidden));
});
`;
