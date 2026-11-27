import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AiModelId } from "../limits.ts";
import { receivedTurn } from "./round-trip.ts";
import type { Ai, AiRequest, AiResult, AssistantPart, Conversation, Usage } from "./round-trip.ts";

export interface AnthropicSettings {
  readonly apiKey: string;
  readonly model: AiModelId;
  readonly fetch?: typeof fetch;
}

const effort = "medium";
const deadlineMs = 540_000;

const toolInputSchema = z.looseObject({
  type: z.literal("object"),
  required: z.array(z.string()).nullable().exactOptional(),
});

const thinkingSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("thinking"), thinking: z.string(), signature: z.string() }),
  z.looseObject({ type: z.literal("redacted_thinking"), data: z.string() }),
]);
const textSchema = z.object({ type: z.literal("text"), text: z.string() });
const toolUseSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.json(),
});
const blockSchema = z.union([textSchema, toolUseSchema, thinkingSchema]);

const tokens = z.int().nonnegative();
const messageSchema = z.object({
  stop_reason: z.string().nullable(),
  content: z.unknown(),
  usage: z.object({
    input_tokens: tokens,
    output_tokens: tokens,
    cache_read_input_tokens: tokens.nullish(),
    cache_creation_input_tokens: tokens.nullish(),
    cache_creation: z
      .object({
        ephemeral_5m_input_tokens: tokens.nullish(),
        ephemeral_1h_input_tokens: tokens.nullish(),
      })
      .nullish(),
  }),
});

function encodeBase64(bytes: Uint8Array): string {
  // A multiple of three keeps padding out of the middle of the encoded image.
  const chunkBytes = 24 * 1024;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes))));
  }
  return chunks.join("");
}

function isThinkingBlock(value: unknown): value is z.infer<typeof thinkingSchema> {
  return thinkingSchema.safeParse(value).success;
}

function userContent(
  part: Conversation["opening"][number],
): Anthropic.TextBlockParam | Anthropic.ImageBlockParam {
  if (part.kind === "text") return { type: "text", text: part.text };
  return {
    type: "image",
    source: { type: "base64", media_type: part.mediaType, data: encodeBase64(part.bytes) },
  };
}

function assistantContent(part: AssistantPart): Anthropic.ContentBlockParam {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "thinking": {
      const wire: unknown = JSON.parse(part.data);
      if (!isThinkingBlock(wire)) throw new Error("Invalid Anthropic thinking block");
      // Keep the original object and key order of signed blocks.
      return wire;
    }
    case "tool_call": {
      const input: unknown = JSON.parse(part.inputJson);
      return { type: "tool_use", id: part.id, name: part.name, input };
    }
  }
}

function buildRequest(model: AiModelId, request: AiRequest): Anthropic.MessageStreamParams {
  const { conversation, maxOutputTokens } = request;
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: conversation.opening.map(userContent) },
  ];
  for (const { assistant, reply } of conversation.rounds) {
    messages.push({ role: "assistant", content: assistant.parts.map(assistantContent) });
    messages.push({
      role: "user",
      content:
        reply.kind === "message"
          ? reply.parts.map(userContent)
          : reply.results.map(({ callId, content, isError }) => ({
              type: "tool_result",
              tool_use_id: callId,
              content: content.map(userContent),
              is_error: isError,
            })),
    });
  }
  return {
    model,
    max_tokens: maxOutputTokens,
    system: conversation.system,
    tools: conversation.tools.map(({ name, description, inputSchemaJson }) => ({
      name,
      description,
      input_schema: toolInputSchema.parse(JSON.parse(inputSchemaJson)),
      strict: true,
    })),
    tool_choice: { type: "auto" },
    output_config: { effort },
    cache_control: { type: "ephemeral" },
    service_tier: "standard_only",
    messages,
  };
}

function mapUsage(usage: z.infer<typeof messageSchema>["usage"]): Usage {
  const cacheWrite5mTokens = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  return {
    uncachedInputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWrite5mTokens,
    cacheWrite1hTokens: Math.max(
      usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      (usage.cache_creation_input_tokens ?? 0) - cacheWrite5mTokens,
    ),
  };
}

function mapResponse(origin: string, raw: unknown): AiResult {
  const message = messageSchema.parse(raw);
  const reason = message.stop_reason;
  if (reason === null) throw new Error("Missing terminal Anthropic message delta");
  const usage = mapUsage(message.usage);
  if (
    reason === "max_tokens" ||
    reason === "model_context_window_exceeded" ||
    reason === "refusal"
  ) {
    return {
      kind: "ok",
      stop: reason === "refusal" ? "refusal" : "output_limit",
      assistant: receivedTurn(origin, [], usage),
    };
  }

  const unusable = {
    kind: "failed",
    reason: "unusable",
    detail: "unsupported Anthropic response",
    usage,
  } as const;
  if (reason !== "tool_use" && reason !== "end_turn") return unusable;
  const rawBlocks = z.array(z.unknown()).safeParse(message.content);
  if (!rawBlocks.success) return unusable;

  const parts: AssistantPart[] = [];
  for (const rawBlock of rawBlocks.data) {
    const parsed = blockSchema.safeParse(rawBlock);
    if (!parsed.success) return unusable;
    const block = parsed.data;
    switch (block.type) {
      case "thinking":
      case "redacted_thinking":
        parts.push({ kind: "thinking", data: JSON.stringify(rawBlock) });
        break;
      case "text":
        parts.push({ kind: "text", text: block.text });
        break;
      case "tool_use":
        parts.push({
          kind: "tool_call",
          id: block.id,
          name: block.name,
          inputJson: JSON.stringify(block.input),
        });
        break;
    }
  }

  const hasToolCalls = parts.some((part) => part.kind === "tool_call");
  if (hasToolCalls !== (reason === "tool_use")) return unusable;
  return {
    kind: "ok",
    stop: hasToolCalls ? "tool_calls" : "end",
    assistant: receivedTurn(origin, parts, usage),
  };
}

function classifyError(error: unknown, streamRequestId: string | null | undefined): AiResult {
  const apiError = error instanceof Anthropic.APIError ? error : undefined;
  const status: unknown = apiError?.status;
  if (status === 401 || status === 403) {
    return { kind: "failed", reason: "no_provider", detail: "Anthropic credentials rejected" };
  }
  if (
    typeof status === "number" &&
    status >= 300 &&
    status < 500 &&
    ![408, 409, 429].includes(status)
  ) {
    return {
      kind: "failed",
      reason: "rejected",
      detail: `Anthropic request rejected (HTTP ${status})`,
    };
  }

  const requestId = apiError?.requestID ?? streamRequestId;
  const type =
    error instanceof Anthropic.APIConnectionTimeoutError
      ? "timeout"
      : error instanceof Anthropic.APIConnectionError
        ? "connection"
        : error instanceof Anthropic.APIUserAbortError
          ? "aborted"
          : apiError
            ? "api"
            : "stream";
  const http = typeof status === "number" ? ` HTTP ${status}` : "";
  const id =
    requestId && /^req_[a-z0-9_-]{1,100}$/iu.test(requestId) ? ` request-id ${requestId}` : "";
  throw new Error(`Anthropic attempt interrupted (${type}${http}${id})`);
}

export function anthropicAi({ apiKey, model, fetch }: AnthropicSettings): Ai {
  const client = new Anthropic({
    apiKey,
    maxRetries: 0,
    fetch,
    logLevel: "off",
    fetchOptions: { redirect: "manual" },
  });
  const origin = `anthropic/${model}`;
  return {
    model,
    async roundTrip(request) {
      if (request.conversation.rounds.some(({ assistant }) => assistant.origin !== origin)) {
        return {
          kind: "failed",
          reason: "rejected",
          detail: "assistant turn belongs to another provider or model",
        };
      }
      let params: Anthropic.MessageStreamParams;
      try {
        params = buildRequest(model, request);
      } catch {
        return { kind: "failed", reason: "rejected", detail: "invalid Anthropic conversation" };
      }
      const stream = client.messages.stream(params, { signal: AbortSignal.timeout(deadlineMs) });
      try {
        return mapResponse(origin, await stream.finalMessage());
      } catch (error) {
        return classifyError(error, stream.request_id);
      }
    },
  };
}
