import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseOtlp } from "./otlp.ts";
import { parseHook } from "./hook-record.ts";
import { registry } from "../l1/sources.ts";
import { telemetry } from "../l1/privacy.ts";
void test("captured envelopes retain individual attributed records", () => {
  for (const [name, signal] of [
    ["claude-code-Logs", "logs"],
    ["claude-code-Metrics", "metrics"],
    ["codex_exec-Logs", "logs"],
  ] as const) {
    const out = parseOtlp(
      signal,
      readFileSync(join(import.meta.dirname, "fixtures", name + ".json")),
    );
    assert.deepEqual(out.rejects, []);
    assert.ok(out.records.length > 0, name);
    for (const c of out.records) {
      const payload = JSON.stringify(registry[c.source].sanitize(c.payload));
      assert.doesNotMatch(payload, /fake-user-|fake-host-name|fake-organization-id/u);
    }
  }
});
void test("nested AnyValue lists drop identities at every depth", () => {
  const attr = { key: "host.name", value: { stringValue: "sensitive" } };
  for (const nest of [
    { kvlistValue: { values: [attr] } },
    { arrayValue: { values: [{ kvlistValue: { values: [attr] } }] } },
  ])
    assert.doesNotMatch(
      JSON.stringify(telemetry({ attributes: [{ key: "test", value: nest }] })),
      /sensitive/u,
    );
});
void test("hook project proves its session and drops arbitrary input", () => {
  const stdin = readFileSync(join(import.meta.dirname, "fixtures/hook.json"), "utf8");
  const bytes = Buffer.from(
    JSON.stringify({
      v: 1,
      id: randomUUID(),
      at: new Date().toISOString(),
      stdin,
      project: { dir: "/repo", git: { kind: "directory" } },
      env: { SECRET: "sensitive" },
    }),
  );
  assert.equal(parseHook(bytes, "/other/.git").drops[0]?.reason, "foreign");
  const row = parseHook(bytes, "/repo/.git").records[0];
  assert.ok(row);
  assert.equal(row.scope.kind, "proof");
  assert.doesNotMatch(JSON.stringify(registry[row.source].sanitize(row.payload)), /sensitive/u);
});
