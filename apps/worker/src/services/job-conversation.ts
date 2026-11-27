import { parseToolCall, type AiToolCall, type FinishInput } from "@madori/contracts/ai-tools";
import { z } from "zod";
import type { AiResponse } from "../ai/round-trip.ts";
import type { Snapshot } from "../storage/snapshots.ts";

export type Working =
  { kind: "empty"; v1Base: boolean } | { kind: "edited" | "base"; snapshot: Snapshot };
export const v1Notice =
  "編集元の案は住宅データを持たない古い形式のため、空の住宅から作り直しました。";
type PlanAnswer = Extract<FinishInput["answer"], { kind: "plan" }>;
export function explanationBody(plan: PlanAnswer) {
  const section = (label: string, items: readonly string[]) =>
    items.length ? "\n\n" + label + "\n" + items.map((item) => "・" + item).join("\n") : "";
  return (
    plan.explanation +
    section("仮置きした条件", plan.assumptions) +
    section("残る懸念", plan.concerns)
  );
}
type Call = {
  id: string;
  call: Exclude<AiToolCall, { name: "finish" }> | { name: "invalid"; error: string };
};
export type RoundPlan =
  | { kind: "stop"; reason: "ai_refused" | "ai_output_limit" }
  | { kind: "nudge" }
  | { kind: "calls"; calls: Call[] }
  | { kind: "ask"; answer: Extract<FinishInput["answer"], { kind: "question" }> }
  | { kind: "finish"; id: string; answer: PlanAnswer };
export function planRound(response: AiResponse, limit: number): RoundPlan {
  if (response.stop === "output_limit" || response.stop === "refusal")
    return {
      kind: "stop",
      reason: response.stop === "output_limit" ? "ai_output_limit" : "ai_refused",
    };
  const calls = response.assistant.parts.filter((p) => p.kind === "tool_call");
  if (!calls.length) return { kind: "nudge" };
  const planned: Call[] = [];
  for (const [i, { id, name, inputJson }] of calls.entries()) {
    const parsed = parseToolCall(name, inputJson);
    let error: string;
    if (i >= limit) error = "Too many calls in this round.";
    else if (!parsed.ok) error = parsed.error;
    else if (parsed.call.name !== "finish") {
      planned.push({ id, call: parsed.call });
      continue;
    } else if (calls.length !== 1) error = "Call finish alone after you have seen every result.";
    else if (parsed.call.input.answer.kind === "question")
      return { kind: "ask", answer: parsed.call.input.answer };
    else return { kind: "finish", id, answer: parsed.call.input.answer };
    planned.push({ id, call: { name: "invalid", error } });
  }
  return { kind: "calls", calls: planned };
}

const record = z.record(z.string(), z.unknown());
export function elements(text: string, ids: string[]) {
  const { house } = z.object({ house: z.record(z.string(), z.unknown()) }).parse(JSON.parse(text));
  const wanted = new Set(ids);
  const unknown = new Set(ids);
  const rooms = z.array(record).parse(house.rooms);
  const openings = z.array(record).parse(house.openings);
  const found = [];
  for (const [collection, items] of Object.entries(house)) {
    if (!Array.isArray(items)) continue;
    for (const value of z.array(record).parse(items)) {
      if (typeof value.id !== "string" || !wanted.has(value.id)) continue;
      unknown.delete(value.id);
      const refs =
        collection === "boundaries"
          ? {
              rooms: rooms.filter((room) =>
                z
                  .array(z.object({ boundary: z.string() }))
                  .parse(room.edges)
                  .some((edge) => edge.boundary === value.id),
              ),
              openings: openings.filter((o) => o.wall === value.id),
            }
          : {};
      found.push({ collection, value, ...refs });
    }
  }
  return { elements: found, unknown: [...unknown] };
}

export function toolText(value: unknown, limit: number): string {
  const json = JSON.stringify(value);
  if (new TextEncoder().encode(json).byteLength <= limit) return json;
  let keep = 32;
  for (;;) {
    const shortened = JSON.stringify(value, (_key: string, v: unknown): unknown =>
      Array.isArray(v) && v.length > keep
        ? [...(v as unknown[]).slice(0, keep), { omitted: v.length - keep }]
        : v,
    );
    if (new TextEncoder().encode(shortened).byteLength <= limit) return shortened;
    if (keep === 0) return JSON.stringify({ error: "Tool result exceeds the size limit" });
    keep = Math.floor(keep / 2);
  }
}
