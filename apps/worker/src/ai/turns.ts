import { z } from "zod";
import { receivedTurn } from "./round-trip.ts";
import type { AiResponse } from "./round-trip.ts";

const tokens = z.int().nonnegative();
const storedTurn = z.strictObject({
  format: z.literal(1),
  origin: z.string(),
  stop: z.enum(["end", "tool_calls", "output_limit", "refusal"]),
  usage: z.strictObject({
    uncachedInputTokens: tokens,
    outputTokens: tokens,
    cacheReadTokens: tokens,
    cacheWrite5mTokens: tokens,
    cacheWrite1hTokens: tokens,
  }),
  parts: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("text"), text: z.string() }),
      z.strictObject({ kind: z.literal("thinking"), data: z.string() }),
      z.strictObject({
        kind: z.literal("tool_call"),
        id: z.string(),
        name: z.string(),
        inputJson: z.string(),
      }),
    ]),
  ),
});

export const turnCodec = {
  encode({ assistant, stop }: AiResponse): string {
    return JSON.stringify({ format: 1, ...assistant, stop });
  },
  decode(text: string): AiResponse {
    const { origin, parts, usage, stop } = storedTurn.parse(JSON.parse(text));
    return { kind: "ok", assistant: receivedTurn(origin, parts, usage), stop };
  },
};
