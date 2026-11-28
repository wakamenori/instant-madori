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
export function mergeRows(
  rows: ServerRows,
  page: readonly ConversationMessage[],
  nextCursor: string | null = null,
): ServerRows {
  const highest = [...rows.values()].reduce((max, row) => Math.max(max, row.number), 0);
  const hasGap = nextCursor !== null && page.every((row) => row.number > highest);
  const merged = hasGap ? new Map<string, ConversationMessage>() : new Map(rows);
  for (const row of page) merged.set(row.id, row);
  return merged;
}
type PendingDelivery =
  { kind: "sending" } | { kind: "unsent"; message: string } | { kind: "rejected" };
export type OutboxEntry = {
  readonly requestId: string;
  readonly body: InstructionBody;
  readonly seq: number;
  readonly questionId: string | null;
  readonly attachmentIds: readonly string[];
  readonly generation: number;
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
  | {
      kind: "local";
      key: string;
      requestId: string;
      body: string;
      questionId: string | null;
      attachmentIds: readonly string[];
      delivery: LocalDelivery;
    };

type NumberedEntry =
  | { number: number; entry: Extract<TimelineEntry, { kind: "server" }> }
  | { number: number; jobId: string; entry: Extract<TimelineEntry, { kind: "local" }> };

function comparePlacement(left: readonly number[], right: readonly number[]): number {
  for (const [index, number] of left.entries()) {
    const other = right[index];
    if (other === undefined) return 1;
    if (number !== other) return number - other;
  }
  return left.length - right.length;
}

function placeRows(numbered: NumberedEntry[]) {
  const inputs = new Map<string, readonly number[]>();
  const questions = new Map<string, readonly number[]>();
  let latestQuestion: readonly number[] | undefined;
  const placed = numbered
    .sort((a, b) => a.number - b.number)
    .map((item) => {
      const { entry, number } = item;
      let parent: readonly number[] | undefined;
      if ("jobId" in item) {
        if (item.entry.questionId !== null) parent = questions.get(item.entry.questionId);
        inputs.set(item.jobId, [...(parent ?? []), number]);
      } else {
        const message = item.entry.message;
        const { kind, jobId } = message;
        if (kind === "answer") parent = latestQuestion;
        if (kind === "instruction" || kind === "answer") {
          if (jobId !== null) inputs.set(jobId, [...(parent ?? []), number]);
        } else {
          if (jobId !== null) parent = inputs.get(jobId);
          if (kind === "question") {
            latestQuestion = [...(parent ?? []), number];
            questions.set(message.id, latestQuestion);
          }
        }
      }
      return { placement: [...(parent ?? []), number], entry };
    });
  return placed.sort((a, b) => comparePlacement(a.placement, b.placement));
}

export function buildTimeline(
  rows: ServerRows,
  outbox: Outbox,
  state: PatternStateResponse | null,
): readonly TimelineEntry[] {
  function progress(id: string, answer: boolean, fallback: "accepted" | "settled"): Progress {
    if (state?.runningJob?.messageId === id) return { kind: "running" };
    const index = state?.queuedJobs.findIndex((job) => job.messageId === id) ?? -1;
    if (index < 0) return { kind: fallback };
    return state?.queueHold && !answer
      ? { kind: "held" }
      : { kind: "waiting", position: index + 1 };
  }
  const numbered: NumberedEntry[] = [];
  for (const message of rows.values())
    numbered.push({
      number: message.number,
      entry: {
        kind: "server",
        key: `message:${message.id}`,
        message,
        progress:
          message.kind === "instruction" || message.kind === "answer"
            ? progress(message.id, message.kind === "answer", "settled")
            : null,
      },
    });
  const pending: { seq: number; entry: TimelineEntry }[] = [];
  for (const { requestId, body, seq, questionId, attachmentIds, delivery } of outbox) {
    const local = { kind: "local", requestId, body, questionId, attachmentIds } as const;
    if (delivery.kind === "accepted") {
      const { messageId, jobId, number } = delivery.job;
      if (!rows.has(messageId))
        numbered.push({
          number,
          jobId,
          entry: {
            ...local,
            key: `message:${messageId}`,
            delivery: {
              kind: "accepted",
              progress: progress(messageId, questionId !== null, "accepted"),
            },
          },
        });
    } else
      pending.push({
        seq,
        entry: { ...local, key: `request:${requestId}`, delivery },
      });
  }
  return [...placeRows(numbered), ...pending.sort((a, b) => a.seq - b.seq)].map(
    (item) => item.entry,
  );
}
