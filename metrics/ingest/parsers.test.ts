import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import { parseCodexHook } from "./codex-hook.ts";
import { object } from "../l1/privacy.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseOtlp } from "./otlp.ts";
import { parseSlot } from "./docker-slot.ts";
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

void test("permission hook proves session membership with only request metadata", () => {
  const input = {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    session_id: "s",
    prompt: "private",
    reason: "private",
    tool_input: { command: "private" },
  };
  const parsed = parseHook(
    Buffer.from(
      JSON.stringify({
        v: 1,
        id: randomUUID(),
        at: new Date().toISOString(),
        project: { dir: "/repo", git: { kind: "directory" } },
        env: {},
        stdin: JSON.stringify(input),
      }),
    ),
    "/repo/.git",
  );
  const row = parsed.records[0];
  assert.ok(row);
  assert.deepEqual(row.scope, { kind: "proof", subject: "claude.session:s" });
  assert.deepEqual(registry["claude.hook"].sanitize(row.payload).input, {
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    session_id: "s",
  });
});

void test("a runner checkout can prove its repository with an Actions run and attempt", () => {
  const event = {
    v: 1,
    wait_id: randomUUID(),
    phase: "acquired",
    pool: "runner",
    cwd: "/runner/work",
    at: new Date().toISOString(),
    project: { dir: "/runner/work", git: { kind: "directory" } },
    repository: "wakamenori/instant-madori",
    run_id: "123",
    run_attempt: "2",
  };
  const parse = (overrides: object) =>
    parseSlot(Buffer.from(JSON.stringify({ ...event, ...overrides })), "/main/.git");
  assert.deepEqual(
    parse({}).records.map((r) => [r.payload.run_id, r.payload.run_attempt]),
    [["123", "2"]],
  );
  for (const override of [
    { repository: "other/repo" },
    { run_attempt: undefined },
    { pool: "development" },
  ])
    assert.equal(parse(override).drops[0]?.reason, "foreign");
});

void test("Codex recorder and receiver preserve turn and approval facts across replay", (t) => {
  const root = resolve(import.meta.dirname, "../..");
  const dir = mkdtempSync(join(tmpdir(), "codex-hook-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const ready = join(dir, "spool/ready");
  const identity = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const config = z
    .object({
      hooks: z.record(
        z.string(),
        z.array(z.object({ hooks: z.array(z.object({ command: z.string() })) })),
      ),
    })
    .parse(JSON.parse(readFileSync(join(root, ".codex/hooks.json"), "utf8")));
  const session = "test-session";
  const base = {
    session_id: session,
    cwd: root,
    transcript_path: "/tmp/session",
    model: "test-model",
    permission_mode: "default",
    unknown_field: "discard-me",
  };
  const turn = { turn_id: "test-turn" };
  const call = {
    ...turn,
    tool_use_id: "tool-id",
    tool_name: "apply_patch",
    tool_input: { input: "private patch body" },
  };
  const examples = {
    SessionStart: { source: "startup" },
    UserPromptSubmit: {
      ...turn,
      agent_id: "owner",
      agent_type: "default",
      prompt: "/madori-owner #547 #99999999999999999 secret=private-prompt-body",
    },
    PreToolUse: call,
    PostToolUse: { ...call, tool_response: "private tool output" },
    PermissionRequest: { ...turn, tool_name: "Bash", tool_input: { command: "git status" } },
    Stop: {
      ...turn,
      last_assistant_message: "検証役 PASS #552 private final message",
      stop_hook_active: false,
    },
  };
  const recorderPath = relative(root, fileURLToPath(new URL("../hook/codex.ts", import.meta.url)));
  function run(event: string, fields: object, cwd: string) {
    const recorder = config.hooks[event]?.[0]?.hooks[0];
    assert.ok(recorder);
    assert.equal(recorder.command, `node ${recorderPath} ${event} >/dev/null 2>&1 || true`);
    const result = spawnSync("/bin/sh", ["-c", recorder.command], {
      cwd,
      env: { ...process.env, INSTANT_MADORI_METRICS_HOME: dir },
      input: JSON.stringify({ ...base, hook_event_name: event, ...fields }),
      encoding: "utf8",
    });
    assert.deepEqual([result.status, result.stdout, result.stderr], [0, "", ""]);
  }
  run("SessionStart", examples.SessionStart, root);
  assert.deepEqual(readdirSync(dir), []);
  mkdirSync(ready, { recursive: true });
  mkdirSync(join(dir, "spool/tmp"));
  run("SessionStart", examples.SessionStart, dir);
  assert.deepEqual(readdirSync(ready), []);
  for (const [event, fields] of Object.entries(examples)) {
    run(event, fields, root);
    const files = readdirSync(ready);
    assert.equal(files.length, 1);
    const [name] = files;
    assert.ok(name && name.startsWith("codex-hook-") && name.endsWith(".json"));
    const path = join(ready, name);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const bytes = readFileSync(path);
    rmSync(path);
    assert.doesNotMatch(bytes.toString(), /tool_response|private tool output|unknown_field/u);
    assert.deepEqual(parseCodexHook(bytes, "/other/.git").drops, [
      { source: "codex.hook", reason: "foreign" },
    ]);
    const row = parseCodexHook(bytes, identity).records[0];
    assert.ok(row);
    assert.equal(row.source, "codex.hook");
    assert.deepEqual(row.scope, { kind: "gated", subject: "codex.conversation:" + session });
    const sanitize = registry["codex.hook"].sanitize;
    const payload = sanitize(row.payload);
    assert.deepEqual(sanitize(payload), payload);
    assert.doesNotMatch(
      JSON.stringify(payload),
      /private-prompt-body|private tool output|private patch body|private final message/u,
    );
    const facts = object(payload.input);
    assert.equal(facts.hook_event_name, event);
    if ("turn_id" in fields) assert.equal(facts.turn_id, fields.turn_id);
    if ("tool_use_id" in fields) {
      assert.equal(facts.tool_use_id, fields.tool_use_id);
      assert.deepEqual(facts.tool_input, { input: "[dropped 18 chars]" });
    }
    if (event === "PermissionRequest")
      assert.deepEqual(facts.tool_input, examples.PermissionRequest.tool_input);
    if (event === "UserPromptSubmit") {
      assert.deepEqual(object(facts.prompt_digest).refs, [547]);
      assert.deepEqual(object(facts.prompt_digest).markers, ["madori-owner"]);
    }
    if (event === "Stop") {
      assert.deepEqual(object(facts.last_assistant_message_digest).refs, [552]);
      assert.deepEqual(object(facts.last_assistant_message_digest).markers, ["検証役", "PASS"]);
    }
  }
});
