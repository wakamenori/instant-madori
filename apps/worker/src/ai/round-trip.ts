import type { OutputTokenLimit } from "../limits.ts";

/**
 * Every type here is plain data that a Workflow step can return. JSON the model reads or writes
 * travels as text, because `unknown` or a recursive JSON type fails `Rpc.Serializable`.
 */
declare const received: unique symbol;

type ContentPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "image";
      readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
      readonly bytes: Uint8Array;
    };

/**
 * Sent without `strict`: Anthropic rejects the strict grammar of the generated tools as too large,
 * so the Worker's own validation of every call is the guard.
 */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchemaJson: string;
}

export type AssistantPart =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool_call";
      readonly id: string;
      readonly name: string;
      readonly inputJson: string;
    }
  | { readonly kind: "thinking"; readonly data: string };

/** Claude Opus 5.5 returns 400 when thinking blocks in a turn are filtered, reordered or edited. */
type ReceivedParts = readonly AssistantPart[] & { readonly [received]: true };

export interface AssistantTurn {
  /** Thinking data is readable only by the implementation and model that produced it. */
  readonly origin: string;
  readonly parts: ReceivedParts;
  /** Usage of the attempt that returned this turn. */
  readonly usage: Usage;
}

interface ToolResult {
  readonly callId: string;
  readonly content: readonly ContentPart[];
  readonly isError: boolean;
}

/** Tool calls require one result per call. Other turns require a message. */
export type Reply =
  | { readonly kind: "tool_results"; readonly results: readonly ToolResult[] }
  | { readonly kind: "message"; readonly parts: readonly ContentPart[] };

interface Round {
  readonly assistant: AssistantTurn;
  readonly reply: Reply;
}

/** Claude Opus 5.5 may return 400 when system, tools or earlier messages change mid-conversation. */
export interface Conversation {
  readonly system: string;
  readonly tools: readonly ToolSpec[];
  readonly opening: readonly ContentPart[];
  readonly rounds: readonly Round[];
}

export interface AiRequest {
  readonly conversation: Conversation;
  readonly maxOutputTokens: OutputTokenLimit;
}

export type StopReason = "end" | "tool_calls" | "output_limit" | "refusal";

export interface Usage {
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWrite5mTokens: number;
  readonly cacheWrite1hTokens: number;
}

export interface AiResponse {
  readonly kind: "ok";
  readonly assistant: AssistantTurn;
  readonly stop: StopReason;
}

export type ProviderErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "billing_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "other";

/** How the provider refused a request, without its message text. */
export interface ProviderRefusal {
  readonly status: number;
  readonly errorType: ProviderErrorType;
  readonly requestId: `req_${string}` | null;
}

type AiFailure = { readonly kind: "failed"; readonly detail: string } & (
  | {
      readonly reason: "rejected" | "script_ended" | "no_provider";
      readonly provider?: ProviderRefusal;
    }
  | { readonly reason: "unusable"; readonly usage: Usage }
);

export type AiResult = AiResponse | AiFailure;

export interface Ai {
  readonly model: string;
  roundTrip(request: AiRequest): Promise<AiResult>;
}

export function receivedTurn(
  origin: string,
  parts: readonly AssistantPart[],
  usage: Usage,
): AssistantTurn {
  const frozen = Object.freeze(parts.map((part) => Object.freeze({ ...part })));
  return Object.freeze({
    origin,
    parts: frozen as ReceivedParts,
    usage: Object.freeze({ ...usage }),
  });
}
