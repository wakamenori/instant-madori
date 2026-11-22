type Cell = string | number | null;
const decimal = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 1 });
export const format = (n: number | null) => (n === null ? "未記録" : decimal.format(n));
export const esc = (v: string | number) =>
  String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
export function table(headers: string[], rows: Cell[][]) {
  return (
    '<div class="scroll"><table><thead><tr>' +
    headers.map((h) => "<th>" + esc(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (row) =>
          "<tr>" +
          row.map((v) => "<td>" + esc(typeof v === "string" ? v : format(v)) + "</td>").join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}
export type Mark = {
  shape: "dot" | "column" | "bar" | "rule";
  x: number;
  y: number;
  slot: number;
  label: string;
  w?: number;
  h?: number;
  dashed?: boolean;
};
type Chart = {
  marks: Mark[];
  series?: string[];
  labels?: string[];
  axis: string[];
  height?: number;
  top?: string;
  bottom?: string;
  note?: string;
  headers: string[];
  rows: Cell[][];
};
export function chart(c: Chart) {
  const legend = (c.series ?? [])
    .map((s, i) => '<span><i style="background:var(--s' + i + ')"></i>' + esc(s) + "</span>")
    .join("");
  const ticks = c.labels
    ? c.labels.map((s) => "<span>" + esc(s) + "</span>").join("")
    : "<span>" + esc(c.top ?? "") + "</span><span>" + esc(c.bottom ?? "") + "</span>";
  const axis = c.axis.map((s) => `<span>${esc(s)}</span>`).join("");
  const note = c.note ? `<small>${esc(c.note)}</small>` : "";
  return `<div class="legend">${legend}</div>
    <div class="graph">
      <div class="ticks ${c.labels ? "bands" : ""}">${ticks}</div>
      <div class="plot" style="height:${c.height ?? 160}px" data-marks="${esc(JSON.stringify(c.marks))}"></div>
      <div class="axis">${axis}</div>
    </div>
    ${note}<details><summary>表で見る</summary>${table(c.headers, c.rows)}</details>`;
}
