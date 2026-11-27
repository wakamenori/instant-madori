import assert from "node:assert/strict";
import { test } from "node:test";
import { aiTools } from "@madori/contracts/ai-tools";
import { anthropicAi } from "../src/ai/anthropic.ts";
import { receivedTurn, type AiRequest, type Usage } from "../src/ai/round-trip.ts";
import { turnCodec } from "../src/ai/turns.ts";
import { outputTokenLimit } from "../src/limits.ts";
import { estimateAttempt, settleAttempt } from "../src/services/cost.ts";
import {
  contentBlock,
  event,
  recordedStream,
  recordedUsage,
  sse,
} from "./support/anthropic-sse.ts";

const model = "claude-opus-5-5";
const key = "fake-test-key";
const prompt = "6畳くらいの寝室と、広めのLDKがある小さな平屋";
const request: AiRequest = {
  maxOutputTokens: outputTokenLimit(16_000),
  conversation: {
    system: "Design a small house.",
    tools: aiTools,
    opening: [
      { kind: "text", text: prompt },
      { kind: "image", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3, 4]) },
    ],
    rounds: [],
  },
};
const usage: Usage = {
  uncachedInputTokens: 1_200,
  cacheReadTokens: 3_003,
  cacheWrite5mTokens: 2_000,
  cacheWrite1hTokens: 1_000,
  outputTokens: 3_500,
};
const thinking = {
  type: "thinking",
  thinking: "考え",
  signature: "sig-test",
  future_field: "keep",
};
const redacted = { type: "redacted_thinking", data: "encrypted-test" };
const text = { type: "text", text: "LDKを作ります。" };
const call = { type: "tool_use", id: "toolu_test", name: "edit_house", input: { operations: [] } };
const toolBlocks = [
  contentBlock(0, { ...thinking, thinking: "", signature: "" }, [
    { type: "thinking_delta", thinking: thinking.thinking },
    { type: "signature_delta", signature: thinking.signature },
  ]),
  contentBlock(1, text),
  contentBlock(2, redacted),
  contentBlock(3, { ...call, input: {} }, [
    { type: "input_json_delta", partial_json: '{"operations":' },
    { type: "input_json_delta", partial_json: "[]}" },
  ]),
];

await test("streams a tool round without strict tools and echoes stored thinking blocks in order", async () => {
  const sent: Request[] = [];
  const ai = anthropicAi({
    apiKey: key,
    model,
    fetch(input, init) {
      sent.push(new Request(input, init));
      return Promise.resolve(
        sent.length === 1
          ? sse(recordedStream({ stopReason: "tool_use", blocks: toolBlocks }))
          : sse(recordedStream({ blocks: [contentBlock(0, text)] })),
      );
    },
  });

  const first = await ai.roundTrip(request);
  assert.equal(first.kind, "ok");
  assert.equal(first.stop, "tool_calls");
  assert.equal(first.assistant.origin, `anthropic/${model}`);
  assert.deepEqual(first.assistant.parts, [
    { kind: "thinking", data: JSON.stringify(thinking) },
    { kind: "text", text: text.text },
    { kind: "thinking", data: JSON.stringify(redacted) },
    { kind: "tool_call", id: call.id, name: call.name, inputJson: '{"operations":[]}' },
  ]);
  assert.deepEqual(first.assistant.usage, usage);
  assert.equal(settleAttempt(estimateAttempt(request), first.assistant.usage).amount, 93_401);

  const expected = {
    stream: true,
    model,
    max_tokens: 16_000,
    system: request.conversation.system,
    tools: aiTools.map(({ name, description, inputSchemaJson }) => ({
      name,
      description,
      input_schema: JSON.parse(inputSchemaJson) as unknown,
    })),
    tool_choice: { type: "auto" },
    output_config: { effort: "medium" },
    cache_control: { type: "ephemeral" },
    service_tier: "standard_only",
  };
  const opening = {
    role: "user",
    content: [
      { type: "text", text: prompt },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQIDBA==" } },
    ],
  };
  const firstRequest = sent[0];
  assert(firstRequest);
  assert.equal(firstRequest.method, "POST");
  assert.equal(firstRequest.headers.get("authorization"), `Bearer ${key}`);
  assert.equal(new URL(firstRequest.url).pathname, "/v1/messages");
  assert.deepEqual(await firstRequest.json(), { ...expected, messages: [opening] });

  const next = await ai.roundTrip({
    ...request,
    conversation: {
      ...request.conversation,
      rounds: [
        {
          assistant: turnCodec.decode(turnCodec.encode(first)).assistant,
          reply: {
            kind: "tool_results",
            results: [
              {
                callId: call.id,
                content: [{ kind: "text", text: "tool reply" }],
                isError: true,
              },
            ],
          },
        },
      ],
    },
  });
  assert.equal(next.kind, "ok");
  assert.equal(next.stop, "end");
  assert.deepEqual(next.assistant.parts, [{ kind: "text", text: text.text }]);
  const assistant = { role: "assistant", content: [thinking, text, redacted, call] };
  const secondRequest = sent[1];
  assert(secondRequest);
  const body = await secondRequest.text();
  assert.deepEqual(JSON.parse(body), {
    ...expected,
    messages: [
      opening,
      assistant,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: call.id,
            content: [{ type: "text", text: "tool reply" }],
            is_error: true,
          },
        ],
      },
    ],
  });
  assert.ok(body.includes(JSON.stringify(assistant)));
  assert.equal(sent.length, 2);
});

await test("refusals and output limits discard content but report the final usage", async (t) => {
  const truncated = contentBlock(0, { ...call, input: {} }, [
    { type: "input_json_delta", partial_json: '{"operations":[' },
  ]);
  const withoutSplit = {
    input_tokens: recordedUsage.input_tokens,
    cache_read_input_tokens: recordedUsage.cache_read_input_tokens,
    cache_creation_input_tokens: recordedUsage.cache_creation_input_tokens,
  };
  for (const [stopReason, stop] of [
    ["max_tokens", "output_limit"],
    ["model_context_window_exceeded", "output_limit"],
    ["refusal", "refusal"],
  ] as const) {
    await t.test(stopReason, async () => {
      const ai = anthropicAi({
        apiKey: key,
        model,
        fetch: () =>
          Promise.resolve(
            sse(
              recordedStream({
                stopReason,
                blocks: stopReason === "refusal" ? toolBlocks : [truncated],
                usage: withoutSplit,
              }),
            ),
          ),
      });
      const response = await ai.roundTrip(request);
      assert.equal(response.kind, "ok");
      assert.equal(response.stop, stop);
      assert.deepEqual(response.assistant.parts, []);
      assert.deepEqual(response.assistant.usage, {
        ...usage,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 3_000,
      });
    });
  }
});

await test("billed unsupported stops, blocks and inconsistent turns carry usage", async (t) => {
  for (const body of [
    recordedStream({ stopReason: "pause_turn" }),
    recordedStream({ stopReason: "future_stop" }),
    recordedStream({ blocks: [contentBlock(0, { type: "future_block" })] }),
    recordedStream({ stopReason: "tool_use", blocks: [contentBlock(0, text)] }),
    recordedStream({ blocks: toolBlocks }),
  ]) {
    await t.test("unusable stream", async () => {
      const ai = anthropicAi({ apiKey: key, model, fetch: () => Promise.resolve(sse(body)) });
      const response = await ai.roundTrip(request);
      assert.equal(response.kind, "failed");
      assert.equal(response.reason, "unusable");
      assert.deepEqual(response.usage, usage);
    });
  }
});

await test("rejects a prior turn from another model without sending a request", async () => {
  const ai = anthropicAi({ apiKey: key, model, fetch: () => assert.fail("unexpected request") });
  const response = await ai.roundTrip({
    ...request,
    conversation: {
      ...request.conversation,
      rounds: [
        {
          assistant: receivedTurn("scripted", [], usage),
          reply: { kind: "message", parts: [{ kind: "text", text: "続けて" }] },
        },
      ],
    },
  });
  assert.equal(response.kind === "failed" && response.reason, "rejected");
});

await test("rejects HTTP errors and redirects before inference", async (t) => {
  const grammarTooLarge = JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "The compiled grammar is too large" },
  });
  for (const [status, reason, body, errorType] of [
    [307, "rejected", "ignored response", "other"],
    [400, "rejected", grammarTooLarge, "invalid_request_error"],
    [401, "no_provider", "ignored response", "other"],
    [403, "no_provider", "ignored response", "other"],
  ] as const) {
    await t.test(`HTTP ${status}`, async () => {
      let requests = 0;
      const ai = anthropicAi({
        apiKey: key,
        model,
        fetch: (_input, init) => {
          requests++;
          assert.equal(init?.redirect, "manual");
          return Promise.resolve(
            new Response(body, {
              status,
              headers: { location: "/other", "request-id": "req_011Test" },
            }),
          );
        },
      });
      const response = await ai.roundTrip(request);
      assert(response.kind === "failed");
      assert.equal(response.reason, reason);
      assert.deepEqual("provider" in response && response.provider, {
        status,
        errorType,
        requestId: "req_011Test",
      });
      assert.doesNotMatch(JSON.stringify(response), /compiled grammar/u);
      assert.equal(requests, 1);
    });
  }
});

await test("interrupted attempts throw safely and make exactly one request", async (t) => {
  const privateBody = "private-test-message";
  const cases: [string, () => Response][] = [
    [
      "connection failure",
      () => {
        throw new TypeError(privateBody);
      },
    ],
    ...[408, 409, 429, 529].map((status): [string, () => Response] => [
      `HTTP ${status}`,
      () => new Response(privateBody, { status }),
    ]),
    [
      "SSE error",
      () =>
        sse(
          recordedStream({
            stopReason: null,
            after: event("error", { error: { type: "overloaded_error", message: privateBody } }),
          }),
        ),
    ],
    ["missing message_stop", () => sse(recordedStream({ after: "" }))],
    ["missing message_delta", () => sse(recordedStream({ stopReason: null }))],
    [
      "malformed SSE",
      () =>
        sse(
          recordedStream({
            stopReason: null,
            after: `event: content_block_delta\ndata: ${privateBody}\n\n`,
          }),
        ),
    ],
  ];

  for (const [label, respond] of cases) {
    await t.test(label, async (t) => {
      const logs = (["log", "debug", "info", "warn", "error"] as const).map((method) =>
        t.mock.method(console, method, () => {}),
      );
      let requests = 0;
      const ai = anthropicAi({
        apiKey: key,
        model,
        fetch: () => {
          requests++;
          return Promise.resolve(respond());
        },
      });
      await assert.rejects(ai.roundTrip(request), (error: unknown) => {
        assert(error instanceof Error);
        assert.match(error.message, /Anthropic attempt interrupted/u);
        assert.doesNotMatch(error.message, new RegExp(privateBody, "u"));
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(requests, 1);
      assert.doesNotMatch(
        JSON.stringify(logs.flatMap((log) => log.mock.calls.map((call) => call.arguments))),
        new RegExp(privateBody, "u"),
      );
    });
  }
});
