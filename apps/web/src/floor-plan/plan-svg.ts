import { elementIdSchema } from "@madori/contracts";
type Grammar = (value: string) => boolean;
const matches =
  (pattern: RegExp): Grammar =>
  (value) =>
    pattern.test(value);
const num = String.raw`-?\d+(?:\.\d+)?`;
const numberValue = matches(new RegExp(`^${num}$`));
const paint = matches(/^(?:#[0-9a-f]{6}|none)$/);
const elementId: Grammar = (value) => elementIdSchema.safeParse(value).success;

const attributes = new Map<string, { prop: string | null; value: Grammar }>(
  Object.entries({
    xmlns: { prop: null, value: matches(/^http:\/\/www\.w3\.org\/2000\/svg$/) },
    viewBox: { prop: "viewBox", value: matches(new RegExp(`^${num} ${num} ${num} ${num}$`)) },
    "data-storey-id": { prop: "data-storey-id", value: elementId },
    class: { prop: "className", value: matches(/^[a-z-]+$/) },
    "font-family": { prop: "fontFamily", value: matches(/^[A-Za-z ',-]+$/) },
    "data-element-id": { prop: "data-element-id", value: elementId },
    "data-kind": { prop: "data-kind", value: matches(/^[a-z]+$/) },
    "data-dimensions-for": { prop: "data-dimensions-for", value: elementId },
    "data-length": { prop: "data-length", value: numberValue },
    "data-orientation": { prop: "data-orientation", value: matches(/^provisional$/) },
    display: { prop: "display", value: matches(/^none$/) },
    fill: { prop: "fill", value: paint },
    stroke: { prop: "stroke", value: paint },
    "stroke-width": { prop: "strokeWidth", value: numberValue },
    "paint-order": { prop: "paintOrder", value: matches(/^stroke fill$/) },
    "stroke-dasharray": {
      prop: "strokeDasharray",
      value: matches(new RegExp(`^${num}(?: ${num})*$`)),
    },
    "font-size": { prop: "fontSize", value: numberValue },
    "text-anchor": { prop: "textAnchor", value: matches(/^(?:start|middle|end)$/) },
    "font-weight": { prop: "fontWeight", value: matches(/^\d{3}$/) },
    x: { prop: "x", value: numberValue },
    y: { prop: "y", value: numberValue },
    x1: { prop: "x1", value: numberValue },
    y1: { prop: "y1", value: numberValue },
    x2: { prop: "x2", value: numberValue },
    y2: { prop: "y2", value: numberValue },
    width: { prop: "width", value: numberValue },
    height: { prop: "height", value: numberValue },
    points: { prop: "points", value: matches(new RegExp(`^${num},${num}(?: ${num},${num})*$`)) },
    d: { prop: "d", value: matches(/^[MLAZ0-9., -]+$/) },
    transform: {
      prop: "transform",
      value: matches(new RegExp(`^rotate\\(${num} ${num},${num}\\)$`)),
    },
  }),
);
const tags = new Set(["svg", "rect", "g", "path", "line", "polygon", "text", "tspan"]);
const textTags = new Set(["text", "tspan"]);
const entities = new Map(Object.entries({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }));

export type ElementId = string & { readonly __elementId: unique symbol };
export type ViewBox = { x: number; y: number; width: number; height: number };
export type PlanNode = {
  readonly tag: string;
  readonly props: Readonly<Record<string, string>>;
  readonly element: ElementId | null;
  readonly dimensionsFor: ElementId | null;
  readonly children: readonly (PlanNode | string)[];
};
const validatedPlan = Symbol("FloorPlan");
export type FloorPlan = {
  readonly [validatedPlan]: true;
  readonly storey: string;
  readonly viewBox: ViewBox;
  readonly root: PlanNode;
  readonly selectable: ReadonlySet<ElementId>;
};
type Node = PlanNode & { children: (PlanNode | string)[] };

function decode(raw: string): string | null {
  let bad = false;
  const out = raw.replace(/&([a-z]*);?/g, (all: string, name: string) => {
    const value = all.endsWith(";") ? entities.get(name) : undefined;
    if (value === undefined) bad = true;
    return value ?? "";
  });
  return bad ? null : out;
}

export function parseFloorPlan(text: string, storey: string): FloorPlan | null {
  const openTag = /<([a-z][A-Za-z]*)/y;
  const attr = / ([A-Za-z][A-Za-z0-9-]*)="([^"<>]*)"/y;
  const tagEnd = /\/?>/y;
  const closeTag = /<\/([a-z][A-Za-z]*)>/y;
  const chars = /[^<]+/y;
  const stack: Node[] = [];
  let root: Node | null = null;
  const ids = new Set<string>();
  const selectable = new Set<ElementId>();
  let at = 0;
  const match = (re: RegExp) => {
    re.lastIndex = at;
    const m = re.exec(text);
    if (m) at = re.lastIndex;
    return m;
  };
  while (at < text.length) {
    const parent = stack.at(-1);
    let m: RegExpExecArray | null;
    if ((m = match(openTag))) {
      const tag = m[1];
      if (
        !tag ||
        !tags.has(tag) ||
        (tag === "svg") !== !parent ||
        (root && !parent) ||
        stack.length >= 32
      )
        return null;
      const props: Record<string, string> = {};
      const seen = new Set<string>();
      while ((m = match(attr))) {
        const [, name, raw] = m;
        if (!name || raw === undefined) return null;
        const rule = attributes.get(name);
        const value = decode(raw);
        if (!rule || value === null || !rule.value(value) || seen.has(name)) return null;
        seen.add(name);
        if (name === "xmlns" && tag !== "svg") return null;
        if (rule.prop) props[rule.prop] = value;
      }
      const end = match(tagEnd);
      if (!end) return null;
      const element = (props["data-element-id"] as ElementId | undefined) ?? null;
      const dimensionsFor = (props["data-dimensions-for"] as ElementId | undefined) ?? null;
      if (element) ids.add(element);
      if ((tag === "g" && props.className === "dimensions") !== (dimensionsFor !== null))
        return null;
      if (dimensionsFor) {
        if (props.display !== "none") return null;
        delete props.display;
        selectable.add(dimensionsFor);
      }
      const node: Node = { tag, props, element, dimensionsFor, children: [] };
      if (parent) parent.children.push(node);
      else root = node;
      if (end[0] === ">") stack.push(node);
    } else if ((m = match(closeTag))) {
      if (stack.pop()?.tag !== m[1]) return null;
    } else if ((m = match(chars))) {
      const value = decode(m[0]);
      if (value === null) return null;
      if (parent && textTags.has(parent.tag)) parent.children.push(value);
      else if (value.trim() !== "") return null;
    } else return null;
  }
  if (!root || stack.length || root.tag !== "svg") return null;
  if (root.props["data-storey-id"] !== storey || root.props.className !== "floor-plan") return null;
  const box = root.props.viewBox?.split(" ").map(Number);
  if (!box || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const [x, y, width, height] = box;
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    width <= 0 ||
    height <= 0
  )
    return null;
  for (const target of selectable) if (!ids.has(target)) return null;
  return { [validatedPlan]: true, root, storey, viewBox: { x, y, width, height }, selectable };
}

export function selectableAt(plan: FloorPlan, raw: string | null): ElementId | null {
  const id = raw as ElementId | null;
  return id && plan.selectable.has(id) ? id : null;
}
