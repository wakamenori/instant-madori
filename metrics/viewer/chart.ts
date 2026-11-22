import type { Point, ViewerData } from "./data.ts";
export const esc = (s: string | number) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export const fmt = (n: number | null, scale = 1) =>
  n === null ? "—" : (n * scale).toLocaleString("ja-JP", { maximumFractionDigits: 2 });
const dateFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const date = (unix: number) => dateFormat.format(unix * 1000);
export function table(headers: string[], rows: (string | number | null)[][]) {
  if (!rows.length) return '<p class="empty">該当する記録はありません</p>';
  return (
    '<div class="scroll"><table><thead><tr>' +
    headers.map((h) => "<th>" + esc(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    rows
      .map((row) => "<tr>" + row.map((c) => "<td>" + esc(c ?? "—") + "</td>").join("") + "</tr>")
      .join("") +
    "</tbody></table></div>"
  );
}
type Sample = {
  value: number | null;
  low?: number | null;
  high?: number | null;
  dim?: boolean;
  n?: number;
  excluded?: number;
  uncounted?: number;
  observed?: number | undefined;
};
const palette = [
  "#14756e",
  "#bc6941",
  "#537ab5",
  "#8871ad",
  "#a28627",
  "#488650",
  "#ac547e",
  "#647889",
  "#387d97",
  "#936755",
  "#7d8543",
  "#96968e",
];
export function color(index: number) {
  return palette[index % palette.length] ?? "#808080";
}
type Endpoint = Pick<Point, "position" | "end" | "open_start" | "open_end">;
type Axis<P extends Endpoint = Point> = {
  points: P[];
  start?: number;
  end?: number;
  breaks: ViewerData["breaks"];
};
const width = 720,
  height = 94;
function plot(
  axis: Axis<Endpoint>,
  max: number,
  topLabel: string,
  draw: (x: (pos: number) => number, y: (v: number) => number) => string,
) {
  const end = axis.end ?? axis.points.at(-1)?.position ?? 0;
  if (!end) return '<p class="empty">稼働の記録はありません</p>';
  const x = (pos: number) => +((pos / end) * width).toFixed(2);
  const y = (v: number) => +(height - (height * v) / (max || 1)).toFixed(2);
  const breaks = axis.breaks
    .map(
      (b) =>
        `<path class="break" d="M${x(b.position)} 0v${height}"><title>${date(b.resume)} 再開</title></path>`,
    )
    .join("");
  const hours = end / 60;
  const tickStep = Math.max(1, Math.ceil(hours / 80));
  const labelStep = tickStep * Math.max(1, Math.ceil(hours / (6 * tickStep)));
  const tickMarks: string[] = [];
  const labels: string[] = [];
  for (let h = 0; h < hours; h += tickStep) {
    const tickX = x(h * 60);
    tickMarks.push(`<path stroke="#c2d0ca" d="M${tickX} ${height - 4}v4"/>`);
    if (h % labelStep === 0 && (h === 0 || hours - h > labelStep))
      labels.push(`<span style="left:${(100 * h) / hours}%">${h}</span>`);
  }
  return `<div class="graph"><small>${topLabel}</small><svg viewBox="-2 -2 724 100" preserveAspectRatio="none" aria-label="稼働時間ごとの推移"><svg x="0" y="0" width="${width}" height="${height}" overflow="hidden">${draw(x, y)}</svg>${breaks}${tickMarks.join("")}</svg><div class="axis">${labels.join("")}<span>${fmt(hours)} 稼働時間</span></div></div>`;
}
export function trend<P extends Endpoint>(
  axis: Axis<P>,
  title: string,
  unit: string,
  direction: string,
  sample: (p: P) => Sample,
  link = "",
  scale = 1,
) {
  const series = axis.points.map((p) => ({ p, ...sample(p) }));
  const max = unit === "%" ? 1 : series.reduce((m, s) => Math.max(m, s.value ?? 0), 0);
  const latest = series.at(-1);
  function reading(s: Sample) {
    const range =
      s.low != null || s.high != null
        ? `（${fmt(s.low ?? null, scale)}〜${fmt(s.high ?? null, scale)}）`
        : "";
    return `${fmt(s.value, scale)} ${unit}${range}${s.n === undefined ? "" : " · n=" + s.n}${s.observed === undefined ? "" : " · 観察完了 " + s.observed + "/" + s.n}`;
  }
  const graph = plot(
    axis,
    max,
    fmt(max, scale) + " " + unit,
    (x, y) =>
      series
        .map((s, i) => {
          const prev = series[i - 1],
            right = x(s.p.position),
            left = x(prev?.p.position ?? axis.start ?? 0);
          const band =
            s.low != null && s.high != null && prev?.low != null && prev.high != null
              ? `<polygon fill="#c7e4dd" points="${left},${y(prev.low)} ${right},${y(s.low)} ${right},${y(s.high)} ${left},${y(prev.high)}"/>`
              : "";
          const line =
            s.value === null
              ? ""
              : `<g opacity="${s.dim ? 0.4 : 1}">${prev?.value != null ? `<path stroke="#116960" stroke-width="2" d="M${left} ${y(prev.value)} L${right} ${y(s.value)}"/>` : ""}<circle cx="${right}" cy="${y(s.value)}" r="1.8" fill="#116960"/></g>`;
          return band + line;
        })
        .join("") +
      series
        .map((s, i) => {
          const left = x(series[i - 1]?.p.position ?? axis.start ?? 0);
          return `<rect x="${left}" width="${x(s.p.position) - left}" height="${height}" fill="transparent"><title>${date(s.p.end)} · ${reading(s)} · 境目の未完了 ${s.p.open_start} → ${s.p.open_end} 件${s.excluded === undefined ? "" : " · 分母から除外 " + s.excluded + " 件"}${s.uncounted ? " · 担当を通さず完了（数えない） " + s.uncounted + " 件" : ""}</title></rect>`;
        })
        .join(""),
  );
  return `<article><h3>${link ? `<a href="#${link}">${esc(title)} ↓</a>` : esc(title)}</h3><small>${direction}</small><div class="series">${graph}<strong>${latest ? reading(latest) : "—"}</strong></div></article>`;
}
type Layer = { name: string; value: number; color: string };
export function stacked(
  axis: Axis,
  title: string,
  unit: string,
  layers: (p: Point) => Layer[],
  limit?: (p: Point) => number | null,
) {
  const series = axis.points.map((p) => ({ layers: layers(p), cap: limit?.(p) }));
  const max = series.reduce(
    (m, row) =>
      Math.max(
        m,
        row.layers.reduce((s, r) => s + r.value, 0),
        row.cap ?? 0,
      ),
    0,
  );
  const graph = plot(axis, max, fmt(max) + " " + unit, (x, y) =>
    axis.points
      .map((p, i) => {
        const left = x(axis.points[i - 1]?.position ?? axis.start ?? 0),
          w = x(p.position) - left;
        let sum = 0;
        const bars =
          series[i]?.layers
            .map((r) => {
              const bottom = y(sum);
              sum += r.value;
              return r.value
                ? `<rect x="${left}" y="${y(sum)}" width="${w}" height="${bottom - y(sum)}" fill="${r.color}"><title>${date(p.end)} · ${esc(r.name)} ${fmt(r.value)} ${unit}</title></rect>`
                : "";
            })
            .join("") ?? "";
        const cap = limit?.(p);
        return bars + (cap != null ? `<path stroke="#273c41" d="M${left} ${y(cap)}h${w}"/>` : "");
      })
      .join(""),
  );
  const latest = new Map(series.at(-1)?.layers.map((r) => [r.name, r.value]));
  const legend = new Map(series.flatMap((row) => row.layers).map((r) => [r.name, r.color]));
  return `<article><h3>${esc(title)}</h3>${graph}<div class="legend">${Array.from(legend, ([name, c]) => `<span><i style="background:${c}"></i>${esc(name)} ${fmt(latest.get(name) ?? 0)} ${unit}</span>`).join("")}${limit ? " <span>━ 担当枠の上限</span>" : ""}</div></article>`;
}
