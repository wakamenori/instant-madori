import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { aiTools, parseToolCall } from "@madori/contracts/ai-tools";
import { applyOperationsRequestSchema } from "@madori/contracts/geometry-internal";
import type { ToolSpec } from "../src/ai/round-trip.ts";
import { limits } from "../src/limits.ts";

void test("provider tool bytes meet strict schema constraints and preserve field order", () => {
  const tools: readonly ToolSpec[] = aiTools;
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["edit_house", "read_house", "finish"],
  );
  const blocked = new Set([
    "oneOf",
    "not",
    "allOf",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "maxItems",
    "discriminator",
    "$ref",
    "$defs",
    "$schema",
    "pattern",
    "default",
  ]);
  const formats = [
    "date-time",
    "time",
    "date",
    "duration",
    "email",
    "hostname",
    "uri",
    "ipv4",
    "ipv6",
    "uuid",
  ];
  const object = z.record(z.string(), z.unknown());
  let optional = 0,
    unions = 0;
  const nodes = new Map<string, Record<string, unknown>>();
  function visit(value: unknown, path: string) {
    const node = object.parse(value);
    nodes.set(path, node);
    for (const key of Object.keys(node)) assert(!blocked.has(key), `${path}.${key}`);
    if (node.format !== undefined) assert(formats.includes(z.string().parse(node.format)));
    if (node.minItems !== undefined) assert([0, 1].includes(z.number().parse(node.minItems)));
    const types = Array.isArray(node.type) ? z.array(z.string()).parse(node.type) : [node.type];
    if (Array.isArray(node.type)) unions++;
    if (types.includes("object") || node.properties !== undefined)
      assert.equal(node.additionalProperties, false);
    if (node.properties !== undefined) {
      const required = z.array(z.string()).parse(node.required ?? []);
      for (const [key, child] of Object.entries(object.parse(node.properties))) {
        if (!required.includes(key)) optional++;
        visit(child, `${path}.${key}`);
      }
    }
    if (node.items !== undefined) visit(node.items, `${path}[]`);
    if (node.anyOf !== undefined) {
      assert(!("type" in node || "properties" in node));
      unions++;
      for (const branch of z.array(object).parse(node.anyOf)) {
        const props = object.parse(branch.properties);
        const tag = z.object({ const: z.string() }).parse(props.kind).const;
        visit(branch, `${path}[${tag}]`);
      }
    }
  }
  for (const tool of tools) visit(JSON.parse(tool.inputSchemaJson), tool.name);
  assert(tools.length <= 20 && optional <= 24 && unions <= 16);
  assert.deepEqual([optional, unions], [0, 8]);
  const red = nodes.get("edit_house.operations[][set_wall_color].wall_color.color.r");
  assert(red && red.type === "integer" && !("maximum" in red));
  assert.deepEqual(Object.keys(object.parse(nodes.get("finish.answer[question]")?.properties)), [
    "kind",
    "question",
    "choices",
  ]);
});

function place(name: string) {
  return {
    kind: "place_rooms",
    layout: {
      rooms: [{ name, usage: "ldk", min: { x: 0, y: 0 }, max: { x: 4000, y: 5000 } }],
      walls: { exterior_thickness: 200, interior_thickness: 120, height: 2400 },
    },
  };
}
function paint(red: number) {
  return {
    kind: "set_wall_color",
    wall_color: { wall: "wall1", face: { kind: "exterior" }, color: { r: red, g: 0, b: 255 } },
  };
}
function edit(operations: unknown[]) {
  return parseToolCall("edit_house", JSON.stringify({ operations }));
}
void test("the generated edit_house schema and its description match the Worker limit", () => {
  const { maxOperations } = limits.editHouse;
  const operation = { kind: "remove_opening", id: "o" };
  const operations = Array.from({ length: maxOperations }, () => operation);
  assert(edit(operations).ok);
  const overCap = edit([...operations, operation]);
  assert(!overCap.ok, "edit_house must reject one operation above the Worker limit");
  assert.match(overCap.error, /operations/u);
  const tool = aiTools.find(({ name }) => name === "edit_house");
  assert(tool?.inputSchemaJson.includes(`At most ${maxOperations} items.`));
});
void test("edit inputs are bounded before a Container request is built", () => {
  for (const operations of [
    [paint(256)],
    [paint(-1)],
    [],
    [place("室".repeat(25))],
    [place("\ud800")],
  ])
    assert.equal(edit(operations).ok, false);
  const result = edit([place("𠮷".repeat(24)), paint(255)]);
  assert(result.ok && result.call.name === "edit_house");
  assert(
    applyOperationsRequestSchema.safeParse({
      job_id: "job",
      operation_id: "op",
      generation: 1,
      snapshot: { kind: "empty" },
      operations: result.call.input.operations,
    }).success,
  );
});
void test("invalid envelopes and invisible or control-containing plan names are rejected", () => {
  for (const input of ["{", "null", "false", "[]", '"text"'])
    assert.equal(parseToolCall("finish", input).ok, false);
  assert.equal(parseToolCall("unknown", "{}").ok, false);
  for (const name of ["\u200b", "部\u0007屋"]) {
    const result = parseToolCall(
      "finish",
      JSON.stringify({
        answer: { kind: "plan", name, explanation: "変更点", assumptions: [], concerns: [] },
      }),
    );
    assert(!result.ok);
    assert.match(result.error, /answer.name:/);
  }
  assert(parseToolCall("read_house", '{"query":{"kind":"inspection"}}').ok);
  assert(
    parseToolCall(
      "finish",
      '{"answer":{"kind":"question","question":"広さは？","choices":["大","小"]}}',
    ).ok,
  );
});
