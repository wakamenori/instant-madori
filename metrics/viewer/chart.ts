import type { ViewerData } from "./data.ts";
export const esc = (s: string | number) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
// Few's pitfall #3: precision beyond what the reader needs only slows reading.
export const fmt = (n: number | null, scale = 1) => {
  if (n === null) return "—";
  const v = n * scale;
  if (v !== 0 && Math.abs(v) < 0.01) return v > 0 ? "<0.01" : ">-0.01";
  const digits = Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0;
  return v.toLocaleString("ja-JP", { maximumFractionDigits: digits });
};
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
const shortFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export const shortDate = (unix: number) => shortFormat.format(unix * 1000);
export function table(headers: string[], rows: (string | number | null)[][], numeric = 0) {
  if (!rows.length) return '<p class="empty">該当する記録はありません</p>';
  const cell = (tag: string, c: string | number | null, i: number) =>
    `<${tag}${i >= headers.length - numeric ? ' class="num"' : ""}>${esc(c ?? "—")}</${tag}>`;
  return (
    '<div class="scroll"><table><thead><tr>' +
    headers.map((h, i) => cell("th", h, i)).join("") +
    "</tr></thead><tbody>" +
    rows.map((row) => "<tr>" + row.map((c, i) => cell("td", c, i)).join("") + "</tr>").join("") +
    "</tbody></table></div>"
  );
}

export type ChartRow = { position: number; end: number; values: (number | null)[] };
type Series = { label: string; color: string };
type Frame = {
  rows: ChartRow[];
  series: Series[];
  unit: string;
  breaks: ViewerData["breaks"];
  /** Extra table columns that describe each period, keyed by header. */
  context?: (row: ChartRow) => (string | number)[];
  contextHeaders?: string[];
};
const W = 1000,
  H = 100;
function frame(rows: ChartRow[]) {
  const end = rows.at(-1)?.position ?? 0;
  const x = (pos: number) => +((pos / end) * W).toFixed(2);
  return { end, x };
}
/** About three gridlines at 1, 2, 2.5 or 5 times a power of ten. */
function scale(max: number) {
  if (max <= 0) return { max: 1, step: 1 };
  const raw = max / 3,
    power = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= raw) ?? 10) * power;
  return { max: Math.ceil(max / step - 1e-9) * step, step };
}
/** Hover payload read by the page script; inserted with textContent there. */
function payload(f: Frame, end: number) {
  return esc(
    JSON.stringify({
      unit: f.unit,
      series: f.series,
      rows: f.rows.map((r, i) => ({
        a: (f.rows[i - 1]?.position ?? 0) / end,
        b: r.position / end,
        t: shortDate(r.end),
        v: r.values.map((v) => fmt(v)),
      })),
    }),
  );
}
function dataTable(f: Frame) {
  return table(
    ["時刻（JST）", ...f.series.map((s) => `${s.label}（${f.unit}）`), ...(f.contextHeaders ?? [])],
    f.rows.map((r) => [date(r.end), ...r.values.map((v) => fmt(v)), ...(f.context?.(r) ?? [])]),
    f.series.length + (f.contextHeaders?.length ?? 0),
  );
}
function breakMarks(f: Frame, x: (pos: number) => number) {
  return f.breaks.map((b) => `<path class="break" d="M${x(b.position)} 0V${H}"/>`).join("");
}
function hoverLayer(f: Frame, end: number) {
  return `<div class="probe" data-chart="${payload(f, end)}" tabindex="0" role="img" aria-label="ポインタか左右の矢印キーで、その時刻の値を一覧します"><i class="cross" hidden></i></div><div class="tip" role="status" hidden></div>`;
}
/** Small trend line with its uncertainty band. values = [value, low?, high?]. */
export function spark(f: Frame, height: number) {
  const { end, x } = frame(f.rows);
  if (!end) return '<p class="empty">稼働の記録はありません</p>';
  const { max } = scale(f.rows.reduce((m, r) => Math.max(m, ...r.values.map((v) => v ?? 0)), 0));
  const y = (v: number) => +(H - (H * v) / max).toFixed(2);
  const band: string[] = [],
    lower: string[] = [];
  let line = "";
  for (const [i, r] of f.rows.entries()) {
    const [v, lo, hi] = r.values;
    const left = x(f.rows[i - 1]?.position ?? 0),
      right = x(r.position);
    if (lo != null && hi != null) {
      band.push(`${left},${y(hi)} ${right},${y(hi)}`);
      lower.unshift(`${right},${y(lo)} ${left},${y(lo)}`);
    }
    if (v != null) line += `${line ? "L" : "M"}${left} ${y(v)}H${right}`;
  }
  const last = f.rows.at(-1)?.values[0];
  const dot =
    last == null ? "" : `<i class="dot" style="left:100%;top:${(100 * y(last)) / H}%"></i>`;
  return `<figure class="spark" style="--h:${height}px"><div class="plot"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${band.length ? `<polygon class="band" points="${band.join(" ")} ${lower.join(" ")}"/>` : ""}${breakMarks(f, x)}<path class="line" d="${line}"/></svg>${dot}${hoverLayer(f, end)}</div><div class="chart-table" hidden>${dataTable(f)}</div></figure>`;
}
/** Stacked columns over operating time; the first series sits on the baseline. */
export function stack(
  f: Frame,
  height: number,
  { cap, resumes = true }: { cap?: (row: ChartRow) => number | null; resumes?: boolean } = {},
) {
  const { end, x } = frame(f.rows);
  if (!end) return '<p class="empty">稼働の記録はありません</p>';
  // With a cap, the last series is the limit line rather than a stacked layer.
  const layers = f.series.slice(0, cap ? -1 : undefined);
  const { max, step: tick } = scale(
    f.rows.reduce(
      (m, r) =>
        Math.max(
          m,
          r.values.slice(0, layers.length).reduce<number>((s, v) => s + (v ?? 0), 0),
          cap?.(r) ?? 0,
        ),
      0,
    ),
  );
  const y = (v: number) => +(H - (H * v) / max).toFixed(2);
  const marks = f.rows
    .map((r, i) => {
      const left = x(f.rows[i - 1]?.position ?? 0),
        right = x(r.position);
      let total = 0;
      const bars = layers
        .map((s, j) => {
          const v = r.values[j] ?? 0;
          if (!v) return "";
          const bottom = y(total);
          total += v;
          return `<rect x="${left}" width="${right - left}" y="${y(total)}" height="${bottom - y(total)}" style="fill:var(--${s.color})"/>`;
        })
        .join("");
      const c = cap?.(r);
      return bars + (c == null ? "" : `<path class="cap" d="M${left} ${y(c)}H${right}"/>`);
    })
    .join("");
  const levels = Array.from({ length: Math.round(max / tick) }, (_, i) => (i + 1) * tick);
  const grid = levels.map((v) => `<path class="grid" d="M0 ${y(v)}H${W}"/>`).join("");
  const ticks = levels
    .map((v) => `<span style="top:${(100 * y(v)) / H}%">${fmt(v)}</span>`)
    .join("");
  const hours = end / 60;
  const step = hours > 16 ? 6 : hours > 8 ? 4 : 2;
  const axis = Array.from({ length: Math.floor(hours / step) + 1 }, (_, i) => i * step)
    .filter((h) => hours - h > step / 2 || h === 0)
    .map((h) => `<span style="left:${(100 * h) / hours}%">${h}</span>`)
    .join("");
  const resumeLabels = (resumes ? f.breaks : [])
    .map(
      (b) =>
        `<span class="resume${b.position / end > 0.6 ? " left" : ""}" style="left:${(100 * b.position) / end}%">${esc(shortDate(b.resume))} 再開</span>`,
    )
    .join("");
  return `<figure class="stack" style="--h:${height}px"><div class="plot"><div class="yaxis">${ticks}</div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">${grid}${marks}${breakMarks(f, x)}<path class="base" d="M0 ${H}H${W}"/></svg>${hoverLayer(f, end)}</div><div class="xaxis">${axis}<span class="end">${fmt(hours)} 稼働時間</span>${resumeLabels}</div><div class="chart-table" hidden>${dataTable(f)}</div></figure>`;
}
export function legend(series: Series[], values?: (string | null)[]) {
  return `<ul class="legend">${series
    .map(
      (s, i) =>
        `<li><i style="background:var(--${s.color})"></i>${esc(s.label)}${values?.[i] == null ? "" : ` <b>${esc(values[i] ?? "")}</b>`}</li>`,
    )
    .join("")}</ul>`;
}
