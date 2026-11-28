import assert from "node:assert/strict";
import { test } from "node:test";
import { receivedTurn } from "../src/ai/round-trip.ts";
import type { AiRequest, Conversation, Usage } from "../src/ai/round-trip.ts";
import { microUsd, outputTokenLimit } from "../src/limits.ts";
import { estimateAttempt, settleAttempt } from "../src/services/cost.ts";

function png(width: number, height: number): Uint8Array {
  const data = new Uint8Array(24);
  data.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(data.buffer);
  view.setUint32(8, 13);
  data.set(new TextEncoder().encode("IHDR"), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return data;
}

function textPart(text: string) {
  return { kind: "text", text } as const;
}

function pngPart(width: number, height: number) {
  return { kind: "image", mediaType: "image/png", bytes: png(width, height) } as const;
}

const first: AiRequest = {
  conversation: {
    system: "s".repeat(1_000),
    tools: [
      {
        name: "n".repeat(10),
        description: "d".repeat(90),
        inputSchemaJson: " ".repeat(398) + "{}",
      },
    ],
    opening: [
      textPart("x".repeat(600)),
      pngPart(1000, 700),
      { kind: "image", mediaType: "image/jpeg", bytes: new Uint8Array() },
    ],
    rounds: [],
  },
  maxOutputTokens: outputTokenLimit(32_000),
};

const usage: Usage = {
  uncachedInputTokens: 1_200,
  cacheReadTokens: 3_003,
  cacheWrite5mTokens: 2_000,
  cacheWrite1hTokens: 1_000,
  outputTokens: 3_500,
};

await test("reserves the most expensive input rate and full output allowance", () => {
  assert.deepEqual(estimateAttempt(first), {
    inputTokens: 8_614,
    outputTokens: 32_000,
    reserve: 708_912,
  });
});

await test("settles the five reported token categories and rounds up once", () => {
  assert.deepEqual(settleAttempt(estimateAttempt(first), usage), {
    amount: 93_401,
    withinEstimate: true,
  });
});

await test("a tool reply extends the previous attempt's billed input and output", () => {
  const assistant = receivedTurn(
    "scripted",
    [
      { kind: "thinking", data: "thought" },
      textPart("running tool"),
      { kind: "tool_call", id: "call-1", name: "n".repeat(10), inputJson: "{}" },
    ],
    usage,
  );
  const estimate = estimateAttempt({
    ...first,
    conversation: {
      ...first.conversation,
      rounds: [
        {
          assistant,
          reply: {
            kind: "tool_results",
            results: [
              {
                callId: "call-1",
                isError: false,
                content: [textPart("x".repeat(300)), pngPart(1024, 768)],
              },
            ],
          },
        },
      ],
    },
  });
  assert.deepEqual(estimate, { inputTokens: 12_493, outputTokens: 32_000, reserve: 739_944 });
});

function openingTokens(part: Conversation["opening"][number]): number {
  return estimateAttempt({
    conversation: { system: "", tools: [], opening: [part], rounds: [] },
    maxOutputTokens: outputTokenLimit(1),
  }).inputTokens;
}

await test("counts Japanese text in UTF-8 bytes", () => {
  assert.equal(openingTokens(textPart("日".repeat(10))), 382);
});

await test("charges all reported usage even when either token bound is exceeded", () => {
  const estimate = estimateAttempt(first);
  for (const exceeded of [
    { ...estimate, inputTokens: 7_202 },
    { ...estimate, outputTokens: 3_499 },
  ]) {
    assert.deepEqual(settleAttempt(exceeded, usage), { amount: 93_401, withinEstimate: false });
  }
});

await test("caps large PNGs and assumes the cap for unsupported or unreadable images", () => {
  for (const mediaType of ["image/gif", "image/webp", "image/jpeg"] as const) {
    assert.equal(openingTokens({ kind: "image", mediaType, bytes: png(1, 1) }), 5_136);
  }
  for (const data of [png(4000, 3000), png(0, 1), png(1, 0), png(1, 1).subarray(0, 20)]) {
    assert.equal(openingTokens({ kind: "image", mediaType: "image/png", bytes: data }), 5_136);
  }
  for (const offset of [0, 11, 12]) {
    const data = png(1, 1);
    data[offset] = 0;
    assert.equal(openingTokens({ kind: "image", mediaType: "image/png", bytes: data }), 5_136);
  }
});

await test("micro-USD amounts must be nonnegative safe integers", () => {
  for (const value of [-1, 1.5, NaN, 2 ** 53]) assert.throws(() => microUsd(value), RangeError);
  assert.equal(microUsd(0), 0);
});
