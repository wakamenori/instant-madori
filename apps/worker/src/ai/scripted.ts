import { receivedTurn } from "./round-trip.ts";
import type {
  Ai,
  AiResponse,
  AiResult,
  AssistantPart,
  AssistantTurn,
  Conversation,
  Reply,
  StopReason,
  Usage,
} from "./round-trip.ts";

export interface ScriptStep {
  readonly stop: StopReason;
  readonly parts: readonly AssistantPart[];
  readonly usage?: Usage;
}

const zeroUsage: Usage = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
};

function isObjectJson(text: string): boolean {
  try {
    const input: unknown = JSON.parse(text);
    return typeof input === "object" && input !== null && !Array.isArray(input);
  } catch {
    return false;
  }
}

function samePart(actual: AssistantPart, expected: AssistantPart): boolean {
  switch (expected.kind) {
    case "text":
      return actual.kind === "text" && actual.text === expected.text;
    case "thinking":
      return actual.kind === "thinking" && actual.data === expected.data;
    case "tool_call":
      return (
        actual.kind === "tool_call" &&
        actual.id === expected.id &&
        actual.name === expected.name &&
        actual.inputJson === expected.inputJson
      );
  }
}

function sameTurn(actual: AssistantTurn, expected: AssistantTurn): boolean {
  return (
    actual.origin === expected.origin &&
    actual.parts.length === expected.parts.length &&
    expected.parts.every((part, index) => {
      const echo = actual.parts[index];
      return echo !== undefined && samePart(echo, part);
    })
  );
}

function matchesCalls(turn: AssistantTurn, reply: Reply): boolean {
  const calls = turn.parts.filter((part) => part.kind === "tool_call");
  if (calls.length === 0) return reply.kind === "message" && reply.parts.length > 0;
  if (reply.kind !== "tool_results" || reply.results.length !== calls.length) return false;
  const pending = new Set(calls.map((call) => call.id));
  return reply.results.every((result) => pending.delete(result.callId)) && pending.size === 0;
}

type Script = (conversation: Conversation) => ScriptStep;
type Next = (conversation: Conversation) => AiResponse | undefined;

function answer(next: Next, conversation: Conversation): AiResult {
  if (conversation.opening.length === 0) {
    return { kind: "failed", reason: "rejected", detail: "empty opening message" };
  }
  for (const [index, round] of conversation.rounds.entries()) {
    const step = next({ ...conversation, rounds: conversation.rounds.slice(0, index) });
    if (!step || !sameTurn(round.assistant, step.assistant)) {
      return {
        kind: "failed",
        reason: "rejected",
        detail: `round ${index} differs from the script`,
      };
    }
    if (!matchesCalls(step.assistant, round.reply)) {
      return { kind: "failed", reason: "rejected", detail: `round ${index} has an invalid reply` };
    }
  }
  return (
    next(conversation) ?? {
      kind: "failed",
      reason: "script_ended",
      detail: "the script has ended",
    }
  );
}

function response(step: ScriptStep, index: number, ids: Set<string>): AiResponse {
  if (step.parts.length === 0) throw new Error(`step ${index} has no parts`);
  const calls = step.parts.filter((part) => part.kind === "tool_call");
  if ((step.stop === "tool_calls") !== calls.length > 0) {
    throw new Error(`step ${index} has a stop reason inconsistent with its tool calls`);
  }
  for (const call of calls) {
    if (ids.has(call.id)) throw new Error(`step ${index} repeats a tool call id`);
    if (!isObjectJson(call.inputJson)) throw new Error(`step ${index} has invalid tool input`);
    ids.add(call.id);
  }
  return Object.freeze({
    kind: "ok",
    assistant: receivedTurn("scripted", step.parts, step.usage ?? zeroUsage),
    stop: step.stop,
  });
}

export function scriptedAi(script: readonly ScriptStep[] | Script): Ai {
  const ids = new Set<string>();
  const fixed =
    typeof script === "function" ? null : script.map((step, i) => response(step, i, ids));
  return {
    model: "scripted",
    roundTrip: ({ conversation }) => {
      const seen = new Set<string>();
      try {
        return Promise.resolve(
          answer(
            (view) =>
              typeof script === "function"
                ? response(script(view), view.rounds.length, seen)
                : fixed?.[view.rounds.length],
            conversation,
          ),
        );
      } catch (error) {
        return Promise.resolve({
          kind: "failed",
          reason: "rejected",
          detail: error instanceof Error ? error.message : "script expectation failed",
        });
      }
    },
  };
}
