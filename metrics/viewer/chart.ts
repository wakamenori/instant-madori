import type { ViewerData } from "./data.ts";
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

type ChartRow = {
  position: number;
  end: number;
  values: (number | null)[];
  unit: string;
  context: string;
};
type Chart = {
  labels: string[];
  colors: string[];
  rows: ChartRow[];
  breaks: ViewerData["breaks"];
  mode: "trend" | "stack";
  capacity?: boolean;
};
export function graph({ labels, colors, rows, breaks, mode, capacity }: Chart) {
  const end = rows.at(-1)?.position;
  if (!end) return '<p class="empty">稼働の記録はありません</p>';
  const maxima = new Map<string, number>();
  for (const row of rows) {
    const values = row.values.map((v) => v ?? 0);
    const stack = mode === "stack" ? values.slice(0, colors.length).reduce((a, b) => a + b, 0) : 0;
    maxima.set(
      row.unit,
      row.unit === "%" ? 100 : Math.max(maxima.get(row.unit) ?? 0, stack, ...values),
    );
  }
  const x = (pos: number) => (pos / end) * 1000;
  const shapes = rows
    .map((row, i) => {
      const prev = rows[i - 1],
        left = x(prev?.position ?? 0),
        right = x(row.position);
      const y = (v: number) => 100 - (100 * v) / (maxima.get(row.unit) || 1);
      if (mode === "trend") {
        const [v, lo, hi] = row.values,
          [pv, pl, ph] = prev?.values ?? [];
        const band =
          lo != null && hi != null && pl != null && ph != null
            ? `<polygon class="band" points="${left},${y(pl)} ${right},${y(lo)} ${right},${y(hi)} ${left},${y(ph)}"/>`
            : "";
        return (
          band +
          (v == null
            ? ""
            : `<path class="line" d="M${pv == null ? right - 1 : left} ${y(pv ?? v)} L${right} ${y(v)}"/>`)
        );
      }
      let total = 0;
      const bars = colors
        .map((color, j) => {
          const bottom = y(total);
          total += row.values[j] ?? 0;
          return (
            `<rect x="${left}" width="${right - left}" y="${y(total)}" height="${bottom - y(total)}" fill="var(--${color})"/>` +
            (bottom > y(total) && total !== (row.values[j] ?? 0)
              ? `<path class="gap" d="M${left} ${bottom}H${right}"/>`
              : "")
          );
        })
        .join("");
      const cap = capacity ? row.values.at(-1) : null;
      return bars + (cap == null ? "" : `<path class="line" d="M${left} ${y(cap)}H${right}"/>`);
    })
    .join("");
  const readings = rows.map((r) => r.values.map((v) => fmt(v) + " " + r.unit));
  const targets = rows
    .map((r, i) => {
      const left = x(rows[i - 1]?.position ?? 0);
      const values = labels.map((name, j) => name + " " + readings[i]?.[j]).join("\n");
      return `<rect x="${left}" width="${x(r.position) - left}" height="100" fill="transparent" data-tip="${esc(date(r.end) + " JST\n" + values + "\n" + r.context)}"/>`;
    })
    .join("");
  const axes = Array.from(maxima, ([u, max]) => fmt(max) + " " + u).join(" / ");
  const step = Math.max(60, Math.ceil(end / 600) * 60);
  const ticks = Array.from(
    { length: Math.floor(end / step) },
    (_, i) => `<path class="tick" d="M${x((i + 1) * step)} 96v4"/>`,
  ).join("");
  return `<div class="chart"><span class="ceiling">${axes}</span><button type="button" class="swap" aria-expanded="false">表で見る</button><div class="plot"><svg viewBox="0 -2 1000 104" preserveAspectRatio="none" aria-label="稼働時間ごとの推移">${shapes}${ticks}${targets}${breaks.map((b) => `<path class="break" d="M${x(b.position)} 0v100" data-tip="${date(b.resume)} JST 再開"/>`).join("")}<line class="cross" y1="0" y2="100" hidden/></svg><small>0 <span>${fmt(end / 60)} 稼働時間</span></small></div><div class="chart-table" hidden>${table(
    ["時刻（JST）", ...labels, "期間"],
    rows.map((r, i) => [date(r.end), ...(readings[i] ?? []), r.context]),
  )}</div></div>`;
}
