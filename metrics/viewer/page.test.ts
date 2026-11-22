import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { stack } from "./chart.ts";
import { script } from "./page.ts";
import { renderDashboard } from "./render.ts";

// The repository has no DOM library; this covers exactly the DOM surface the page script touches.
type Box = { left: number; top: number; width: number; height: number };
type Listener = (event: object) => void;
class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  readonly classList: Set<string> & { add(c: string): void; remove(c: string): void };
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void };
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  hidden = false;
  id = "";
  offsetWidth = 120;
  offsetHeight = 60;
  box: Box = { left: 0, top: 0, width: 0, height: 0 };
  private text = "";
  readonly tag: string;
  constructor(tag: string, classes: string[] = []) {
    this.tag = tag;
    const set = new Set(classes) as FakeElement["classList"];
    set.remove = (c) => void set.delete(c);
    this.classList = set;
    const style = {} as FakeElement["style"];
    Object.defineProperty(style, "setProperty", {
      value: (k: string, v: string) => (style[k] = v),
    });
    this.style = style;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children.length = 0;
  }
  append(...nodes: FakeElement[]) {
    for (const node of nodes) {
      if (node.parentElement) {
        const siblings = node.parentElement.children;
        siblings.splice(siblings.indexOf(node), 1);
      }
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: FakeElement[]) {
    this.children.length = 0;
    this.text = "";
    this.append(...nodes);
  }
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  dispatch(type: string, event: object = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ target: this, ...event });
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getBoundingClientRect() {
    return this.box;
  }
  matches(selector: string): boolean {
    return selector.split(",").some((part) => {
      const tokens = part.trim().match(/[.#]?[\w-]+|\[[\w-]+\]/gu) ?? [];
      return tokens.every((t) =>
        t.startsWith(".")
          ? this.classList.has(t.slice(1))
          : t.startsWith("#")
            ? this.id === t.slice(1)
            : t.startsWith("[")
              ? t.slice(6, -1).replace(/-(\w)/gu, (_, c: string) => c.toUpperCase()) in this.dataset
              : this.tag === t,
      );
    });
  }
  closest(selector: string): FakeElement | null {
    return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null);
  }
  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap((c) => [
      ...(c.matches(selector) ? [c] : []),
      ...c.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
/** Builds the page skeleton from the rendered markup, so the value lists sit where the page puts them. */
function page() {
  const body = new FakeElement("body");
  const dialog = new FakeElement("dialog");
  const form = Object.assign(new FakeElement("form", ["filters"]), {
    elements: { target: { value: "全種類" }, span: { value: "8" } },
  });
  body.append(form, dialog);
  const html = renderDashboard({
    generatedAt: null,
    timelines: {},
    quality: [],
    breaks: [],
    combos: [],
    effects: [],
    prevention: [],
    health: [],
    gaps: [],
    verification: [],
    inactive: [],
  });
  const [opened, closed] = [html.indexOf("<dialog"), html.indexOf("</dialog>")];
  for (const m of html.matchAll(/<div([^>]*) id="([^"]+)" role="status"/gu)) {
    const tip = new FakeElement("div", /class="([^"]+)"/u.exec(m[1] ?? "")?.[1]?.split(" ") ?? []);
    tip.id = m[2] ?? "";
    tip.hidden = true;
    (m.index > opened && m.index < closed ? dialog : body).append(tip);
  }
  const listeners = new Map<string, Listener[]>();
  const document = {
    body,
    querySelector: (s: string) => body.querySelector(s),
    querySelectorAll: (s: string) => body.querySelectorAll(s),
    createElement: (tag: string) => new FakeElement(tag),
    addEventListener: (type: string, fn: Listener) =>
      listeners.set(type, [...(listeners.get(type) ?? []), fn]),
  };
  runInNewContext(script, { document, innerWidth: 1280, innerHeight: 800 });
  const fire = (type: string, event: object) => {
    for (const fn of listeners.get(type) ?? []) fn({ preventDefault() {}, ...event });
  };
  /** The one value list on screen; it must not sit inside a closed dialog. */
  const shown = () => {
    const tips = body.querySelectorAll("div").filter((d) => /tip/u.test(d.id) && !d.hidden);
    assert.equal(tips.length, 1, "exactly one value list is visible");
    return tips[0] as FakeElement;
  };
  const anyShown = () => body.querySelectorAll("div").some((d) => /tip/u.test(d.id) && !d.hidden);
  return { body, dialog, form, fire, shown, anyShown };
}
const lines = (tip: FakeElement) => tip.children.map((c) => c.textContent);

function chartLayer() {
  const html = stack(
    {
      rows: [
        { position: 60, end: 1_795_000_000, values: [0.1, 0.5] },
        { position: 120, end: 1_795_003_600, values: [0.2, 0.7] },
        { position: 180, end: 1_795_007_200, values: [0.3, 0.9] },
      ],
      series: [
        { label: "待ち", color: "wait" },
        { label: "作業", color: "work" },
      ],
      unit: "h/件",
      breaks: [],
    },
    120,
  );
  const chart = /data-chart="([^"]+)"/u.exec(html)?.[1] ?? "";
  const layer = new FakeElement("div", ["probe"]);
  layer.dataset.chart = chart
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  layer.box = { left: 100, top: 200, width: 300, height: 120 };
  const cross = new FakeElement("i", ["cross"]);
  cross.hidden = true;
  layer.append(cross);
  const { host, swap, plot, table } = chartFrame("article", layer);
  return { layer, cross, host, swap, plot, table };
}
/** The markup around a chart that the 表で見る button switches: host > [button, figure > [.plot, .chart-table]]. */
function chartFrame(hostTag: "article" | "div", ...content: FakeElement[]) {
  const host = new FakeElement(hostTag, hostTag === "div" ? ["chart"] : []);
  const swap = new FakeElement("button", ["swap"]);
  const figure = new FakeElement("figure");
  const plot = new FakeElement("div", ["plot"]);
  const table = new FakeElement("div", ["chart-table"]);
  table.hidden = true;
  plot.append(...content);
  figure.append(plot, table);
  host.append(swap, figure);
  return { host, swap, figure, plot, table };
}

void test("pointing at a time chart lists every series at that period and marks it", () => {
  const { body, fire, shown, anyShown } = page();
  const chart = chartLayer();
  const { layer, cross } = chart;
  body.append(chart.host);
  fire("pointermove", { target: layer, clientX: 100 + 300 * 0.5, clientY: 220 });
  assert.equal(cross.hidden, false);
  assert.equal(cross.style.left, "50%");
  const list = lines(shown());
  assert.match(list[0] ?? "", /JST まで$/u);
  assert.deepEqual(list.slice(1), ["0.7 h/件作業", "0.2 h/件待ち"]);
  fire("pointermove", { target: body, clientX: 10, clientY: 10 });
  assert.equal(anyShown(), false);
});

void test("arrow keys step through periods from the latest and Escape hides the list", () => {
  const { body, fire, shown, anyShown } = page();
  const chart = chartLayer();
  const { layer } = chart;
  body.append(chart.host);
  fire("focusin", { target: layer });
  assert.deepEqual(lines(shown()).slice(1), ["0.9 h/件作業", "0.3 h/件待ち"]);
  fire("keydown", { target: layer, key: "ArrowLeft" });
  fire("keydown", { target: layer, key: "ArrowLeft" });
  assert.deepEqual(lines(shown()).slice(1), ["0.5 h/件作業", "0.1 h/件待ち"]);
  fire("keydown", { target: layer, key: "Escape" });
  assert.equal(anyShown(), false);
});

function timelineIn(dialog: FakeElement) {
  const lane = (name: string, start: number, end: number) => {
    const row = new FakeElement("div", ["lane"]);
    const label = new FakeElement("b");
    label.textContent = name;
    const track = new FakeElement("div", ["track"]);
    track.box = { left: 100, top: 300, width: 400, height: 10 };
    const mark = new FakeElement("i");
    mark.dataset.start = String(Date.UTC(2026, 10, 23, start));
    mark.dataset.end = String(Date.UTC(2026, 10, 23, end));
    track.append(mark);
    row.append(label, track);
    return row;
  };
  const { host, swap, figure } = chartFrame("div", lane("作業", 0, 1), lane("待ち", 1, 2));
  figure.classList.add("lanes");
  figure.dataset.start = String(Date.UTC(2026, 10, 23, 0));
  figure.dataset.end = String(Date.UTC(2026, 10, 23, 2));
  dialog.append(host);
  const track = figure.querySelector(".track");
  assert.ok(track);
  return { lanes: figure, track, swap };
}

void test("moving across an issue timeline keeps updating the time without touching chart probes", () => {
  const { dialog, fire, shown } = page();
  const { lanes, track } = timelineIn(dialog);
  fire("pointermove", { target: track, clientX: 100 + 400 * 0.25, clientY: 305 });
  const first = lines(shown());
  assert.equal(lanes.closest(".probe[data-chart]"), null);
  fire("pointermove", { target: track, clientX: 100 + 400 * 0.75, clientY: 305 });
  const second = lines(shown());
  assert.notEqual(second[0], first[0]);
  assert.deepEqual([first.slice(1), second.slice(1)], [["作業"], ["待ち"]]);
  assert.equal(lanes.style["--cursor"], "75%");
});

void test("after an issue timeline closes with Escape, a chart behind it shows its list outside the dialog", () => {
  const { body, dialog, fire, shown, anyShown } = page();
  const { track } = timelineIn(dialog);
  fire("pointermove", { target: track, clientX: 200, clientY: 305 });
  assert.notEqual(shown().closest("dialog"), null);
  fire("keydown", { target: track, key: "Escape" });
  dialog.hidden = true;
  assert.equal(anyShown(), false);
  const chart = chartLayer();
  const { layer } = chart;
  body.append(chart.host);
  fire("pointermove", { target: layer, clientX: 101, clientY: 220 });
  const list = shown();
  assert.equal(list.closest("dialog"), null, "the list is not left inside the closed dialog");
  assert.deepEqual(lines(list).slice(1), ["0.5 h/件作業", "0.1 h/件待ち"]);
});

void test("every view change hides the value lists: table switch, filters and closing the timeline", () => {
  const { body, dialog, form, fire, shown, anyShown } = page();
  const chart = chartLayer();
  body.append(chart.host);
  const point = () => {
    fire("pointermove", { target: chart.layer, clientX: 250, clientY: 220 });
    assert.ok(shown());
  };
  point();
  fire("click", { target: chart.swap });
  assert.equal(anyShown(), false, "switching the chart to its table hides the list");
  assert.deepEqual([chart.plot.hidden, chart.table.hidden], [true, false]);
  fire("click", { target: chart.swap });
  point();
  form.dispatch("change");
  assert.equal(anyShown(), false, "changing the target or span hides the list");

  const timeline = timelineIn(dialog);
  fire("pointermove", { target: timeline.track, clientX: 200, clientY: 305 });
  assert.ok(shown());
  fire("click", { target: timeline.swap });
  assert.equal(anyShown(), false, "switching the timeline to its table hides the list");
  fire("click", { target: timeline.swap });
  fire("pointermove", { target: timeline.track, clientX: 200, clientY: 305 });
  assert.ok(shown());
  dialog.dispatch("close");
  assert.equal(anyShown(), false, "closing the timeline hides the list");
});
