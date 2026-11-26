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

/** Every tool is strict. The provider adapter sends `strict: true`. */
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
  readonly maxOutputTokens: number;
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

interface AiFailure {
  readonly kind: "failed";
  readonly reason: "rejected" | "script_ended" | "no_provider";
  readonly detail: string;
}

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
