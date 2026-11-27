declare const microUsdBrand: unique symbol;
export type MicroUsd = number & { readonly [microUsdBrand]: true };

export function microUsd(value: number): MicroUsd {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Micro-USD must be a nonnegative safe integer");
  }
  return value as MicroUsd;
}

export type PriceCategory = "input" | "cacheWrite5m" | "cacheWrite1h" | "cacheRead" | "output";

interface AiModelSpec {
  readonly toolUseSystemTokens: number;
  readonly image: {
    readonly maxBase64Bytes: number;
    readonly downscaleEdgePx: number;
    readonly tilePx: number;
    readonly maxTokens: number;
  };
  readonly microUsdPerMillionTokens: Readonly<Record<PriceCategory, number>>;
}

// https://platform.claude.com/docs/en/about-claude/pricing
// https://platform.claude.com/docs/en/build-with-claude/vision
export const aiModels = {
  "claude-opus-5-5": {
    toolUseSystemTokens: 286,
    // The vision doc gives 10 MB per image without saying 10^6 or 2^20; take the smaller.
    image: { maxBase64Bytes: 10_000_000, downscaleEdgePx: 2_576, tilePx: 28, maxTokens: 4_784 },
    microUsdPerMillionTokens: {
      input: 4_000_000,
      cacheWrite5m: 5_000_000,
      cacheWrite1h: 8_000_000,
      cacheRead: 200_000,
      output: 20_000_000,
    },
  },
} as const satisfies Record<string, AiModelSpec>;

export type AiModelId = keyof typeof aiModels;

const ai = { model: "claude-opus-5-5" } as const;
const aiImage = aiModels[ai.model].image;

export const limits = {
  aiCost: { monthly: microUsd(100_000_000), perInstruction: microUsd(5_000_000) },
  ai,
  assets: {
    // The largest size whose base64 (4 * ceil(n / 3) bytes) stays strictly below the limit.
    maxBytes: 3 * Math.floor((aiImage.maxBase64Bytes - 1) / 4),
    // A Worker isolate has 128 MB. An inline-base64 AI request holds each image's raw bytes,
    // its base64 and its share of the encoded body (about 27.5 MB at the size limit), so three
    // fit. Raising this is safe; lowering it strands instructions already accepted.
    // https://developers.cloudflare.com/workers/platform/limits/
    maxPerInstruction: 3,
    maxEdgePx: aiImage.downscaleEdgePx,
  },
  editHouse: { maxOperations: 32 },
  jobRun: {
    rounds: 24,
    checkFixes: 3,
  },
} as const satisfies {
  aiCost: { monthly: MicroUsd; perInstruction: MicroUsd };
  ai: { model: AiModelId };
  assets: { maxBytes: number; maxEdgePx: number; maxPerInstruction: number };
  editHouse: { maxOperations: number };
  jobRun: { rounds: number; checkFixes: number };
};

export type JobLimit = keyof typeof limits.aiCost | keyof typeof limits.jobRun;
