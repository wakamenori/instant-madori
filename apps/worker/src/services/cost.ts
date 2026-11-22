import type { AiRequest, Conversation, Reply, Usage } from "../ai/round-trip.ts";
import { aiModels, limits, microUsd } from "../limits.ts";
import type { MicroUsd, PriceCategory } from "../limits.ts";

export interface AttemptEstimate {
  readonly reserve: MicroUsd;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AttemptCharge {
  readonly amount: MicroUsd;
  readonly withinEstimate: boolean;
}

const model = aiModels[limits.ai.model];
const prices = model.microUsdPerMillionTokens;
const usagePrices = {
  uncachedInputTokens: "input",
  cacheReadTokens: "cacheRead",
  cacheWrite5mTokens: "cacheWrite5m",
  cacheWrite1hTokens: "cacheWrite1h",
  outputTokens: "output",
} as const satisfies Record<keyof Usage, PriceCategory>;
const maxInputPrice = Math.max(
  ...Object.values(usagePrices)
    .filter((category) => category !== usagePrices.outputTokens)
    .map((category) => prices[category]),
);
const assumedFraming = { request: 256, turn: 32, part: 64, tool: 64 };
const encoder = new TextEncoder();

function textTokenBound(text: string): number {
  return encoder.encode(text).length;
}

type ImagePart = Extract<Conversation["opening"][number], { kind: "image" }>;
const pngHeader = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
];

function pngSize(image: ImagePart): { width: number; height: number } | null {
  const data = image.bytes;
  if (
    image.mediaType !== "image/png" ||
    data.length < 24 ||
    !pngHeader.every((byte, index) => data[index] === byte)
  )
    return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width === 0 || height === 0 ? null : { width, height };
}

function imageTokens(image: ImagePart): number {
  const { tilePx, maxTokens } = model.image;
  const size = pngSize(image);
  if (!size) return maxTokens;
  return Math.min(maxTokens, Math.ceil(size.width / tilePx) * Math.ceil(size.height / tilePx));
}

function partTokens(parts: Conversation["opening"]): number {
  return parts.reduce(
    (sum, part) =>
      sum +
      assumedFraming.part +
      (part.kind === "text" ? textTokenBound(part.text) : imageTokens(part)),
    0,
  );
}

function replyTokens(reply: Reply): number {
  if (reply.kind === "message") return partTokens(reply.parts);
  return reply.results.reduce(
    (sum, result) =>
      sum + assumedFraming.part + textTokenBound(result.callId) + partTokens(result.content),
    0,
  );
}

function totalInput(usage: Usage): number {
  return (
    usage.uncachedInputTokens +
    usage.cacheReadTokens +
    usage.cacheWrite5mTokens +
    usage.cacheWrite1hTokens
  );
}

function firstRequestBound(conversation: Conversation): number {
  const toolTokens = conversation.tools.reduce(
    (sum, tool) =>
      sum +
      assumedFraming.tool +
      textTokenBound(tool.name) +
      textTokenBound(tool.description) +
      textTokenBound(tool.inputSchemaJson),
    0,
  );
  return (
    assumedFraming.request +
    textTokenBound(conversation.system) +
    (conversation.tools.length > 0 ? model.toolUseSystemTokens : 0) +
    toolTokens +
    assumedFraming.turn +
    partTokens(conversation.opening)
  );
}

function boundAfterRound(last: Conversation["rounds"][number]): number {
  const { parts, usage } = last.assistant;
  return (
    totalInput(usage) +
    assumedFraming.turn +
    usage.outputTokens +
    assumedFraming.part * parts.length +
    assumedFraming.turn +
    replyTokens(last.reply)
  );
}

function roundedCharge(weightedTokens: bigint): MicroUsd {
  return microUsd(Number((weightedTokens + 999_999n) / 1_000_000n));
}

export function estimateAttempt({ conversation, maxOutputTokens }: AiRequest): AttemptEstimate {
  const last = conversation.rounds.at(-1);
  const inputTokens = last ? boundAfterRound(last) : firstRequestBound(conversation);
  const reserve = roundedCharge(
    BigInt(inputTokens) * BigInt(maxInputPrice) + BigInt(maxOutputTokens) * BigInt(prices.output),
  );
  return { reserve, inputTokens, outputTokens: maxOutputTokens };
}

function priceUsage<K extends keyof Usage>(
  usage: Usage,
  categories: Record<K, PriceCategory>,
): MicroUsd {
  let sum = 0n;
  for (const field in categories) sum += BigInt(usage[field]) * BigInt(prices[categories[field]]);
  return roundedCharge(sum);
}

export function settleAttempt(estimate: AttemptEstimate, usage: Usage): AttemptCharge {
  return {
    amount: priceUsage(usage, usagePrices),
    withinEstimate:
      totalInput(usage) <= estimate.inputTokens && usage.outputTokens <= estimate.outputTokens,
  };
}
