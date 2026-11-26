import assert from "node:assert/strict";
import { test } from "node:test";
import { elements, explanationBody, toolText } from "../../src/services/job-conversation.ts";

void test("element reads preserve raw house fields and boundary references", () => {
  const room = { id: "r", edges: [{ boundary: "b", direction: "forward" }] };
  const door = {
    id: "o",
    wall: "b",
    from: "end",
    distance: 500,
    fitting: { kind: "door", opens_to: "right", hinge: "end" },
  };
  const vertex = { id: "v", storey: "s", at: { x: 0, y: 0 } };
  const boundary = { id: "b", start: "v", end: "v2" };
  const data = JSON.stringify({
    version: 1,
    house: {
      rooms: [room],
      boundaries: [boundary],
      vertices: [vertex],
      openings: [door],
      storeys: [{ id: "s", height: 2800 }],
    },
  });
  assert.deepEqual(elements(data, ["b", "v", "o", "s", "missing"]), {
    elements: [
      { collection: "boundaries", value: boundary, rooms: [room], openings: [door] },
      { collection: "vertices", value: vertex },
      { collection: "openings", value: door },
      { collection: "storeys", value: { id: "s", height: 2800 } },
    ],
    unknown: ["missing"],
  });
});
void test("tool result truncation counts omitted entries and fits the byte budget", () => {
  const text = toolText(
    { housing: Array.from({ length: 400 }, () => ({ id: "壁".repeat(45) })) },
    1024,
  );
  assert(Buffer.byteLength(text) <= 1024);
  assert.match(text, /"omitted":396/u);
});
void test("the largest plan text fits one conversation message", () => {
  const item = "仮".repeat(200);
  const body = explanationBody({
    kind: "plan",
    name: "案",
    explanation: "説".repeat(1000),
    assumptions: Array<string>(5).fill(item),
    concerns: Array<string>(5).fill(item),
  });
  assert(Buffer.byteLength(body) <= 16384);
  assert.equal(body.split("・").length, 11);
  assert.equal(
    explanationBody({
      kind: "plan",
      name: "案",
      explanation: "説明",
      assumptions: [],
      concerns: [],
    }),
    "説明",
  );
});
