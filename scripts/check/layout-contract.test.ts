import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { test } from "node:test";
import {
  assertStagingBindings,
  assertContainerE2eFiles,
  upstreamFilePath,
} from "./layout-contract.ts";
const bindings = {
  durable_objects: { bindings: [{ name: "GEOMETRY", class_name: "GeometryContainer" }] },
  containers: [{ class_name: "GeometryContainer" }],
  exports: { GeometryContainer: {} },
  r2_buckets: [{ binding: "BLOBS" }],
  d1_databases: [
    { binding: "DB", database_name: "test", database_id: "test-id", migrations_dir: "migrations" },
  ],
  vars: { A: "a" },
};
void test("staging requires the same binding names in every category", () => {
  assert.doesNotThrow(() =>
    assertStagingBindings({ ...bindings, env: { staging: structuredClone(bindings) } }),
  );
  for (const key of Object.keys(bindings)) {
    const top = structuredClone(bindings);
    Reflect.set(
      top,
      key,
      key === "vars" || key === "exports"
        ? { ADDED: {} }
        : key === "durable_objects"
          ? { bindings: [] }
          : [],
    );
    assert.throws(() => assertStagingBindings({ ...top, env: { staging: bindings } }), /staging/);
  }
});
void test("container e2e cases must share the supported Docker boot file", () => {
  assert.doesNotThrow(() => assertContainerE2eFiles(["apps/worker/tests/container.e2e.ts"]));
  assert.throws(
    () =>
      assertContainerE2eFiles([
        "apps/worker/tests/container.e2e.ts",
        "apps/worker/tests/lost.e2e.ts",
      ]),
    /container.e2e.ts/,
  );
  assert.throws(() => assertContainerE2eFiles([]), /container.e2e.ts/);
});

void test("new top-level binding categories require an explicit checker policy", () => {
  for (const key of ["workflows", "kv_namespaces", "services", "future_binding"]) {
    assert.throws(
      () => assertStagingBindings({ ...bindings, [key]: [], env: { staging: bindings } }),
      /Unrecognized|unrecognized/,
    );
  }
});

void test("staging-only binding categories require an explicit checker policy", () => {
  for (const key of ["workflows", "kv_namespaces", "services", "future_binding"]) {
    assert.throws(
      () => assertStagingBindings({ ...bindings, env: { staging: { ...bindings, [key]: [] } } }),
      /Unrecognized|unrecognized/,
    );
  }
});

for (const name of ["a#b.txt", "a?b.txt", "a%20b.txt", "a#b?c%20.txt"]) {
  void test(`upstream filesystem name retains ${name}`, () => {
    assert.equal(
      upstreamFilePath(
        new URL("file:///tmp/checkout%20%E6%97%A5%E6%9C%AC%20%23%25/"),
        `assets/${name}`,
      ),
      `/tmp/checkout 日本 #%/third_party/solidcraft/assets/${name}`,
    );
  });
}

void test("staging inherits scheduled triggers", () => {
  assert.doesNotThrow(() =>
    assertStagingBindings({
      ...bindings,
      triggers: { crons: ["*/5 * * * *"] },
      env: { staging: bindings },
    }),
  );
});

void test("only the top level declares secrets", () => {
  const secrets = { required: ["ACCESS_JWKS"] };
  assert.doesNotThrow(() =>
    assertStagingBindings({ ...bindings, secrets, env: { staging: bindings } }),
  );
  assert.throws(
    () => assertStagingBindings({ ...bindings, env: { staging: { ...bindings, secrets } } }),
    /Unrecognized|unrecognized/,
  );
});

void test("Workflow exports pass when repeated in staging and fail when omitted there", () => {
  const withWorkflow = {
    ...bindings,
    exports: { ...bindings.exports, JobWorkflow: { type: "workflow", name: "instant-madori-job" } },
  };
  assert.doesNotThrow(() =>
    assertStagingBindings({
      ...withWorkflow,
      env: {
        staging: {
          ...withWorkflow,
          exports: {
            ...withWorkflow.exports,
            JobWorkflow: { type: "workflow", name: "instant-madori-staging-job" },
          },
        },
      },
    }),
  );
  assert.throws(
    () => assertStagingBindings({ ...withWorkflow, env: { staging: bindings } }),
    /staging/,
  );
});

void test("the deployed Wrangler configuration satisfies the staging binding contract", () => {
  const source = readFileSync(new URL("../../apps/worker/wrangler.jsonc", import.meta.url), "utf8");
  assertStagingBindings(ts.parseConfigFileTextToJson("wrangler.jsonc", source).config);
});

for (const option of [
  { migrations_dir: "alternate" },
  { migrations_pattern: "*.sql" },
  { migrations_table: "alternate" },
]) {
  void test(`staging rejects a migration override for ${Object.keys(option).join()}`, () => {
    const staging = {
      ...bindings,
      d1_databases: bindings.d1_databases.map((db) => ({ ...db, ...option })),
    };
    assert.throws(() => assertStagingBindings({ ...bindings, env: { staging } }), /d1_databases/);
  });
}
