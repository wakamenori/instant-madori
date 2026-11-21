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
void test("sanitized tool inputs retain commands and discard briefs and tokens on replay", () => {
  const secret = "gh" + "p_" + "a".repeat(36);
  const payload = {
    attributes: [
      {
        key: "tool_input",
        value: {
          stringValue: JSON.stringify({
            command: "echo " + secret,
            prompt: "private brief",
            subagent_type: "owner",
          }),
        },
      },
      { key: "output", value: { stringValue: "private output" } },
    ],
  };
  const scrubbed = telemetry(payload);
  const text = JSON.stringify(scrubbed);
  assert.doesNotMatch(text, /private|ghp_/u);
  assert.match(text, /echo \[redacted:github\]/u);
  assert.deepEqual(telemetry(scrubbed), scrubbed);
});
void test("a body without an event name never becomes a natural key", () => {
  const resource = { attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }] };
  const log = {
    attributes: [{ key: "session.id", value: { stringValue: "fake-session" } }],
    body: { stringValue: "free form body" },
  };
  const result = parseOtlp(
    "logs",
    Buffer.from(
      JSON.stringify({ resourceLogs: [{ resource, scopeLogs: [{ logRecords: [log] }] }] }),
    ),
  );
  assert.ok(result.records[0]);
  assert.doesNotMatch(result.records[0].naturalKey, /free form body/u);
});
void test("hook privacy keeps validated prompt facts across replays", () => {
  const payload = registry["claude.hook"].sanitize({
    input: {
      prompt: "/madori-owner #31 private words",
      last_assistant_message: "検証役 PASS",
      session_crons: [1, 2],
    },
  });
  const text = JSON.stringify(payload);
  assert.match(text, /madori-owner/u);
  assert.match(text, /"refs":\[31\]/u);
  assert.match(text, /"session_crons_count":2/u);
  assert.doesNotMatch(text, /private words/u);
  assert.deepEqual(registry["claude.hook"].sanitize(payload), payload);
});

void test("only the event name survives in an OTLP body", () => {
  const sanitize = registry["claude.otel.log"].sanitize;
  const attributes = [{ key: "event.name", value: { stringValue: "tool_result" } }];
  for (const name of ["tool_result", "claude_code.tool_result"]) {
    const body = { stringValue: name };
    assert.deepEqual(sanitize({ log_record: { attributes, body: { ...body, extra: "secret" } } }), {
      log_record: { attributes, body },
    });
  }
  assert.deepEqual(
    sanitize({ log_record: { attributes, body: { kvlistValue: { secret: "hidden" } } } }),
    { log_record: { attributes } },
  );
});
