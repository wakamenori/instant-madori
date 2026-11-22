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
  readonly image: { readonly tilePx: number; readonly maxTokens: number };
  readonly microUsdPerMillionTokens: Readonly<Record<PriceCategory, number>>;
}

// https://platform.claude.com/docs/en/about-claude/pricing
// https://platform.claude.com/docs/en/build-with-claude/vision
export const aiModels = {
  "claude-opus-5-5": {
    toolUseSystemTokens: 286,
    image: { tilePx: 28, maxTokens: 4_784 },
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

export const limits = {
  aiCost: { monthly: microUsd(100_000_000), perInstruction: microUsd(5_000_000) },
  ai: { model: "claude-opus-5-5" },
} as const satisfies {
  aiCost: { monthly: MicroUsd; perInstruction: MicroUsd };
  ai: { model: AiModelId };
};
