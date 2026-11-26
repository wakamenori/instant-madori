import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { repositoryRoot } from "../shared/repository.ts";
import {
  healthSchema,
  errorBodySchema,
  type Health,
} from "../../packages/contracts/src/generated/geometry-bodies.ts";
import { renderGeometrySchemas } from "./geometry-schema.ts";
void test("tracked zod bodies match the Rust JSON schemas", async () => {
  const directory = new URL("packages/contracts/src/generated/", repositoryRoot);
  const input: unknown = JSON.parse(
    await readFile(new URL("geometry-internal.schema.json", directory), "utf8"),
  );
  assert.equal(
    await readFile(new URL("geometry-bodies.ts", directory), "utf8"),
    renderGeometrySchemas(input),
  );
});

void test("generated body types keep Rust fields and reject out-of-range integers", () => {
  const health: Health = { status: "ok", service: "geometry", protocol: 1 };
  assert.deepEqual(healthSchema.parse(health), health);
  assert.equal(healthSchema.safeParse({ ...health, protocol: 4294967296 }).success, false);
  assert.equal(healthSchema.safeParse({ ...health, protocol: -1 }).success, false);
  assert.equal(healthSchema.safeParse({ ...health, protocol: 1.5 }).success, false);
  assert.equal(healthSchema.safeParse({ status: "ok", service: "geometry" }).success, false);
  assert.deepEqual(healthSchema.parse({ ...health, future: "additive" }), health);
  assert.equal(errorBodySchema.safeParse({ error: "unknown" }).success, false);
  // @ts-expect-error Unknown status must fail the generated type check.
  const bad: Health = { status: "wrong", service: "geometry", protocol: 1 };
  void bad;
});

void test("renderer rejects unsupported schemas instead of emitting any", () => {
  assert.throws(
    () =>
      renderGeometrySchemas({
        tupleSchema: {
          direction: "response",
          schema: { type: "array", prefixItems: [{ type: "string" }] },
        },
      }),
    /tupleSchema/,
  );
});

void test("Rust serialized optional responses are accepted by generated zod", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const { runInNewContext } = await import("node:vm");
  const { jsonSchemaToZod } = await import("json-schema-to-zod");
  const { z } = await import("zod");
  const output = execFileSync(
    "cargo",
    [
      "test",
      "--locked",
      "-q",
      "-p",
      "madori-geometry-api",
      "serialized_response_fixture",
      "--",
      "--nocapture",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const line = /WIRE_FIXTURE=(.+)/.exec(output)?.[1];
  assert(line);
  const fixture = z
    .object({ schema: z.record(z.string(), z.unknown()), value: z.unknown() })
    .parse(JSON.parse(line));
  const validator: unknown = runInNewContext(jsonSchemaToZod(fixture.schema), { z });
  assert(validator instanceof z.ZodType);
  assert.deepEqual(validator.parse(fixture.value), {});
  assert.match(
    renderGeometrySchemas({
      commandSchema: {
        direction: "request",
        schema: { type: "object", additionalProperties: false },
      },
    }),
    /z.input/,
  );
  await t.test("Worker decodes a Rust bundle with binary part bytes", async () => {
    const { acceptBundle } = await import("../../apps/worker/src/geometry/geometry-protocol.ts");
    const { applyOperationsOutcomeSchema, geometryInternal } =
      await import("../../packages/contracts/src/generated/geometry-internal.ts");
    const match = /BUNDLE_FIXTURE=([a-f0-9]+)$/m.exec(output);
    assert(match?.[1]);
    const frame = Uint8Array.from(Buffer.from(match[1], "hex"));
    const outcome = acceptBundle({
      schema: applyOperationsOutcomeSchema,
      maxBytes: geometryInternal.routes.applyOperations.response.max_bytes,
    }).decode(frame.buffer);
    assert.equal(outcome.kind, "applied");
    if (outcome.kind === "applied")
      assert.deepEqual(outcome.parts, [
        { artifact: { kind: "display" }, byte_length: 2, bytes: Uint8Array.of(0, 255) },
      ]);
  });
});
