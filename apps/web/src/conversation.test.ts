import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimeline, checkInstruction, mergeRows, type OutboxEntry } from "./conversation.ts";
import type { ConversationMessage } from "@madori/contracts";
import { statusStates } from "./pattern-status.test-fixtures.ts";

void test("numbered rows share their key with local acceptances; pending deliveries sort last by sequence", () => {
  const checked = checkInstruction("指示");
  assert.ok(checked.ok);
  const local = {
    body: checked.body,
    requestId: "b",
    seq: 2,
    questionId: null,
    attachmentIds: [],
    generation: 0,
    delivery: { kind: "sending" },
  } as const;
  const outbox: OutboxEntry[] = [
    local,
    { ...local, seq: 1, requestId: "a", delivery: { kind: "unsent", message: "未送信" } },
    {
      ...local,
      requestId: "c",
      delivery: { kind: "accepted", job: { messageId: "m2", jobId: "j", number: 2 } },
    },
  ];
  function row(number: number): ConversationMessage {
    return {
      id: "m" + String(number),
      number,
      kind: "instruction",
      jobId: null,
      body: "指示",
      revision: null,
      attachmentIds: [],
      createdAt: "2026-01-01T00:00:00Z",
    };
  }
  const rows = mergeRows(new Map(), [row(3), row(1)]);
  const before = buildTimeline(rows, outbox, null);
  const after = buildTimeline(mergeRows(rows, [row(3), row(2)]), outbox, null);
  const keys = ["message:m1", "message:m2", "message:m3", "request:a", "request:b"];
  assert.deepEqual(
    before.map((e) => e.key),
    keys,
  );
  assert.deepEqual(
    after.map((e) => e.key),
    keys,
  );
  const accepted = before[1];
  assert.ok(
    accepted?.kind === "local" &&
      accepted.delivery.kind === "accepted" &&
      accepted.delivery.progress.kind === "accepted",
  );
  assert.equal(after[1]?.kind, "server");
});
void test("instruction validation preserves the body and explains invalid input", () => {
  assert.deepEqual(checkInstruction("  改築  "), { ok: true, body: "  改築  " });
  assert.deepEqual(checkInstruction("  "), { ok: false, message: null });
  assert.deepEqual(checkInstruction("あ".repeat(5500)), {
    ok: false,
    message: "指示が長すぎます（16384バイトまで）。",
  });
  assert.deepEqual(checkInstruction("\uD800"), {
    ok: false,
    message: "使えない文字が含まれています。",
  });
});

function message<K extends ConversationMessage["kind"]>(kind: K, number: number, jobId: string) {
  return {
    kind,
    id: `m${number}`,
    number,
    jobId,
    body: kind,
    revision: null,
    attachmentIds: [],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function keys(timeline: ReturnType<typeof buildTimeline>) {
  return timeline.map(({ key }) => key);
}

void test("a limit notice stays with its instruction ahead of held inputs", () => {
  const rows = mergeRows(new Map(), [
    message("notice", 3, "root"),
    message("instruction", 2, "waiting-one"),
    message("instruction", 1, "root"),
  ]);
  assert.deepEqual(keys(buildTimeline(rows, [], statusStates["held limited"])), [
    "message:m1",
    "message:m3",
    "message:m2",
  ]);
});

void test("the question, answer and its explanation stay together ahead of held inputs", () => {
  const rows = mergeRows(new Map(), [
    message("explanation", 6, "answer"),
    message("answer", 5, "answer"),
    { ...message("question", 4, "root"), choices: [] },
    message("instruction", 3, "waiting-two"),
    message("instruction", 2, "waiting-one"),
    message("instruction", 1, "root"),
  ]);
  for (const [name, progress] of [
    ["answering queued", { kind: "waiting", position: 1 }],
    ["answering running", { kind: "running" }],
    ["answered completed", { kind: "settled" }],
  ] as const) {
    const timeline = buildTimeline(rows, [], statusStates[name]);
    assert.deepEqual(keys(timeline), [
      "message:m1",
      "message:m4",
      "message:m5",
      "message:m6",
      "message:m2",
      "message:m3",
    ]);
    const answerRow = timeline[2];
    assert.equal(answerRow?.kind, "server");
    assert.deepEqual(answerRow.progress, progress);
  }
});

void test("rows with unloaded parents or null job IDs use their message number", () => {
  const rows = mergeRows(new Map(), [
    { ...message("notice", 8, "unused"), jobId: null },
    message("explanation", 7, "missing"),
    message("answer", 5, "answer"),
    message("instruction", 6, "waiting"),
  ]);
  assert.deepEqual(keys(buildTimeline(rows, [], null)), [
    "message:m5",
    "message:m6",
    "message:m7",
    "message:m8",
  ]);
});

void test("local accepted answers use the exact question ID and can anchor their job output", () => {
  const rows = mergeRows(new Map(), [
    message("instruction", 1, "root"),
    message("instruction", 2, "waiting-one"),
    { ...message("question", 4, "root"), choices: [] },
    { ...message("question", 5, "other"), choices: [] },
    message("explanation", 7, "answer"),
  ]);
  const checked = checkInstruction("必要");
  assert.ok(checked.ok);
  const timeline = buildTimeline(
    rows,
    [
      {
        requestId: "answer-request",
        body: checked.body,
        questionId: "m4",
        attachmentIds: [],
        seq: 0,
        generation: 0,
        delivery: { kind: "accepted", job: { jobId: "answer", messageId: "m6", number: 6 } },
      },
    ],
    statusStates.asking,
  );
  assert.deepEqual(keys(timeline), [
    "message:m1",
    "message:m4",
    "message:m6",
    "message:m7",
    "message:m2",
    "message:m5",
  ]);
  const local = timeline[2];
  assert.ok(local?.kind === "local");
  assert.deepEqual(local.delivery, { kind: "accepted", progress: { kind: "accepted" } });
});
