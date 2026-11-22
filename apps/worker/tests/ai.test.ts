import assert from "node:assert/strict";
import { test } from "node:test";
import { receivedTurn } from "../src/ai/round-trip.ts";
import type { AiRequest, AiResponse, AiResult, Conversation, Reply } from "../src/ai/round-trip.ts";
import { scriptedAi } from "../src/ai/scripted.ts";
import type { ScriptStep } from "../src/ai/scripted.ts";
import { selectAi } from "../src/ai/select.ts";

const script: ScriptStep[] = [
  {
    stop: "tool_calls",
    parts: [
      { kind: "thinking", data: "plan the room" },
      { kind: "text", text: "LDKを加えます。" },
      { kind: "thinking", data: "" },
      { kind: "tool_call", id: "call-1", name: "add_room", inputJson: '{"name":"LDK"}' },
    ],
  },
  {
    stop: "end",
    parts: [
      { kind: "thinking", data: "wrap up" },
      { kind: "text", text: "LDKを加えました。" },
    ],
  },
];

const opening: Conversation = {
  system: "You edit single-storey house plans.",
  tools: [{ name: "add_room", description: "Add a room.", inputSchemaJson: '{"type":"object"}' }],
  opening: [{ kind: "text", text: "LDKを加えて" }],
  rounds: [],
};

const roomAdded: Reply = {
  kind: "tool_results",
  results: [
    { callId: "call-1", content: [{ kind: "text", text: "added room-7" }], isError: false },
  ],
};

function request(conversation: Conversation): AiRequest {
  return { conversation, maxOutputTokens: 4096 };
}

function after(conversation: Conversation, response: AiResponse, reply: Reply): Conversation {
  return {
    ...conversation,
    rounds: [...conversation.rounds, { assistant: response.assistant, reply }],
  };
}

function ok(result: AiResult): AiResponse {
  assert.equal(result.kind, "ok", JSON.stringify(result));
  return result;
}

await test("scripted AI", async (t) => {
  await t.test(
    "returns tool calls, then text, in script order, and fails past the end",
    async () => {
      const ai = scriptedAi(script);
      const first = ok(await ai.roundTrip(request(opening)));
      assert.equal(first.stop, "tool_calls");
      assert.deepEqual(first.assistant.parts, script[0]?.parts);

      const second = ok(await ai.roundTrip(request(after(opening, first, roomAdded))));
      assert.equal(second.stop, "end");
      assert.deepEqual(second.assistant.parts, script[1]?.parts);

      const finished = after(after(opening, first, roomAdded), second, {
        kind: "message",
        parts: [{ kind: "text", text: "the plan fails check 3.6" }],
      });
      const past = await ai.roundTrip(request(finished));
      assert.equal(past.kind === "failed" && past.reason, "script_ended");
    },
  );

  await t.test(
    "a new instance continues from the conversation, as a restarted Workflow does",
    async () => {
      const first = ok(await scriptedAi(script).roundTrip(request(opening)));
      const resumed = scriptedAi(script);
      const second = ok(await resumed.roundTrip(request(after(opening, first, roomAdded))));
      assert.deepEqual(second.assistant.parts, script[1]?.parts);
    },
  );

  await t.test("the same request gets the same response, as a retried step sends it", async () => {
    const ai = scriptedAi(script);
    assert.deepEqual(await ai.roundTrip(request(opening)), await ai.roundTrip(request(opening)));
  });

  await t.test("rejects an assistant turn that was not sent back as received", async () => {
    const ai = scriptedAi(script);
    const first = ok(await ai.roundTrip(request(opening)));
    const parts = first.assistant.parts;
    for (const edited of [
      parts.filter((part) => part.kind !== "thinking"),
      [...parts].reverse(),
      parts.map((part) => (part.kind === "thinking" ? { ...part, data: "edited" } : part)),
    ]) {
      const forged: AiResponse = {
        ...first,
        assistant: receivedTurn("scripted", edited, first.assistant.usage),
      };
      const result = await ai.roundTrip(request(after(opening, forged, roomAdded)));
      assert.equal(result.kind === "failed" && result.reason, "rejected");
    }
  });

  await t.test("accepts a faithful echo with keys in another order", async () => {
    const ai = scriptedAi(script);
    const first = ok(await ai.roundTrip(request(opening)));
    const assistant = {
      parts: first.assistant.parts,
      origin: first.assistant.origin,
      usage: first.assistant.usage,
    };
    const second = ok(
      await ai.roundTrip(request(after(opening, { ...first, assistant }, roomAdded))),
    );
    assert.equal(second.stop, "end");
  });

  await t.test("a returned turn cannot change the script or another instance", async () => {
    const first = ok(await scriptedAi(script).roundTrip(request(opening)));
    const part = first.assistant.parts[0];
    assert(part?.kind === "thinking");
    assert.throws(() => Object.assign(part, { data: "edited" }), TypeError);
    const replay = ok(await scriptedAi(script).roundTrip(request(opening)));
    assert.deepEqual(replay.assistant.parts, script[0]?.parts);
  });

  await t.test("copies the caller's script and usage at construction", async () => {
    const part = { kind: "text", text: "original" } as const;
    const usage = {
      uncachedInputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 1,
      cacheWrite5mTokens: 3,
      cacheWrite1hTokens: 4,
    };
    const source: ScriptStep[] = [{ stop: "end", parts: [part], usage }];
    const ai = scriptedAi(source);
    source.length = 0;
    Object.assign(part, { text: "edited" });
    usage.uncachedInputTokens = 0;
    const result = ok(await ai.roundTrip(request(opening)));
    assert.deepEqual(result.assistant.parts, [{ kind: "text", text: "original" }]);
    assert.deepEqual(result.assistant.usage, { ...usage, uncachedInputTokens: 10 });
    assert.ok(Object.isFrozen(result.assistant.usage));
  });

  await t.test("requires exactly one result per tool call", async () => {
    const ai = scriptedAi(script);
    const first = ok(await ai.roundTrip(request(opening)));
    const result = { callId: "call-1", content: [], isError: false };
    const replies: Reply[] = [
      { kind: "message", parts: [{ kind: "text", text: "go on" }] },
      { kind: "tool_results", results: [] },
      { kind: "tool_results", results: [result, result] },
      { kind: "tool_results", results: [{ ...result, callId: "extra" }] },
    ];
    for (const reply of replies) {
      const answer = await ai.roundTrip(request(after(opening, first, reply)));
      assert.equal(answer.kind === "failed" && answer.reason, "rejected");
    }
  });

  await t.test("refuses malformed scripts at construction", () => {
    const call = { kind: "tool_call", id: "x", name: "add_room", inputJson: "{}" } as const;
    const malformed: ScriptStep[] = [
      { stop: "tool_calls", parts: [{ kind: "text", text: "no call" }] },
      { stop: "end", parts: [call] },
      { stop: "end", parts: [] },
      ...["[]", "null", "{"].map((inputJson) => ({
        stop: "tool_calls" as const,
        parts: [{ ...call, inputJson }],
      })),
    ];
    for (const step of malformed) assert.throws(() => scriptedAi([step]), /step 0/u);
    const step: ScriptStep = { stop: "tool_calls", parts: [call] };
    assert.throws(() => scriptedAi([step, step]), /step 1/u);
  });
});

await test("AI selection", async (t) => {
  for (const ENVIRONMENT of ["local", "staging"]) {
    await t.test(`${ENVIRONMENT} answers from the script`, async () => {
      const result = await selectAi({ ENVIRONMENT }).roundTrip(request(opening));
      assert.equal(result.kind, "ok");
    });
  }

  for (const ENVIRONMENT of ["production", "", "Local", "staging ", "preview"]) {
    await t.test(`${JSON.stringify(ENVIRONMENT)} cannot use the scripted AI`, async () => {
      const result = await selectAi({ ENVIRONMENT }).roundTrip(request(opening));
      assert.equal(result.kind === "failed" && result.reason, "no_provider");
    });
  }
});
