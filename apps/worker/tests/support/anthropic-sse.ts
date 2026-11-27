export const recordedUsage = {
  input_tokens: 1_200,
  cache_read_input_tokens: 3_003,
  cache_creation_input_tokens: 3_000,
  cache_creation: {
    ephemeral_5m_input_tokens: 2_000,
    ephemeral_1h_input_tokens: 1_000,
  },
};

export function event(type: string, data: object = {}) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export function recordedStream({
  stopReason = "end_turn",
  blocks = [],
  usage = recordedUsage,
  after = event("message_stop"),
}: {
  stopReason?: string | null;
  blocks?: string[];
  usage?: Omit<typeof recordedUsage, "cache_creation"> & {
    cache_creation?: typeof recordedUsage.cache_creation;
  };
  after?: string;
} = {}) {
  return (
    event("message_start", {
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...usage, output_tokens: 1 },
      },
    }) +
    blocks.join("") +
    (stopReason === null
      ? ""
      : event("message_delta", {
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: 3_500 },
        })) +
    after
  );
}

export function contentBlock(index: number, contentBlock: object, deltas: object[] = []) {
  return (
    event("content_block_start", { index, content_block: contentBlock }) +
    deltas.map((delta) => event("content_block_delta", { index, delta })).join("") +
    event("content_block_stop", { index })
  );
}

export function sse(body: string) {
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "request-id": "req_recorded" },
  });
}
