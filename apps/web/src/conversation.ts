import {
  instructionBodySchema,
  type AcceptedJob,
  type ConversationMessage,
  type PatternStateResponse,
} from "@madori/contracts";

declare const instructionBrand: unique symbol;
export type InstructionBody = string & { readonly [instructionBrand]: true };
export type InstructionCheck =
  { ok: true; body: InstructionBody } | { ok: false; message: string | null };
export function checkInstruction(text: string): InstructionCheck {
  const result = instructionBodySchema.safeParse(text);
  if (result.success) return { ok: true, body: result.data as InstructionBody };
  const message = !text.trim()
    ? null
    : new TextEncoder().encode(text).length > 16384
      ? "指示が長すぎます（16384バイトまで）。"
      : "使えない文字が含まれています。";
  return { ok: false, message };
}
export type ServerRows = ReadonlyMap<string, ConversationMessage>;
export function mergeRows(rows: ServerRows, page: readonly ConversationMessage[]): ServerRows {
  const merged = new Map(rows);
  for (const row of page) merged.set(row.id, row);
  return merged;
}
type PendingDelivery = { kind: "sending" } | { kind: "unsent"; message: string };
export type OutboxEntry = {
  readonly requestId: string;
  readonly body: InstructionBody;
  readonly seq: number;
  readonly delivery: PendingDelivery | { kind: "accepted"; job: AcceptedJob };
};
export type Outbox = readonly OutboxEntry[];
export type Progress =
  | { kind: "running" }
  | { kind: "waiting"; position: number }
  | { kind: "held" }
  | { kind: "accepted" }
  | { kind: "settled" };
export type LocalDelivery = PendingDelivery | { kind: "accepted"; progress: Progress };
export type TimelineEntry =
  | { kind: "server"; key: string; message: ConversationMessage; progress: Progress | null }
  | { kind: "local"; key: string; requestId: string; body: string; delivery: LocalDelivery };

export function buildTimeline(
  rows: ServerRows,
  outbox: Outbox,
  state: PatternStateResponse | null,
): readonly TimelineEntry[] {
  function progress(id: string, fallback: "accepted" | "settled"): Progress {
    if (state?.runningJob?.messageId === id) return { kind: "running" };
    const index = state?.queuedJobs.findIndex((job) => job.messageId === id) ?? -1;
    if (index < 0) return { kind: fallback };
    return state?.queueHold ? { kind: "held" } : { kind: "waiting", position: index + 1 };
  }
  const numbered: { number: number; entry: TimelineEntry }[] = [];
  for (const message of rows.values())
    numbered.push({
      number: message.number,
      entry: {
        kind: "server",
        key: `message:${message.id}`,
        message,
        progress: message.kind === "instruction" ? progress(message.id, "settled") : null,
      },
    });
  const pending: { seq: number; entry: TimelineEntry }[] = [];
  for (const { requestId, body, seq, delivery } of outbox) {
    if (delivery.kind === "accepted") {
      const { messageId, number } = delivery.job;
      if (!rows.has(messageId))
        numbered.push({
          number,
          entry: {
            kind: "local",
            key: `message:${messageId}`,
            requestId,
            body,
            delivery: { kind: "accepted", progress: progress(messageId, "accepted") },
          },
        });
    } else
      pending.push({
        seq,
        entry: { kind: "local", key: `request:${requestId}`, requestId, body, delivery },
      });
  }
  return [
    ...numbered.sort((a, b) => a.number - b.number),
    ...pending.sort((a, b) => a.seq - b.seq),
  ].map((item) => item.entry);
}
