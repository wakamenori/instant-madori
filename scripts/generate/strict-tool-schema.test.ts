import assert from "node:assert/strict";
import { test } from "node:test";
import { strictToolSchemas } from "./strict-tool-schema.ts";

function tool(node: Record<string, unknown>) {
  return {
    name: "tool",
    input: { $schema: "2020-12", title: "Schema", description: "Root", ...node },
  };
}
function convert(node: Record<string, unknown>): unknown {
  const [result] = strictToolSchemas([tool(node)]);
  assert(result);
  assert.equal(result.description, "Root");
  return JSON.parse(result.inputSchemaJson);
}

void test("schema conversion orders properties and walks only schema positions", () => {
  assert.deepEqual(
    JSON.stringify(
      convert({
        type: "object",
        required: ["z", "a"],
        additionalProperties: false,
        properties: {
          a: { const: "x" },
          default: { enum: ["a", "b"] },
          z: { oneOf: [{ type: ["null", "string"] }], discriminator: { propertyName: "kind" } },
        },
      }),
    ),
    JSON.stringify({
      type: "object",
      required: ["z", "a"],
      additionalProperties: false,
      properties: {
        z: { anyOf: [{ type: ["null", "string"] }] },
        a: { const: "x" },
        default: { enum: ["a", "b"] },
      },
    }),
  );
});

void test("unsupported bounds become instructions and formats are limited", () => {
  for (const [keyword, value, sentence] of [
    ["minimum", 0, "Must be at least 0."],
    ["maximum", 255, "Must be at most 255."],
    ["exclusiveMinimum", 1, "Must exceed 1."],
    ["exclusiveMaximum", 2, "Must be less than 2."],
    ["multipleOf", 3, "Must be a multiple of 3."],
    ["minLength", 1, "Minimum character count: 1."],
    ["maxLength", 24, "At most 24 characters."],
    ["minItems", 2, "At least 2 items."],
    ["maxItems", 32, "At most 32 items."],
    ["pattern", "abc", "Must match the pattern abc."],
  ] as const)
    assert.deepEqual(convert({ items: { description: "Value.", [keyword]: value } }), {
      items: { description: `Value. ${sentence}` },
    });
  for (const minItems of [0, 1]) assert.deepEqual(convert({ minItems }), { minItems });
  for (const format of ["email", "uuid"]) assert.deepEqual(convert({ format }), { format });
  for (const format of ["double", "uint8"]) assert.deepEqual(convert({ format }), {});
});
void test("unsupported nested keywords and open objects identify their path", () => {
  for (const keyword of [
    "$ref",
    "$defs",
    "allOf",
    "not",
    "prefixItems",
    "default",
    "$schema",
    "title",
  ])
    assert.throws(
      () => convert({ items: { [keyword]: 1 } }),
      (error) => error instanceof Error && error.message.includes(`tool.items.${keyword}`),
    );
  for (const node of [
    { type: "object" },
    { properties: {} },
    { type: ["null", "object"] },
    { additionalProperties: true },
  ])
    assert.throws(() => convert(node), /additionalProperties/);
  for (const node of [{ type: "string" }, { properties: {}, additionalProperties: false }])
    assert.throws(() => convert({ ...node, oneOf: [] }), /oneOf/);
});
void test("the budget accumulates across tools", () => {
  assert.throws(() => strictToolSchemas(Array.from({ length: 21 }, () => tool({}))), /21 tools/);
  const props = (count: number) =>
    tool({
      properties: Object.fromEntries(
        Array.from({ length: count }, (_, i) => [i, { type: "boolean" }]),
      ),
      additionalProperties: false,
    });
  assert.throws(() => strictToolSchemas([props(12), props(13)]), /25 optional/);
  assert.throws(
    () => convert({ oneOf: Array.from({ length: 16 }, () => ({ type: ["null", "string"] })) }),
    /17 unions/,
  );
});
