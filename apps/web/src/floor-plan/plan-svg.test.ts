import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseFloorPlan } from "./plan-svg.ts";
const svg = readFileSync(new URL("./verification-1.svg", import.meta.url), "utf8");
const storey = "a5e84c0db7:s1";
void test("writer output exposes only rooms and walls", () => {
  const plan = parseFloorPlan(svg, storey);
  assert.ok(plan);
  assert.equal(plan.storey, storey);
  assert.deepEqual(plan.viewBox, { x: -1400, y: -6400, width: 10800, height: 7800 });
  assert.deepEqual(
    [...plan.selectable].sort(),
    ["r1", "r2", "w1", "w2", "w3", "w4", "w5", "w6", "w7"].map((id) => "a5e84c0db7:" + id),
  );
  assert.equal(parseFloorPlan(svg, "other"), null);
  const empty = parseFloorPlan(
    readFileSync(new URL("./empty-storey.svg", import.meta.url), "utf8"),
    "2F_upper.x:-",
  );
  assert.equal(empty?.selectable.size, 0);
});
const inRooms = (payload: string) => {
  const i = svg.indexOf('<g class="rooms">') + '<g class="rooms">'.length;
  return svg.slice(0, i) + payload + svg.slice(i);
};
const cases: Record<string, string> = {
  depth: inRooms("<g>".repeat(32) + "</g>".repeat(32)),
  constructorAttribute: svg.replace("<rect ", '<rect constructor="x" '),
  toStringAttribute: svg.replace("<rect ", '<rect toString="x" '),
  protoAttribute: svg.replace("<rect ", '<rect __proto__="x" '),
  constructorEntity: svg.replace("居間", "&constructor;"),
  trailingScript: svg + "<script/>",
  script: inRooms("<script>alert(1)</script>"),
  "script uppercase": inRooms("<SCRIPT>alert(1)</SCRIPT>"),
  "script with xlink": inRooms('<script href="https://evil.example/x.js"/>'),
  foreignObject: inRooms("<foreignObject><div/></foreignObject>"),
  image: inRooms('<image href="https://evil.example/x.png"/>'),
  use: inRooms('<use href="https://evil.example/s.svg#a"/>'),
  anchor: inRooms('<a href="javascript:alert(1)"><text>x</text></a>'),
  style: inRooms("<style>@import url(https://evil.example/x.css)</style>"),
  animate: inRooms('<set attributeName="href" to="javascript:alert(1)"/>'),
  onload: svg.replace("<svg ", '<svg onload="alert(1)" '),
  "style attribute": svg.replace(
    '<rect class="background"',
    '<rect style="fill:url(https://evil.example/p)" class="background"',
  ),
  "fill url": svg.replace('fill="#ffffff"', 'fill="url(https://evil.example/p.svg#g)"'),
  "fill url entity-encoded": svg.replace(
    'fill="#ffffff"',
    'fill="url&#40;https://evil.example/p&#41;"',
  ),
  "href on allowed tag": svg.replace(
    '<rect class="background"',
    '<rect href="https://evil.example" class="background"',
  ),
  comment: inRooms("<!-- hi -->"),
  cdata: inRooms("<text><![CDATA[<script>alert(1)</script>]]></text>"),
  doctype: '<!DOCTYPE svg [<!ENTITY x SYSTEM "https://evil.example">]>' + svg,
  "processing instruction": '<?xml-stylesheet href="https://evil.example/x.css"?>' + svg,
  "numeric reference": svg.replace("居間", "&#x3c;script&#x3e;"),
  "unknown entity": svg.replace("居間", "&nbsp;"),
  "single-quoted attr": svg.replace('class="background"', "class='background'"),
  "unquoted attr": svg.replace('class="background"', "class=background"),
  "duplicate attr": svg.replace('class="background"', 'class="background" class="x"'),
  "mismatched close": svg.replace("</text>", "</tspan>"),
  "second root": svg + "<svg/>",
  "trailing text": svg + "x",
  "stray text outside text": inRooms("x"),
  "dimension group visible": svg.replace(' display="none"', ""),
  "dimension for unknown id": svg.replace(
    'data-dimensions-for="a5e84c0db7:r1"',
    'data-dimensions-for="ghost"',
  ),
  "wrong storey": svg.replace(`data-storey-id="${storey}"`, 'data-storey-id="other"'),
  "transform with url": svg.replace(
    'transform="rotate(0 4000,650)"',
    'transform="url(https://evil.example)"',
  ),
  "font-family with url": svg.replace(
    /font-family="[^"]*"/,
    'font-family="url(https://evil.example/f.woff)"',
  ),
};
for (const [name, mutation] of Object.entries(cases)) {
  void test("rejects " + name, () => {
    assert.notEqual(mutation, svg);
    assert.equal(parseFloorPlan(mutation, storey), null);
  });
}
